-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0) — MIGRATION 19
-- Per-user feature flags — normalized relational model (replaces the JSONB design)
--
-- Per-user feature gating is modelled as a thin association table rather than a
-- JSONB blob on the user. Each enabled feature is ONE row keyed by
-- (user_id, feature_name). There is intentionally NO `enabled` column:
--
--     row exists   →  feature ENABLED  for that user
--     no row       →  feature DISABLED for that user
--
-- Disabling a feature DELETES the row (we never retain disabled rows), so the
-- table only ever holds positive grants. This keeps the model self-cleaning and
-- makes "what is this user allowed?" a trivial owner-scoped SELECT that the app
-- reconstructs into the same { feature: true } object shape it has always used.
--
-- Writes are service-role only — flags are provisioned by the admin CLI
-- (scripts/set-feature-flag.mjs), never by the end user — so authenticated
-- users get owner-scoped READ only. This mirrors the shared-reference-table
-- split in migration 01 (authenticated read / service_role write).
--
-- ADDITIVE ONLY — a new table + policies; no existing table/column changes.
-- Idempotent: CREATE ... IF NOT EXISTS, guarded DO blocks for policies (Postgres
-- has no CREATE POLICY IF NOT EXISTS), DROP-then-CREATE for the trigger. Safe to
-- replay against an already-stamped project. DEV only — PROD untouched.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── 1. Table ────────────────────────────────────────────────────────────────
-- Composite primary key (user_id, feature_name) enforces "at most one row per
-- user per feature" — the natural key for an UPSERT target and the reason no
-- surrogate id is needed. user_id cascades on auth.users delete (the flag is
-- meaningless without its user); updated_by sets null (audit-only — losing the
-- admin who set it must not delete the grant).

create table if not exists fat.user_feature_flags (
  user_id       uuid        not null references auth.users(id) on delete cascade,
  feature_name  text        not null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid                 references auth.users(id) on delete set null,
  primary key (user_id, feature_name)
);

comment on table fat.user_feature_flags is
  'Per-user feature grants. Row presence IS the boolean: a row means the named '
  'feature is enabled for that user; no row means disabled. Disabling deletes '
  'the row. Reconstructed app-side into a { feature: true } object. Writes are '
  'service-role only (admin CLI); users get owner-scoped read.';
comment on column fat.user_feature_flags.feature_name is
  'Free-text feature key (e.g. payments, admin, ocr, beta). Matches the keys the '
  'application already uses in its feature object.';
comment on column fat.user_feature_flags.updated_by is
  'auth.users id of the admin/service actor that last upserted this grant. '
  'Audit only — nullable, set null on actor delete.';


-- ─── 2. updated_at trigger ───────────────────────────────────────────────────
-- Reuses fat.set_updated_at() (defined in fat-schema.sql). DROP-then-CREATE so a
-- replay re-binds rather than erroring.

drop trigger if exists set_updated_at on fat.user_feature_flags;
create trigger set_updated_at before update on fat.user_feature_flags
  for each row execute function fat.set_updated_at();


-- ─── 3. Row Level Security ───────────────────────────────────────────────────
-- owner_read         — a user may SELECT only their own flag rows.
-- service_role_manage — the service role (admin CLI) has full read/write.
-- No insert/update/delete policy exists for `authenticated`, so end users can
-- never self-grant a feature even though the SELECT grant is in place.
-- Policies are created inside guarded DO blocks (no CREATE POLICY IF NOT EXISTS).

alter table fat.user_feature_flags enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='user_feature_flags'
                    and policyname='owner_read') then
    create policy owner_read on fat.user_feature_flags for select
      using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='user_feature_flags'
                    and policyname='service_role_manage') then
    create policy service_role_manage on fat.user_feature_flags for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end$$;


-- ─── 4. Grants ───────────────────────────────────────────────────────────────
-- authenticated: read-only (RLS pins it to own rows). service_role: full DML for
-- the admin CLI upsert/delete. Re-granted explicitly to be safe under replays.

grant select                         on fat.user_feature_flags to authenticated;
grant select, insert, update, delete on fat.user_feature_flags to service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- END migration 19
-- ═══════════════════════════════════════════════════════════════════════════════
