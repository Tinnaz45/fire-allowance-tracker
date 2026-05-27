-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0)
--
-- Phase 1 of the canonical rebuild. Creates the new canonical tables in the
-- `fat.*` bounded domain ALONGSIDE the existing prototype tables. No drops,
-- no data migration. Existing app continues to read/write prototype tables
-- until Phase 3 service migration cuts over.
--
-- Canonical source of shape: governance-system/chatgpt-project-sources/
--   fire-allowance-tracker/DATABASE_ARCHITECTURE_v1.0.md
--
-- Companion docs (rule semantics — NOT duplicated here):
--   ALLOWANCE_ARCHITECTURE_v1.0.md
--   ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md
--   CLAIM_TYPES_v1.0.md
--   ENTITLEMENT_RULES_v1.0.md
--   PAYMENT_RECONCILIATION_v1.0.md
--
-- Rebuild plan: docs/REBUILD_PLAN_v1.0.md
--
-- Idempotent: every CREATE uses IF NOT EXISTS / OR REPLACE; RLS policies are
-- created inside guarded DO blocks (Postgres has no CREATE POLICY IF NOT
-- EXISTS). Safe to replay against an already-stamped project.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── 0. Preconditions ────────────────────────────────────────────────────────
-- The `fat` schema, set_updated_at(), and grants are already established by
-- supabase/fat-schema.sql. This file assumes that base is in place.


-- ─── 1. profiles (extend in place — keep auth trigger intact) ────────────────
-- Existing fat.profiles has (id, email, first_name, last_name, created_at,
-- updated_at). Canonical model adds display_name + rostered station + home
-- location. These are additive; the on_auth_user_created_fat trigger remains
-- the source of new rows.

alter table fat.profiles
  add column if not exists display_name         text,
  add column if not exists rostered_station_id  integer references fat.stations(id) on delete set null,
  add column if not exists home_location_label  text,
  add column if not exists home_lat             numeric(9,6),
  add column if not exists home_lng             numeric(9,6);

comment on column fat.profiles.rostered_station_id is
  'Canonical rostered station. Affects future claims only. Historical claims '
  'snapshot their own station_id_snapshot at creation time.';
comment on column fat.profiles.home_location_label is
  'Bare label of home origin (station-shape conventions). '
  'rostered_station_label is intentionally absent — see fat.profile_ext for '
  'the prototype write-only field; do not reintroduce prefix-stripping.';

-- TODO (canonical TODO): decide whether the FRV Matrix version pin lives on
-- profiles (per-user) or on the operational_claims detail tables (per-claim,
-- currently drafted). Leave both surfaces open until resolved.


-- ─── 2. stations (extend in place) ───────────────────────────────────────────
-- Existing fat.stations has (id, name, abbreviation, region, is_active,
-- created_at, updated_at). Add canonical columns. `is_active` already maps
-- to canonical `active`.

alter table fat.stations
  add column if not exists district        text,
  add column if not exists street_address  text,
  add column if not exists lat             numeric(9,6),
  add column if not exists lng             numeric(9,6);


-- ─── 3. rates / rate_versions ────────────────────────────────────────────────

create table if not exists fat.rates (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique,
  display_name        text not null,
  unit                text not null check (unit in ('dollars','dollars_per_km','hours')),
  active_version_id   uuid,
  created_at          timestamptz not null default now()
);
comment on table fat.rates is
  'Canonical configurable allowance values. The Rates page is the UI surface. '
  'See ENTITLEMENT_RULES_v1.0.md § Rate Snapshotting.';

create table if not exists fat.rate_versions (
  id              uuid primary key default gen_random_uuid(),
  rate_id         uuid not null references fat.rates(id) on delete cascade,
  version_label   text not null,
  value           numeric(12,4) not null,
  effective_from  date not null,
  created_at      timestamptz not null default now(),
  created_by      uuid references fat.profiles(id) on delete set null,
  unique (rate_id, version_label),
  unique (rate_id, effective_from)
);
comment on table fat.rate_versions is
  'Append-only. One row per rate change. Forward-only: never UPDATE in place; '
  'insert a new version with a new effective_from. The (rate_id, effective_from) '
  'unique constraint enforces unambiguous claim-date lookup (DATABASE_ARCHITECTURE_v1.0.md § 4).';

create index if not exists idx_rate_versions_rate_effective
  on fat.rate_versions (rate_id, effective_from desc);

-- active_version_id FK added after fat.rate_versions exists.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'rates_active_version_id_fkey'
  ) then
    alter table fat.rates
      add constraint rates_active_version_id_fkey
      foreign key (active_version_id) references fat.rate_versions(id);
  end if;
end$$;


-- ─── 4. operational_claims (core) ────────────────────────────────────────────

create table if not exists fat.operational_claims (
  id                        uuid primary key default gen_random_uuid(),
  owner_id                  uuid not null references fat.profiles(id) on delete cascade,
  claim_type                text not null check (claim_type in ('RC','RT','SB','MD','DM','SM')),
  claim_date                date not null,
  station_id_snapshot       integer references fat.stations(id),
  station_name_snapshot     text,
  source_calculation_mode   text check (source_calculation_mode in ('frv_matrix','google_maps','manual')),
  status                    text not null default 'draft' check (status in ('draft','submitted','archived')),
  generated_at              timestamptz not null default now(),
  notes                     text,
  -- Sharing model: copy-on-write. parent_claim_id is provenance-only; no live sync.
  -- TODO (canonical TODO): decide whether to enforce existence as FK or keep
  -- informational so the source can be deleted without breaking copies. For
  -- now: informational columns, no FK constraints.
  parent_claim_id           uuid,
  copy_source_owner_id      uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists idx_operational_claims_owner_date
  on fat.operational_claims (owner_id, claim_date);
create index if not exists idx_operational_claims_type_date
  on fat.operational_claims (claim_type, claim_date);
-- Sharing-layer lookup: "what copies were made from this claim?"
-- Partial index keeps it cheap until the sharing layer ships.
create index if not exists idx_operational_claims_parent
  on fat.operational_claims (parent_claim_id) where parent_claim_id is not null;

comment on table fat.operational_claims is
  'Core operational claim row. Heterogeneous claim types share this table; '
  'type-specific inputs live in the *_details tables joined 1:1 on claim_id. '
  'Static accounting record: station_id_snapshot, station_name_snapshot, '
  'source_calculation_mode, parent_claim_id, copy_source_owner_id, '
  'generated_at are immutable after creation.';

comment on column fat.operational_claims.parent_claim_id is
  'Set when this row was created by copying/sharing from another claim. '
  'Provenance pointer only — no triggers, no FKs, no live sync. See '
  'DATABASE_ARCHITECTURE_v1.0.md § 6. Sharing Model.';
comment on column fat.operational_claims.copy_source_owner_id is
  'For shared copies: the user the draft was copied from. Informational only.';

-- TODO (canonical TODO): decide whether `status` needs a `void` state.


-- ─── 5. Claim-Type Detail Tables (1:1 to operational_claims) ─────────────────
-- Forward-only: new claim types add new detail tables. Existing detail tables
-- MUST NOT be widened to model unrelated claim types.

create table if not exists fat.recall_details (
  claim_id              uuid primary key references fat.operational_claims(id) on delete cascade,
  recall_station_id     integer references fat.stations(id),
  recall_start_at       timestamptz,
  recall_end_at         timestamptz,
  travel_distance_km    numeric(8,2),
  travel_source         text check (travel_source in ('google_maps','manual')),
  meal_break_taken      boolean
);

create table if not exists fat.retain_details (
  claim_id              uuid primary key references fat.operational_claims(id) on delete cascade,
  retain_start_at       timestamptz,
  retain_end_at         timestamptz,
  meal_break_taken      boolean
);

create table if not exists fat.standby_details (
  claim_id              uuid primary key references fat.operational_claims(id) on delete cascade,
  standby_station_id    integer references fat.stations(id),
  standby_start_at      timestamptz,
  standby_end_at        timestamptz,
  matrix_distance_km    numeric(8,2),
  matrix_hours          numeric(6,2),
  matrix_version        text
);

create table if not exists fat.muster_dismiss_details (
  claim_id              uuid primary key references fat.operational_claims(id) on delete cascade,
  md_station_id         integer references fat.stations(id),
  md_event_at           timestamptz,
  matrix_distance_km    numeric(8,2),
  matrix_hours          numeric(6,2),
  matrix_version        text
);

create table if not exists fat.delayed_meal_details (
  claim_id              uuid primary key references fat.operational_claims(id) on delete cascade,
  meal_window_start_at  timestamptz,
  meal_window_end_at    timestamptz,
  actual_meal_at        timestamptz
);

create table if not exists fat.spoilt_meal_details (
  claim_id              uuid primary key references fat.operational_claims(id) on delete cascade,
  meal_provisioned_at   timestamptz,
  spoilt_reason         text
);


-- ─── 6. claim_entitlements (homogeneous) ─────────────────────────────────────

create table if not exists fat.claim_entitlements (
  id                    uuid primary key default gen_random_uuid(),
  claim_id              uuid not null references fat.operational_claims(id) on delete cascade,
  owner_id              uuid not null references fat.profiles(id) on delete cascade,
  entitlement_type      text not null,
  -- Canonical does not pin the entitlement_type enum exhaustively because the
  -- entitlement catalogue is still being codified in ENTITLEMENT_RULES_v1.0.md.
  -- Leave as text + app-layer validation until the catalogue stabilises.
  unit                  text not null check (unit in ('dollars','hours','km')),

  generated_amount      numeric(12,4) not null,
  generated_hours       numeric(8,2),
  edited_amount         numeric(12,4),
  edited_hours          numeric(8,2),
  edited_note           text,
  manual_override       boolean not null default false,
  -- manual_override is a stored mirror of (edited_amount IS NOT NULL OR
  -- edited_hours IS NOT NULL). Maintained by app-layer writes today;
  -- TODO: consider a trigger once the override semantics stabilise.

  rule_id               text not null,
  rule_version          text not null,
  rule_explanation      text,
  formula_explanation   text,

  rate_id               uuid references fat.rates(id),
  rate_version_id       uuid references fat.rate_versions(id),
  rate_snapshot         jsonb not null,

  payment_method        text check (payment_method in ('payslip','petty_cash')),
  payment_status        text,
  -- Stream-scoped: payslip → pending|paid; petty_cash → outstanding|claimed.
  -- TODO (canonical TODO): decide whether to split into two columns per stream.

  generated_at          timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_claim_entitlements_claim
  on fat.claim_entitlements (claim_id);
create index if not exists idx_claim_entitlements_owner_paystatus
  on fat.claim_entitlements (owner_id, payment_status);
create index if not exists idx_claim_entitlements_type_generated
  on fat.claim_entitlements (entitlement_type, generated_at);

comment on table fat.claim_entitlements is
  'Generated entitlements (sub-claims). Homogeneous: one row per entitlement '
  'type regardless of parent claim type. Static accounting record: '
  'generated_amount, generated_hours, rule_id, rule_version, '
  'rule_explanation, formula_explanation, rate_id, rate_version_id, '
  'rate_snapshot, generated_at are immutable after creation. Effective '
  'payable amount = COALESCE(edited_amount, generated_amount).';

comment on column fat.claim_entitlements.generated_amount is
  'Engine output at creation. NEVER overwritten. Manual edits land in '
  'edited_amount with edited_note.';
comment on column fat.claim_entitlements.rate_snapshot is
  'Frozen copy of the rate value(s) used at generation time. Historical '
  'claims read this — they NEVER re-query fat.rates.';
comment on column fat.claim_entitlements.owner_id is
  'Denormalised from fat.operational_claims.owner_id for RLS + sharing checks. '
  'The engine MUST keep this in sync with the parent claim''s owner_id at '
  'creation and on copy.';
comment on column fat.claim_entitlements.payment_method is
  'Stream router. NULL until set. Per PAYMENT_RECONCILIATION_v1.0.md § Payment '
  'Method Routing, Standby auto-children set this at creation; Recall/Retain '
  'children defer. MD/DM/SM defaults are still TODO.';
comment on column fat.claim_entitlements.payment_status is
  'Stream-scoped: payslip → pending|paid; petty_cash → outstanding|claimed. '
  'NULL until payment_method is set. No DB CHECK constraint until the canonical '
  'TODO (split per stream vs single enum) is resolved.';


-- ─── 7. Stations + Travel Reference (canonical naming) ───────────────────────
-- The prototype `fat.travel_matrix_versions` + `fat.travel_matrix_cells` use
-- a versioning helper table. Canonical names the matrices `station_distance_matrix`
-- + `station_time_matrix` with `matrix_version` as a row-level PK component.
-- Create the canonical-named tables here. Co-existence with the prototype is
-- intentional; Phase 3 cutover will choose canonical and drop the prototype.

create table if not exists fat.station_distance_matrix (
  from_station_id  integer not null references fat.stations(id) on delete cascade,
  to_station_id    integer not null references fat.stations(id) on delete cascade,
  matrix_version   text    not null,
  distance_km      numeric(8,2) not null check (distance_km >= 0),
  primary key (from_station_id, to_station_id, matrix_version)
);

create table if not exists fat.station_time_matrix (
  from_station_id  integer not null references fat.stations(id) on delete cascade,
  to_station_id    integer not null references fat.stations(id) on delete cascade,
  matrix_version   text    not null,
  hours            numeric(6,2) not null check (hours >= 0),
  primary key (from_station_id, to_station_id, matrix_version)
);
comment on table fat.station_time_matrix is
  'Companion to station_distance_matrix. FRV Matrix Index sheet returns '
  'DECIMAL HOURS — stored raw here. Conversion to payable dollars is the '
  'engine''s responsibility (ENTITLEMENT_RULES_v1.0.md § FRV Matrix Hours → Payable Bridge). '
  'TODO (canonical TODO): decide whether to merge distance + time matrices '
  'into a single table with (distance_km, hours) columns.';


-- ─── 8. Payment Records + Reconciliation ─────────────────────────────────────

create table if not exists fat.payment_records (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references fat.profiles(id) on delete cascade,
  stream        text not null check (stream in ('payslip','petty_cash')),
  record_date   date not null,
  reference     text,
  gross_amount  numeric(12,2) not null,
  raw_payload   jsonb,
  source        text check (source in ('manual','payslip_screenshot','payslip_pdf','petty_cash_export')),
  created_at    timestamptz not null default now()
);

create index if not exists idx_payment_records_owner_stream_date
  on fat.payment_records (owner_id, stream, record_date desc);

create table if not exists fat.entitlement_payment_links (
  id                  uuid primary key default gen_random_uuid(),
  entitlement_id      uuid not null references fat.claim_entitlements(id) on delete cascade,
  payment_record_id   uuid not null references fat.payment_records(id) on delete cascade,
  allocated_amount    numeric(12,4) not null,
  link_kind           text not null check (link_kind in ('auto_match','manual','discrepancy_note')),
  note                text,
  created_at          timestamptz not null default now()
);

-- FK columns aren't auto-indexed in Postgres; both directions are joined often.
create index if not exists idx_entitlement_payment_links_entitlement
  on fat.entitlement_payment_links (entitlement_id);
create index if not exists idx_entitlement_payment_links_payment_record
  on fat.entitlement_payment_links (payment_record_id);

comment on table fat.entitlement_payment_links is
  'N:M between entitlements and payment records. One entitlement may be '
  'satisfied by zero, one, or several payment records (partial payments); one '
  'payment line may aggregate several entitlements. Status transitions live '
  'on claim_entitlements.payment_status — links are the auditable evidence.';

create table if not exists fat.reconciliation_audit (
  id              uuid primary key default gen_random_uuid(),
  entitlement_id  uuid not null references fat.claim_entitlements(id) on delete cascade,
  actor_id        uuid not null references fat.profiles(id) on delete cascade,
  action          text not null,
  prior_status    text,
  new_status      text,
  reason          text,
  automated       boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists idx_reconciliation_audit_entitlement_time
  on fat.reconciliation_audit (entitlement_id, created_at desc);

comment on table fat.reconciliation_audit is
  'Append-only. Reconciliation actions MUST NOT mutate generated_amount, '
  'rate_snapshot, rule_id, or rule_version. They only mutate payment-state '
  'fields and append rows here. See PAYMENT_RECONCILIATION_v1.0.md § Audit Trail Requirements.';


-- ─── 9. updated_at triggers (canonical tables only) ──────────────────────────

drop trigger if exists set_updated_at on fat.operational_claims;
create trigger set_updated_at before update on fat.operational_claims
  for each row execute function fat.set_updated_at();

drop trigger if exists set_updated_at on fat.claim_entitlements;
create trigger set_updated_at before update on fat.claim_entitlements
  for each row execute function fat.set_updated_at();


-- ─── 10. Row-Level Security ──────────────────────────────────────────────────

alter table fat.rates                       enable row level security;
alter table fat.rate_versions               enable row level security;
alter table fat.operational_claims          enable row level security;
alter table fat.recall_details              enable row level security;
alter table fat.retain_details              enable row level security;
alter table fat.standby_details             enable row level security;
alter table fat.muster_dismiss_details      enable row level security;
alter table fat.delayed_meal_details        enable row level security;
alter table fat.spoilt_meal_details         enable row level security;
alter table fat.claim_entitlements          enable row level security;
alter table fat.station_distance_matrix     enable row level security;
alter table fat.station_time_matrix         enable row level security;
alter table fat.payment_records             enable row level security;
alter table fat.entitlement_payment_links   enable row level security;
alter table fat.reconciliation_audit        enable row level security;

-- All `create policy` calls are wrapped in guarded DO blocks to keep this file
-- safely replayable — Postgres has no CREATE POLICY IF NOT EXISTS form. This
-- mirrors the pattern already used in supabase/fat-schema-travel.sql.

do $$
declare
  -- Shared reference tables: authenticated-read, service_role-write.
  shared_tables text[] := array[
    'rates',
    'rate_versions',
    'station_distance_matrix',
    'station_time_matrix'
  ];
  -- Detail tables: scoped by joining to parent operational_claims.owner_id.
  detail_tables text[] := array[
    'recall_details',
    'retain_details',
    'standby_details',
    'muster_dismiss_details',
    'delayed_meal_details',
    'spoilt_meal_details'
  ];
  t text;
begin
  -- Shared reference tables.
  foreach t in array shared_tables loop
    if not exists (select 1 from pg_policies
                    where schemaname='fat' and tablename=t
                      and policyname='authenticated_read') then
      execute format(
        'create policy authenticated_read on fat.%I for select using (auth.role() = ''authenticated'')',
        t
      );
    end if;
    if not exists (select 1 from pg_policies
                    where schemaname='fat' and tablename=t
                      and policyname='service_role_manage') then
      execute format(
        'create policy service_role_manage on fat.%I for all '
        || 'using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'')',
        t
      );
    end if;
  end loop;

  -- Per-owner user data: owner-only via owner_id.
  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='operational_claims'
                    and policyname='users_manage_own') then
    create policy users_manage_own on fat.operational_claims for all
      using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='claim_entitlements'
                    and policyname='users_manage_own') then
    create policy users_manage_own on fat.claim_entitlements for all
      using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='payment_records'
                    and policyname='users_manage_own') then
    create policy users_manage_own on fat.payment_records for all
      using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
  end if;
  -- reconciliation_audit: actor-scoped today. Open TODO: confirm whether the
  -- entitlement owner should also be able to read the audit trail (becomes
  -- relevant once the sharing layer ships).
  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='reconciliation_audit'
                    and policyname='users_manage_own') then
    create policy users_manage_own on fat.reconciliation_audit for all
      using (auth.uid() = actor_id) with check (auth.uid() = actor_id);
  end if;

  -- Detail tables: scoped via parent operational_claims.owner_id.
  foreach t in array detail_tables loop
    if not exists (select 1 from pg_policies
                    where schemaname='fat' and tablename=t
                      and policyname='users_manage_own') then
      execute format(
        'create policy users_manage_own on fat.%I for all '
        || 'using      (exists (select 1 from fat.operational_claims c where c.id = claim_id and c.owner_id = auth.uid())) '
        || 'with check (exists (select 1 from fat.operational_claims c where c.id = claim_id and c.owner_id = auth.uid()))',
        t
      );
    end if;
  end loop;

  -- entitlement_payment_links: owner via joined entitlement.
  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='entitlement_payment_links'
                    and policyname='users_manage_own') then
    create policy users_manage_own on fat.entitlement_payment_links for all
      using      (exists (select 1 from fat.claim_entitlements e where e.id = entitlement_id and e.owner_id = auth.uid()))
      with check (exists (select 1 from fat.claim_entitlements e where e.id = entitlement_id and e.owner_id = auth.uid()));
  end if;
end$$;


-- ─── 11. Grants ──────────────────────────────────────────────────────────────
-- New tables inherit the default privileges established by fat-schema.sql.
-- Re-grant explicitly to be safe under replays.

grant select, insert, update, delete on fat.rates                     to authenticated, service_role;
grant select, insert, update, delete on fat.rate_versions             to authenticated, service_role;
grant select, insert, update, delete on fat.operational_claims        to authenticated, service_role;
grant select, insert, update, delete on fat.recall_details            to authenticated, service_role;
grant select, insert, update, delete on fat.retain_details            to authenticated, service_role;
grant select, insert, update, delete on fat.standby_details           to authenticated, service_role;
grant select, insert, update, delete on fat.muster_dismiss_details    to authenticated, service_role;
grant select, insert, update, delete on fat.delayed_meal_details      to authenticated, service_role;
grant select, insert, update, delete on fat.spoilt_meal_details       to authenticated, service_role;
grant select, insert, update, delete on fat.claim_entitlements        to authenticated, service_role;
grant select, insert, update, delete on fat.station_distance_matrix   to authenticated, service_role;
grant select, insert, update, delete on fat.station_time_matrix       to authenticated, service_role;
grant select, insert, update, delete on fat.payment_records           to authenticated, service_role;
grant select, insert, update, delete on fat.entitlement_payment_links to authenticated, service_role;
grant select, insert, update, delete on fat.reconciliation_audit      to authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- END canonical foundation v1.0
-- ═══════════════════════════════════════════════════════════════════════════════
