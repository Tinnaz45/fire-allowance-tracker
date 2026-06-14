-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0) — MIGRATION 10
-- OCR Payslip Import — staging schema (Step O1)
--
-- The two staging tables the OCR Payslip Import architecture mandates
-- (OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 3): the "raw payslip → parsed lines
-- → match candidates → confirmed matches" workspace that sits ABOVE the finished
-- reconciliation consumer. This is a pure PRODUCER staging layer — it never
-- writes claim_entitlements / entitlement_payment_links / reconciliation_audit
-- directly (principle § 2.1). The confirm bridge (migration 11) is the only seam
-- where a staging line becomes a canonical payment_records row, and it does so by
-- CALLING the migration-08 RPCs verbatim.
--
-- Resolves blocker #6 (payslip_imports staging table) of
-- RECONCILIATION_STATE_ARCHITECTURE_v1.0.md § 11 / § 4.5 (reserved).
--
-- Lifecycle vocabulary is CANONICAL and single-source (§ 4.1 / § 4.2):
--   import status : uploaded | parsing | parsed | needs_review |
--                   confirmed | rejected | superseded | failed
--   line   status : parsed | needs_review | confirmed | rejected |
--                   superseded | failed
-- The JS mirror is lib/fat/models/payslipImport.js → IMPORT_STATUS_VALUES /
-- IMPORT_LINE_STATUS_VALUES; the two MUST stay in lockstep. No synonyms
-- (no 'draft', no 'reviewing') — temporary UI states map onto these, never
-- persist a parallel vocabulary.
--
-- ADDITIVE ONLY — no change to any existing table. Idempotent (CREATE TABLE IF
-- NOT EXISTS, guarded DO blocks for policies — Postgres has no CREATE POLICY
-- IF NOT EXISTS). Safe to replay. DEV only.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── 1. fat.payslip_imports — the upload / batch entity (§ 3.1) ───────────────
-- One row per import batch. `source` carries the import-level provenance
-- ('manual_entry' for the MVP adapter); the record-level payment_records.source
-- is derived from it at confirm time (§ 6.2). The file bytes are NOT stored here
-- (file_ref points at Storage, blocker #2) — irrelevant to manual entry.

create table if not exists fat.payslip_imports (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references fat.profiles(id) on delete cascade,
  source         text not null check (source in ('manual_entry','payslip_screenshot','payslip_pdf')),
  status         text not null default 'uploaded'
                   check (status in ('uploaded','parsing','parsed','needs_review',
                                     'confirmed','rejected','superseded','failed')),
  file_ref       text,                      -- Supabase Storage object path; NOT the bytes (blocker #2)
  file_hash      text,                      -- sha256 of the upload — duplicate detection (blocker #1)
  pay_date       date,                      -- payslip pay date (parsed or operator-entered)
  pay_period_ref text,                      -- payroll period identifier, if present
  parser_name    text,                      -- which adapter produced the parse
  parser_version text,
  line_count     integer not null default 0,
  raw_extract    jsonb,                     -- full pre-split parse payload (audit + re-parse)
  error          text,                      -- populated when status = 'failed'
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  confirmed_at   timestamptz
);

create index if not exists ix_payslip_imports_owner_status
  on fat.payslip_imports (owner_id, status);
create index if not exists ix_payslip_imports_owner_created
  on fat.payslip_imports (owner_id, created_at desc);

comment on table fat.payslip_imports is
  'OCR Payslip Import staging — one upload / batch (OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 3.1). '
  'Disposable workspace: deleting an import NEVER deletes a confirmed payment_records row — '
  'the confirm bridge already copied the line into the canonical record (principle § 2.2). '
  'status vocabulary is canonical (§ 4.1); no synonyms.';


-- ─── 2. fat.payslip_import_lines — parsed lines + match candidates (§ 3.2) ────
-- owner_id is denormalized off the parent import for direct owner-scoped RLS.
-- payment_record_id / link_id are the bridge OUTPUTS — null until confirm; set to
-- whatever create_payment_record / link_entitlement_payment produced. Both are
-- `on delete set null` so a retraction (hard-delete of the payment record, § 4.3 /
-- § 6.5) reverts cleanly to the staging line without destroying what was parsed.

create table if not exists fat.payslip_import_lines (
  id                       uuid primary key default gen_random_uuid(),
  import_id                uuid not null references fat.payslip_imports(id) on delete cascade,
  owner_id                 uuid not null references fat.profiles(id) on delete cascade,  -- denormalized for RLS
  line_index               integer not null,          -- order within the payslip
  raw_text                 text,                       -- source text the parser saw for this line
  parsed_reference         text,                       -- payslip line code
  parsed_description        text,                      -- line description / narrative
  parsed_amount            numeric(12,2),              -- gross dollar amount on the line
  parsed_date              date,                       -- line date if line-level (else inherit import.pay_date)
  candidate_entitlement_id uuid references fat.claim_entitlements(id) on delete set null,
  match_confidence         numeric(5,4),               -- 0.0000 – 1.0000 (§ 5; matcher is post-MVP)
  match_breakdown          jsonb,                      -- per-signal scores (§ 5.2)
  status                   text not null default 'parsed'
                             check (status in ('parsed','needs_review','confirmed',
                                               'rejected','superseded','failed')),
  payment_record_id        uuid references fat.payment_records(id) on delete set null,  -- bridge output (§ 6)
  link_id                  uuid references fat.entitlement_payment_links(id) on delete set null,
  resolution_note          text,
  error                    text,                       -- populated when status = 'failed'
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  confirmed_at             timestamptz
);

create index if not exists ix_payslip_import_lines_import on fat.payslip_import_lines (import_id);
create index if not exists ix_payslip_import_lines_owner_status on fat.payslip_import_lines (owner_id, status);
create index if not exists ix_payslip_import_lines_candidate
  on fat.payslip_import_lines (candidate_entitlement_id)
  where candidate_entitlement_id is not null;

comment on table fat.payslip_import_lines is
  'OCR Payslip Import staging — parsed lines + match candidates '
  '(OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 3.2). candidate_entitlement_id is a '
  'SUGGESTION, never a commitment. payment_record_id / link_id are the confirm-bridge '
  'outputs (on delete set null so a retraction reverts the line). status vocabulary is '
  'canonical (§ 4.2); no synonyms.';


-- ─── 3. updated_at triggers (mirror canonical tables, 01 § 9) ─────────────────

drop trigger if exists set_updated_at on fat.payslip_imports;
create trigger set_updated_at before update on fat.payslip_imports
  for each row execute function fat.set_updated_at();

drop trigger if exists set_updated_at on fat.payslip_import_lines;
create trigger set_updated_at before update on fat.payslip_import_lines
  for each row execute function fat.set_updated_at();


-- ─── 4. Row-Level Security (owner-only, mirrors 01 § 10) ──────────────────────
-- users_manage_own keyed on owner_id for both tables (§ 3.4). The future
-- service_role batch-parse worker (§ 7, Phase 3) inserts on the user's behalf via
-- the service-role bypass. Guarded DO blocks keep this replay-safe.

alter table fat.payslip_imports      enable row level security;
alter table fat.payslip_import_lines enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='payslip_imports'
                    and policyname='users_manage_own') then
    create policy users_manage_own on fat.payslip_imports for all
      using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
  end if;

  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='payslip_import_lines'
                    and policyname='users_manage_own') then
    create policy users_manage_own on fat.payslip_import_lines for all
      using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
  end if;
end$$;


-- ─── 5. Grants (mirror 01 § 11) ──────────────────────────────────────────────

grant select, insert, update, delete on fat.payslip_imports      to authenticated, service_role;
grant select, insert, update, delete on fat.payslip_import_lines to authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- END migration 10
-- ═══════════════════════════════════════════════════════════════════════════════
