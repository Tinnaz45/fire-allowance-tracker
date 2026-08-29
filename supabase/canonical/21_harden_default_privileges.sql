-- ─── Harden fat default privileges (APP-93 / GOV-102) ────────────────────────
-- GOV-102 audited shared Supabase DEV and found that role `postgres` carries
-- default ACLs in schema `fat` that automatically grant *future* tables,
-- sequences and functions to anon, authenticated and service_role the moment
-- they are created — before any RLS/policy is established on them. Existing
-- FAT tables all have RLS enabled today, so the live defect is fail-open
-- creation semantics, not a currently-exploitable hole: a newly created table
-- is Data-API-reachable by anon before its RLS policy is written.
--
-- Read-only PROD inspection under GOV-102 confirmed `fat` in PROD carries the
-- same broad defaults. This migration is DEV-only (project kctctvpobbizhkiqkgqw
-- application context) — it is not applied to PROD (wgcqzamuspuqpedqasbc) as
-- part of this change. PROD hardening is a separate, explicitly approved
-- migration.
--
-- What this does:
--   1. Revokes the existing postgres-owned default ACL entries for future
--      fat tables, sequences and functions from anon/authenticated/
--      service_role, so newly created objects start with no Data API access.
--   2. Explicitly strips the PostgreSQL built-in default that grants PUBLIC
--      EXECUTE on new functions, so a future fat function is not callable by
--      anyone until it is explicitly granted.
--
-- What this does NOT do (APP-93 required scope — do not silently broaden):
--   * It does not touch grants on any object that already exists. ALTER
--     DEFAULT PRIVILEGES only affects objects created after it runs; every
--     existing fat table/sequence/function keeps exactly the grants it has
--     today.
--   * It does not touch any schema other than fat (cab is explicitly out of
--     scope per APP-93).
--   * It does not add any new grants — new objects are opt-in from here on.
--     See docs/FAT_SCHEMA_ARCHITECTURE.md → "Provisioning new fat objects"
--     for the required pattern: enable RLS + write policies first, then grant
--     least-privilege access explicitly, per object, per role.
--
-- Idempotent: REVOKE on a default ACL entry that has already been narrowed is
-- a no-op, so re-running this file is safe.
-- ─────────────────────────────────────────────────────────────────────────────

alter default privileges for role postgres in schema fat
  revoke all privileges on tables from anon, authenticated, service_role;

alter default privileges for role postgres in schema fat
  revoke all privileges on sequences from anon, authenticated, service_role;

alter default privileges for role postgres in schema fat
  revoke all privileges on functions from anon, authenticated, service_role;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default unless a
-- default-privilege entry says otherwise. This statement is the documented
-- way to prevent that (see the PostgreSQL ALTER DEFAULT PRIVILEGES manual
-- page) and is kept as defense-in-depth, but DEV verification found it does
-- NOT actually suppress PUBLIC execute in this Supabase-managed instance —
-- every function's initial ACL still carries PUBLIC=EXECUTE regardless. See
-- docs/FAT_SCHEMA_ARCHITECTURE.md → "Known limitation" for the verified
-- behaviour and why every new fat function must explicitly
-- `revoke execute on function fat.<name>(...) from public;` in the same
-- migration that creates it.
alter default privileges for role postgres in schema fat
  revoke execute on functions from public;
