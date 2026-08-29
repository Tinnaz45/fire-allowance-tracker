-- ═══════════════════════════════════════════════════════════════════════════════
-- APP-92 — REMOVE UNREFERENCED LEGACY FIRE ALLOWANCE PUBLIC ENUMS (DEV)
-- Step 01: THE MIGRATION — DESTRUCTIVE
--
-- Applied to DEV (kctctvpobbizhkiqkgqw) as migration
-- `app92_drop_unreferenced_legacy_public_enums_v1`. PRODUCTION
-- (wgcqzamuspuqpedqasbc) IS OUT OF SCOPE AND MUST NOT RECEIVE THIS MIGRATION —
-- PROD still carries the five tables GOV-89 removed from DEV only, and these
-- four types are still live there.
--
-- Drops exactly four legacy enum types and nothing else:
--   1. public.allowance_line_type
--   2. public.audit_action
--   3. public.ingestion_source
--   4. public.shift_status
--
-- WHY THESE ARE SAFE TO DROP
-- GOV-89 removed their only five consumer tables from DEV
-- (supabase/dev-cleanup/gov-89-stale-public-objects/) and deliberately left
-- these four types in place because they were outside its approved scope.
-- APP-92's own preflight (00_preflight_inspect.sql) re-proves, live against
-- DEV, that: no column in any schema is typed to any of the four; no
-- function/procedure body in any schema names them; no check constraint
-- references them; and the only pg_depend entries on their OIDs are Postgres'
-- own internal enum-to-array-type bookkeeping. The repository's only textual
-- matches are the GOV-89 cleanup artifacts and FAT_SCHEMA_ARCHITECTURE.md
-- prose documenting that same fact — not live code.
--
-- NO CASCADE
-- Every DROP below is explicit RESTRICT. Postgres already refuses a RESTRICT
-- drop if anything still depends on the type, so this is a real guarantee, not
-- a formality: if preflight missed something, the statement aborts instead of
-- silently taking a dependent object with it.
--
-- OUT OF SCOPE
-- public.profiles, fat.*, mica.*, cab.*, shared.*, all Supabase/platform
-- schemas, and every other public object are untouched. `public` itself keeps
-- holding exactly what it held before (public.profiles), just with zero enum
-- types after this instead of four.
--
-- The migration is guarded at both ends: it refuses to start if the live
-- dependency surface is not exactly what 00 proved, and it refuses to finish
-- if any protected surface moved. Both guards RAISE EXCEPTION, which rolls the
-- whole migration back.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── GUARD 1 — the four targets are present and truly unreferenced ───────────
DO $guard$
DECLARE
  v_present   integer;
  v_missing   text;
  v_col_use   text;
  v_dep_use   text;
BEGIN
  -- All four must be present as enum types in public. A partially-applied
  -- state is drift, not success.
  SELECT count(*) INTO v_present
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typtype = 'e'
    AND t.typname IN ('allowance_line_type','audit_action','ingestion_source','shift_status');

  IF v_present <> 4 THEN
    SELECT string_agg(x, ', ' ORDER BY x) INTO v_missing
    FROM unnest(ARRAY['allowance_line_type','audit_action','ingestion_source','shift_status']) x
    WHERE to_regtype('public.' || x) IS NULL;
    RAISE EXCEPTION 'APP-92 abort: expected all 4 target enum types present, found %. Missing: %.', v_present, coalesce(v_missing,'(none)');
  END IF;

  -- No column anywhere may still be typed to one of the four.
  SELECT string_agg(format('%I.%I.%I (%s)', n.nspname, c.relname, a.attname, ty.typname), '; ')
    INTO v_col_use
  FROM pg_attribute a
  JOIN pg_class     c  ON c.oid  = a.attrelid
  JOIN pg_namespace n  ON n.oid  = c.relnamespace
  JOIN pg_type      ty ON ty.oid = a.atttypid
  WHERE ty.typname IN ('allowance_line_type','audit_action','ingestion_source','shift_status')
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_col_use IS NOT NULL THEN
    RAISE EXCEPTION 'APP-92 abort: column(s) still typed to a target enum: %', v_col_use;
  END IF;

  -- No external dependant on any of the four type OIDs (only the type's own
  -- internal array-type bookkeeping is expected).
  SELECT string_agg(format('%s#%s (deptype=%s, type=%s)', d.classid::regclass, d.objid, d.deptype, ty.typname), '; ')
    INTO v_dep_use
  FROM pg_type ty
  JOIN pg_namespace tn ON tn.oid = ty.typnamespace
  JOIN pg_depend d ON d.refobjid = ty.oid AND d.refclassid = 'pg_type'::regclass
  WHERE tn.nspname = 'public'
    AND ty.typname IN ('allowance_line_type','audit_action','ingestion_source','shift_status')
    AND NOT (d.classid = 'pg_type'::regclass AND d.deptype = 'i');
  IF v_dep_use IS NOT NULL THEN
    RAISE EXCEPTION 'APP-92 abort: unexpected dependant on a target enum: %', v_dep_use;
  END IF;
END
$guard$;


-- ─── SNAPSHOT — protected-surface state, compared again after the drops ──────
CREATE TEMP TABLE app92_protected_snapshot AS
SELECT
  (SELECT count(*) FROM public.profiles)                                                        AS profiles_rows,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='public' AND c.relkind IN ('r','v','m','p'))                 AS public_rels,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='fat'    AND c.relkind IN ('r','v','m','p'))                 AS fat_rels,
  (SELECT count(*) FROM pg_proc  p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='fat')                                                       AS fat_fns,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='mica'   AND c.relkind IN ('r','v','m','p'))                 AS mica_rels,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='cab'    AND c.relkind IN ('r','v','m','p'))                 AS cab_rels,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='shared' AND c.relkind IN ('r','v','m','p'))                 AS shared_rels,
  (SELECT count(*) FROM auth.users)                                                             AS auth_users,
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                   JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='auth' AND NOT t.tgisinternal)                                AS auth_triggers;


-- ─── THE DROPS — explicit RESTRICT, never CASCADE ────────────────────────────
DROP TYPE public.allowance_line_type RESTRICT;
DROP TYPE public.audit_action        RESTRICT;
DROP TYPE public.ingestion_source    RESTRICT;
DROP TYPE public.shift_status        RESTRICT;


-- ─── POST-CHECK — all four gone, every protected surface untouched ───────────
DO $post$
DECLARE
  v_left text;
  v_snap record;
  v_now  integer;
BEGIN
  SELECT string_agg('public.' || t, ', ' ORDER BY t) INTO v_left
  FROM unnest(ARRAY['allowance_line_type','audit_action','ingestion_source','shift_status']) t
  WHERE to_regtype('public.' || t) IS NOT NULL;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'APP-92 abort: target enum type(s) still present: %', v_left;
  END IF;

  SELECT * INTO v_snap FROM app92_protected_snapshot;

  IF to_regnamespace('public') IS NULL THEN
    RAISE EXCEPTION 'APP-92 abort: schema `public` was dropped.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'APP-92 abort: public.profiles was dropped.';
  END IF;
  IF (SELECT count(*) FROM public.profiles) <> v_snap.profiles_rows THEN
    RAISE EXCEPTION 'APP-92 abort: public.profiles row count changed (% -> %).',
      v_snap.profiles_rows, (SELECT count(*) FROM public.profiles);
  END IF;

  SELECT count(*) INTO v_now FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('r','v','m','p');
  IF v_now <> v_snap.public_rels THEN
    RAISE EXCEPTION 'APP-92 abort: public relation count changed (% -> %) — a table/view was affected, not just enum types.', v_snap.public_rels, v_now;
  END IF;

  SELECT count(*) INTO v_now FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='fat' AND c.relkind IN ('r','v','m','p');
  IF v_now <> v_snap.fat_rels THEN
    RAISE EXCEPTION 'APP-92 abort: fat relation count changed (% -> %).', v_snap.fat_rels, v_now;
  END IF;

  SELECT count(*) INTO v_now FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fat';
  IF v_now <> v_snap.fat_fns THEN
    RAISE EXCEPTION 'APP-92 abort: fat function count changed (% -> %).', v_snap.fat_fns, v_now;
  END IF;

  SELECT count(*) INTO v_now FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='mica' AND c.relkind IN ('r','v','m','p');
  IF v_now <> v_snap.mica_rels THEN
    RAISE EXCEPTION 'APP-92 abort: mica relation count changed (% -> %).', v_snap.mica_rels, v_now;
  END IF;

  SELECT count(*) INTO v_now FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='cab' AND c.relkind IN ('r','v','m','p');
  IF v_now <> v_snap.cab_rels THEN
    RAISE EXCEPTION 'APP-92 abort: cab relation count changed (% -> %).', v_snap.cab_rels, v_now;
  END IF;

  SELECT count(*) INTO v_now FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='shared' AND c.relkind IN ('r','v','m','p');
  IF v_now <> v_snap.shared_rels THEN
    RAISE EXCEPTION 'APP-92 abort: shared relation count changed (% -> %).', v_snap.shared_rels, v_now;
  END IF;

  IF (SELECT count(*) FROM auth.users) <> v_snap.auth_users THEN
    RAISE EXCEPTION 'APP-92 abort: auth.users row count changed (% -> %).',
      v_snap.auth_users, (SELECT count(*) FROM auth.users);
  END IF;

  SELECT count(*) INTO v_now FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' AND NOT t.tgisinternal;
  IF v_now <> v_snap.auth_triggers THEN
    RAISE EXCEPTION 'APP-92 abort: auth trigger count changed (% -> %).', v_snap.auth_triggers, v_now;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='auth' AND c.relname='users'
                   AND t.tgname='on_auth_user_created_fat' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'APP-92 abort: the FAT auth seed trigger on_auth_user_created_fat is missing.';
  END IF;

  IF to_regprocedure('fat.handle_new_user()') IS NULL THEN
    RAISE EXCEPTION 'APP-92 abort: fat.handle_new_user() is missing.';
  END IF;

  RAISE NOTICE 'APP-92: 4 unreferenced legacy public enum types dropped; public.profiles, fat.*, mica.*, cab.*, shared.* and auth.* intact.';
END
$post$;

DROP TABLE IF EXISTS app92_protected_snapshot;
