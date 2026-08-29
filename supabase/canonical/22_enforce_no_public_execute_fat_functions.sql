-- ─── Enforce no-PUBLIC-execute on new fat functions (APP-103) ────────────────
-- APP-93 (GOV-102) found that `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON
-- FUNCTIONS FROM PUBLIC` does not suppress the PUBLIC=EXECUTE grant PostgreSQL
-- seeds on every newly created function in this Supabase-managed instance, and
-- made a same-migration `REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC` mandatory
-- as a *procedural* mitigation. APP-103 re-verified that finding directly
-- against shared Supabase DEV (kctctvpobbizhkiqkgqw) with disposable probe
-- functions, then went one step further to bound the mechanism precisely:
--
--   * A schema `fat` default-privilege entry populated with a REVOKE-only
--     statement never persists a pg_default_acl row here (nothing to revoke),
--     so new functions' initial ACL is NULL and PostgreSQL falls back to its
--     hard-wired default (owner + PUBLIC execute).
--   * Populating that same default-privilege slot with an explicit GRANT
--     (e.g. `... GRANT EXECUTE ON FUNCTIONS TO service_role`) *does* persist a
--     pg_default_acl row with no PUBLIC entry in it — but a function created
--     immediately afterwards still receives PUBLIC=EXECUTE in its ACL anyway.
--   * No event trigger, extension, or other DDL hook already installed on
--     this project explains it: `pg_event_trigger` lists only Supabase's own
--     pg_graphql/pg_cron/pg_net/PostgREST hooks, none of which touch function
--     ACLs for ordinary `CREATE FUNCTION` statements outside their own
--     extensions, and there is no database-wide (schema-less) default-ACL
--     entry for role `postgres` either.
--   * The exact internal reason the schema-scoped default-privilege override
--     does not fully replace the hard-wired default is not further isolable
--     from SQL alone (it would require inspecting Supabase's Postgres build);
--     the finding is bounded to "ALTER DEFAULT PRIVILEGES, in any form tried,
--     does not reliably suppress PUBLIC execute on new fat functions here" and
--     accepted as reproducible fact rather than fully root-caused deeper.
--
-- What *does* reliably work: a direct, per-function
-- `REVOKE EXECUTE ON FUNCTION <name>(...) FROM PUBLIC` after creation. Every
-- existing fat function that has had this applied holds no PUBLIC grant today
-- (verified against pg_proc.proacl). APP-93's gap was that this step is
-- manual and was not applied consistently to every new function.
--
-- Enforcement options compared (APP-103 investigation):
--   1. Migration/CI validation rejecting a fat function without a paired
--      REVOKE in the same file — repo-scoped, zero DB blast radius, but only
--      catches functions that arrive through a committed migration file run
--      through this repo's CI. It cannot catch a function created directly
--      against DEV (Supabase SQL editor, an ad-hoc MCP `execute_sql`/
--      `apply_migration` call not backed by a committed file, or any other
--      direct-psql path) — which is how every migration in this project's
--      history has actually been *applied* to DEV. Necessary as
--      defense-in-depth eventually, not sufficient alone against the
--      demonstrated gap.
--   2. Repository migration helper/template enforcing the pattern — same
--      limitation as (1): it only helps work that goes through the helper.
--   3. A `fat`-scoped DDL event trigger that force-revokes PUBLIC execute on
--      every `CREATE FUNCTION` landing in schema `fat`, regardless of how it
--      got there. This is the only option that closes the gap unconditionally
--      for schema fat, matching how this app's own migration history was
--      actually produced.
--   4. Any other native default-privilege configuration — ruled out by the
--      direct DEV evidence above; no default-privilege configuration tried
--      suppresses the built-in grant here.
--
-- Option 3 was selected. It is scoped as narrowly as PostgreSQL allows:
--   * Event triggers cannot be schema-scoped at the CREATE EVENT TRIGGER
--     level (they are always database objects), so the trigger fires only for
--     the `CREATE FUNCTION` command tag (never on any other DDL), and its
--     body immediately no-ops for every object whose `schema_name` is not
--     exactly `fat` — cab, mica, public, and every other schema in this
--     shared database are provably unaffected. No existing function's grants
--     are touched; only functions created *after* this migration are in
--     scope. It never touches an explicit `authenticated`/`service_role`
--     grant a migration adds for a new RPC — it revokes PUBLIC only.
--   * DEV-only. PROD (wgcqzamuspuqpedqasbc) is untouched; hardening PROD is a
--     separate, explicitly approved migration, matching APP-93's precedent.
--
-- Idempotent: CREATE OR REPLACE FUNCTION / CREATE EVENT TRIGGER (guarded by a
-- DROP IF EXISTS) make re-running this file safe.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function fat._enforce_no_public_execute()
  returns event_trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  rec record;
begin
  for rec in
    select object_identity
    from pg_event_trigger_ddl_commands()
    where object_type = 'function'
      and schema_name = 'fat'
  loop
    execute format('revoke execute on function %s from public', rec.object_identity);
  end loop;
end;
$$;

comment on function fat._enforce_no_public_execute() is
  'APP-103: event-trigger handler that strips PUBLIC execute from every '
  'newly created or replaced fat.* function. Does not touch any other '
  'schema or any explicit role grant. See supabase/canonical/22_enforce_no_public_execute_fat_functions.sql.';

drop event trigger if exists fat_enforce_no_public_execute;

-- Named with a fat_ prefix even though event triggers are not namespaced —
-- this is the one object type in this project where that prefix is correct:
-- it is the only way to signal fat ownership on a database-level object.
create event trigger fat_enforce_no_public_execute
  on ddl_command_end
  when tag in ('CREATE FUNCTION')
  execute function fat._enforce_no_public_execute();

comment on event trigger fat_enforce_no_public_execute is
  'APP-103: fires on every CREATE FUNCTION in the database, no-ops for '
  'every schema except fat. See supabase/canonical/22_enforce_no_public_execute_fat_functions.sql.';

-- Bootstrapping gap: the handler function above was itself created via
-- CREATE FUNCTION *before* the event trigger that would have stripped its
-- own PUBLIC execute existed, so it is not self-covered. Close that by hand,
-- in the same migration, so a fresh apply of this file never leaves it open
-- (caught via the Supabase security advisor during DEV verification).
revoke execute on function fat._enforce_no_public_execute() from public;
