-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0) — MIGRATION 12
-- OCR Payslip Import — duplicate detection (Step O9-pre / blocker #1)
--
-- Closes blocker #1 of OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md (§ 4.1 / § 11) for
-- the manual-entry MVP — BEFORE any real OCR/PDF extraction lands. The architecture
-- frames blocker #1 around a file `file_hash` (relevant only to file upload, O9),
-- but the manual-entry MVP has no file. Duplicate detection here is therefore
-- CONTENT-based: a per-line content fingerprint + an import-level content
-- fingerprint derived from it (PAYSLIP_DUPLICATE_DETECTION_v1.0.md § 2).
--
-- Blocker #1 has TWO halves and this migration serves both:
--   (a) detect that a NEW import looks like an existing one — advisory, surfaced in
--       the review UI (handled by the JS detection service over these columns); and
--   (b) the load-bearing half — "prevent re-confirming already-confirmed lines into
--       duplicate records, not merely mark the older upload superseded" (§ 4.1).
--       create_payment_record has NO dedup (08:158-188) and the per-line idempotency
--       guard does not span imports, so a re-typed payslip would mint a SECOND
--       payment_record. The confirm bridge gains a fingerprint guard (below) that
--       refuses the second confirm unless the operator EXPLICITLY overrides
--       (operator decision stays final — principle § 2.4 / governance "manual
--       override always available").
--
-- ADDITIVE ONLY — new columns / trigger / index, plus a CREATE-OR-REPLACE-style
-- swap of the migration-11 bridge (DROP + CREATE because the signature gains a
-- parameter; the body is migration 11 verbatim plus the guard). Idempotent. Safe to
-- replay. DEV only — PROD untouched.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── 1. Fingerprint columns (§ 2) ─────────────────────────────────────────────
-- content_fingerprint:
--   · on a LINE  — md5 of its canonical content (reference, description, amount,
--                  RESOLVED date) — set by the trigger below; the authoritative
--                  signal the confirm guard and the near-match Jaccard both read.
--   · on an IMPORT — a deterministic hash of (source, pay period, pay date, sorted
--                  line fingerprints), written by the JS detection service. Indexed
--                  per owner for O(1) exact-duplicate lookup.
-- duplicate_check: the detection metadata blob (verdict + matched imports + scores +
--                  checked_at) the review UI renders. Disposable workspace data
--                  (§ 3.3) — recomputable at any time from the fingerprints.

alter table fat.payslip_imports
  add column if not exists content_fingerprint text,
  add column if not exists duplicate_check      jsonb;

alter table fat.payslip_import_lines
  add column if not exists content_fingerprint text;

comment on column fat.payslip_imports.content_fingerprint is
  'Import-level content hash = f(source, pay_period_ref, pay_date, sorted line fingerprints). '
  'Written by the JS detection service; equality = exact-duplicate import. '
  '(PAYSLIP_DUPLICATE_DETECTION_v1.0.md § 2.2)';
comment on column fat.payslip_imports.duplicate_check is
  'Detection metadata: { checked_at, fingerprint, verdict, exact[], near[] }. '
  'Disposable — recomputable from fingerprints (§ 3.3).';
comment on column fat.payslip_import_lines.content_fingerprint is
  'md5 of canonical line content (reference, description, amount, resolved date). '
  'Trigger-maintained; the authoritative duplicate signal (§ 2.1).';


-- ─── 2. Canonical line-content fingerprint (SQL — single source of truth) ─────
-- Deterministic md5 over a unit-separator-joined canonical projection. Computed in
-- SQL (not JS) so the confirm bridge guard and the stored column NEVER disagree —
-- the JS layer only ever READS this value, it never recomputes line content. The
-- RESOLVED date (coalesce(line.parsed_date, import.pay_date)) is folded in because
-- the payment_record the bridge mints uses exactly that date (11:129) — two lines
-- that would produce the same-dated record must share a fingerprint. Amount is
-- normalized to 2dp fixed text so 50 / 50.0 / 50.00 collapse; null amount (hours-
-- first line) and null date use a sentinel so they don't collide with empty text.

create or replace function fat.payslip_line_content_fp(
  p_reference   text,
  p_description text,
  p_amount      numeric,
  p_date        date
) returns text
language sql
immutable
set search_path = fat, pg_temp
as $$
  select md5(
    lower(coalesce(btrim(p_reference),   '')) || chr(31) ||
    lower(coalesce(btrim(p_description), '')) || chr(31) ||
    coalesce(to_char(round(p_amount, 2), 'FM999999990.00'), '~') || chr(31) ||
    coalesce(p_date::text, '~')
  )
$$;

-- Trigger: stamp the line fingerprint on insert / content-changing update. Resolves
-- the date against the parent import's pay_date (the line may inherit it, § 3.2).
create or replace function fat.payslip_line_fp_trigger()
returns trigger
language plpgsql
set search_path = fat, pg_temp
as $$
declare
  v_pay_date date;
begin
  select pay_date into v_pay_date from fat.payslip_imports where id = NEW.import_id;
  NEW.content_fingerprint := fat.payslip_line_content_fp(
    NEW.parsed_reference,
    NEW.parsed_description,
    NEW.parsed_amount,
    coalesce(NEW.parsed_date, v_pay_date)
  );
  return NEW;
end;
$$;

drop trigger if exists set_content_fingerprint on fat.payslip_import_lines;
create trigger set_content_fingerprint
  before insert or update of parsed_reference, parsed_description, parsed_amount, parsed_date
  on fat.payslip_import_lines
  for each row execute function fat.payslip_line_fp_trigger();


-- ─── 3. Backfill existing lines (idempotent) ──────────────────────────────────
-- Any pre-migration lines get fingerprinted so the confirm guard sees them too.
update fat.payslip_import_lines l
   set content_fingerprint = fat.payslip_line_content_fp(
         l.parsed_reference, l.parsed_description, l.parsed_amount,
         coalesce(l.parsed_date, i.pay_date))
  from fat.payslip_imports i
 where i.id = l.import_id
   and l.content_fingerprint is null;


-- ─── 4. Indexes ───────────────────────────────────────────────────────────────
-- Exact-duplicate import lookup is an owner+fingerprint equality probe.
create index if not exists ix_payslip_imports_owner_fingerprint
  on fat.payslip_imports (owner_id, content_fingerprint)
  where content_fingerprint is not null;
-- The confirm guard probes confirmed lines by owner + fingerprint.
create index if not exists ix_payslip_import_lines_owner_fp
  on fat.payslip_import_lines (owner_id, content_fingerprint)
  where content_fingerprint is not null;


-- ─── 5. Confirm bridge — add the double-confirmation guard (§ 4 / blocker #1b) ─
-- The migration-11 body VERBATIM, with ONE new pre-create guard and ONE new
-- parameter (p_allow_duplicate). The signature gains a parameter, so this is a
-- DROP + CREATE (CREATE OR REPLACE cannot change the argument list). Everything
-- else — owner coherence, idempotency, source mapping, link pre-branch, record
-- creation, link, line stamp, import-status recompute — is unchanged.

drop function if exists fat.confirm_payslip_import_line(uuid, uuid, uuid, text, numeric, numeric);

create or replace function fat.confirm_payslip_import_line(
  p_line_id          uuid,
  p_actor_id         uuid,
  p_entitlement_id   uuid    default null,   -- operator's final choice (may differ from candidate)
  p_link_kind        text    default null,   -- 'auto_match' | 'manual' | null (record only)
  p_allocated_amount numeric default null,   -- defaults to parsed_amount when linking
  p_tolerance        numeric default 0.01,
  p_allow_duplicate  boolean default false   -- operator override of the dup guard (§ 4)
) returns jsonb
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  -- staging line
  v_line_owner    uuid;
  v_line_status   text;
  v_import_id     uuid;
  v_parsed_amount numeric;
  v_parsed_date   date;
  v_parsed_ref    text;
  v_parsed_desc   text;
  v_raw_text      text;
  v_match_break   jsonb;
  v_existing_rec  uuid;
  v_existing_link uuid;
  v_line_fp       text;
  -- duplicate guard
  v_dup_line      uuid;
  v_dup_rec       uuid;
  v_dup_import    uuid;
  -- import
  v_import_source text;
  v_import_paydate date;
  v_rec_source    text;
  -- record date
  v_record_date   date;
  v_gross         numeric;
  -- chosen entitlement
  v_ent_method    text;
  v_do_link       boolean := false;
  v_alloc         numeric;
  -- outputs
  v_record        fat.payment_records;
  v_link_result   jsonb;
  v_link_id       uuid;
  v_open_remaining integer;
  v_import_status text;
begin
  -- ── Step 0: owner coherence (§ 6.1 step 0 — load-bearing) ───────────────────
  select l.owner_id, l.status, l.import_id, l.parsed_amount, l.parsed_date,
         l.parsed_reference, l.parsed_description, l.raw_text, l.match_breakdown,
         l.payment_record_id, l.link_id, l.content_fingerprint
    into v_line_owner, v_line_status, v_import_id, v_parsed_amount, v_parsed_date,
         v_parsed_ref, v_parsed_desc, v_raw_text, v_match_break,
         v_existing_rec, v_existing_link, v_line_fp
    from fat.payslip_import_lines l
   where l.id = p_line_id;
  if not found then
    raise exception 'confirm_payslip_import_line: line % not found', p_line_id using errcode = 'no_data_found';
  end if;
  if v_line_owner is distinct from p_actor_id then
    raise exception 'confirm_payslip_import_line: actor % is not the line owner %', p_actor_id, v_line_owner;
  end if;

  -- ── Step 1: idempotency / terminal guard (§ 6.1 step 1, § 6.3) ──────────────
  if v_line_status = 'confirmed' and v_existing_rec is not null then
    select e.status into v_import_status from fat.payslip_imports e where e.id = v_import_id;
    return jsonb_build_object(
      'line_id',           p_line_id,
      'idempotent',        true,
      'payment_record_id', v_existing_rec,
      'link_id',           v_existing_link,
      'line_status',       'confirmed',
      'import_status',     v_import_status
    );
  end if;
  if v_line_status not in ('parsed','needs_review') then
    raise exception 'confirm_payslip_import_line: line % is %, only parsed/needs_review are confirmable', p_line_id, v_line_status using errcode = 'check_violation';
  end if;

  -- ── Step 1.5: DOUBLE-CONFIRMATION GUARD (blocker #1b, § 4) ───────────────────
  -- Refuse to mint a SECOND payment_record for content that an already-confirmed
  -- line (a different line — re-typed/re-uploaded payslip) already settled. The
  -- match is on the SQL content fingerprint (owner-scoped), so it spans imports,
  -- which the per-line idempotency guard (step 1) deliberately does not. The
  -- operator can override explicitly (p_allow_duplicate) — detection warns, the
  -- operator decides (governance: manual override always available). NOTE: a
  -- record-only confirm that was later RETRACTED clears payment_record_id (line is
  -- on delete set null, § 6.5) so a re-confirm of corrected content is NOT blocked.
  if v_line_fp is not null then
    select l2.id, l2.payment_record_id, l2.import_id
      into v_dup_line, v_dup_rec, v_dup_import
      from fat.payslip_import_lines l2
     where l2.owner_id = v_line_owner
       and l2.id <> p_line_id
       and l2.status = 'confirmed'
       and l2.payment_record_id is not null
       and l2.content_fingerprint = v_line_fp
     order by l2.confirmed_at asc nulls last
     limit 1;
    if found and not p_allow_duplicate then
      raise exception
        'confirm_payslip_import_line: line % duplicates already-confirmed line % (payment record %) — set p_allow_duplicate to override',
        p_line_id, v_dup_line, v_dup_rec
        using errcode = 'unique_violation',
              detail = json_build_object(
                'reason',              'duplicate_confirmed_line',
                'duplicate_line_id',   v_dup_line,
                'duplicate_record_id', v_dup_rec,
                'duplicate_import_id', v_dup_import,
                'fingerprint',         v_line_fp
              )::text;
    end if;
  end if;

  -- ── Source mapping + record date (§ 6.2) ────────────────────────────────────
  select e.source, e.pay_date into v_import_source, v_import_paydate
    from fat.payslip_imports e where e.id = v_import_id;
  v_rec_source := case v_import_source
                    when 'manual_entry'       then 'manual'
                    when 'payslip_screenshot' then 'payslip_screenshot'
                    when 'payslip_pdf'        then 'payslip_pdf'
                    else 'manual'
                  end;

  v_record_date := coalesce(v_parsed_date, v_import_paydate);
  if v_record_date is null then
    raise exception 'confirm_payslip_import_line: line % has no parsed_date and import has no pay_date', p_line_id using errcode = 'not_null_violation';
  end if;
  v_gross := coalesce(v_parsed_amount, 0);

  -- ── Step 3 (decided BEFORE the link call): link-eligibility pre-branch ───────
  if p_entitlement_id is not null and p_link_kind is not null then
    if p_link_kind not in ('auto_match','manual') then
      raise exception 'confirm_payslip_import_line: invalid link_kind % (auto_match|manual|null)', p_link_kind using errcode = 'check_violation';
    end if;
    select ce.payment_method into v_ent_method
      from fat.claim_entitlements ce where ce.id = p_entitlement_id;
    if not found then
      raise exception 'confirm_payslip_import_line: entitlement % not found', p_entitlement_id using errcode = 'no_data_found';
    end if;
    if v_ent_method = 'payslip' then
      v_do_link := true;
    elsif v_ent_method is null then
      v_do_link := false;
    else
      raise exception 'confirm_payslip_import_line: entitlement % is routed to % — a payslip line cannot settle it', p_entitlement_id, v_ent_method using errcode = 'check_violation';
    end if;
  end if;

  -- ── Step 2: create the payment record (existing RPC, § 6.1 step 2) ──────────
  v_record := fat.create_payment_record(
    v_line_owner,
    'payslip',
    v_record_date,
    v_gross,
    v_rec_source,
    v_parsed_ref,
    jsonb_build_object(
      'import_id',          v_import_id,
      'line_id',            p_line_id,
      'raw_text',           v_raw_text,
      'parsed_reference',   v_parsed_ref,
      'parsed_description', v_parsed_desc,
      'parsed_amount',      v_parsed_amount,
      'parsed_date',        v_parsed_date,
      'match_breakdown',    v_match_break,
      'content_fingerprint', v_line_fp,
      'source',             v_import_source
    )
  );

  -- ── Step 3 (execute): link IFF the pre-branch said so (existing RPC) ────────
  if v_do_link then
    v_alloc := coalesce(p_allocated_amount, v_parsed_amount, 0);
    v_link_result := fat.link_entitlement_payment(
      p_entitlement_id,
      v_record.id,
      v_alloc,
      p_link_kind,
      p_actor_id,
      null,
      false,
      p_tolerance
    );
    v_link_id := (v_link_result ->> 'link_id')::uuid;
  end if;

  -- ── Step 4: stamp the line (§ 6.1 step 4) ───────────────────────────────────
  update fat.payslip_import_lines
     set status            = 'confirmed',
         payment_record_id = v_record.id,
         link_id           = v_link_id,
         confirmed_at      = now()
   where id = p_line_id;

  -- ── Step 5: recompute import status (§ 6.1 step 5 / § 4.1) ───────────────────
  select count(*) into v_open_remaining
    from fat.payslip_import_lines l
   where l.import_id = v_import_id
     and l.status in ('parsed','needs_review','failed');

  if v_open_remaining = 0 then
    update fat.payslip_imports
       set status = 'confirmed', confirmed_at = now()
     where id = v_import_id
    returning status into v_import_status;
  else
    update fat.payslip_imports
       set status = 'needs_review'
     where id = v_import_id
       and status not in ('confirmed','needs_review')
    returning status into v_import_status;
    if v_import_status is null then
      select status into v_import_status from fat.payslip_imports where id = v_import_id;
    end if;
  end if;

  return jsonb_build_object(
    'line_id',           p_line_id,
    'idempotent',        false,
    'payment_record_id', v_record.id,
    'link_id',           v_link_id,
    'linked',            v_do_link,
    'link_result',       v_link_result,
    'line_status',       'confirmed',
    'import_status',     v_import_status,
    'open_lines_remaining', v_open_remaining,
    'duplicate_overridden', (p_allow_duplicate and v_dup_line is not null)
  );
end;
$$;


-- ─── Grants (mirror migration 08/09/11: no public/anon) ───────────────────────

revoke all on function fat.confirm_payslip_import_line(uuid, uuid, uuid, text, numeric, numeric, boolean) from public, anon;
grant execute on function fat.confirm_payslip_import_line(uuid, uuid, uuid, text, numeric, numeric, boolean) to authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- END migration 12
-- ═══════════════════════════════════════════════════════════════════════════════
