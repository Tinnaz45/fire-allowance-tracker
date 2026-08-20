-- ═══════════════════════════════════════════════════════════════════════════════
-- GOV-89 — REMOVE STALE FIRE ALLOWANCE PUBLIC-SCHEMA OBJECTS (DEV)
-- Step 01: THE MIGRATION — DESTRUCTIVE
--
-- Applied to DEV (kctctvpobbizhkiqkgqw) as migration
-- `gov89_drop_stale_public_fat_objects_v1`. PRODUCTION (wgcqzamuspuqpedqasbc)
-- IS OUT OF SCOPE AND MUST NOT RECEIVE THIS MIGRATION.
--
-- Drops exactly five legacy relations and nothing else:
--   1. public.allowance_breakdowns
--   2. public.audit_logs
--   3. public.calculation_snapshots
--   4. public.shifts
--   5. public.engine_versions
--
-- WHY THESE ARE SAFE TO DROP
-- `docs/FAT_SCHEMA_ARCHITECTURE.md` records `public` as transitional cross-app
-- debt that FAT runtime neither reads nor writes; every FAT-owned object lives
-- in `fat` and is reached through the schema-scoped client in
-- `lib/supabaseClient.js`. No file in this repository references any of the five
-- as a database relation. Their content is legacy NSW Ambulance EAPA test data
-- (`engine_versions.eba_reference = 'NSW Ambulance EAPA Grade 9, EBA 2024'`) —
-- a different pay domain entirely from FAT's hours-first FRV entitlements.
--
-- NO BLIND CASCADE
-- Every DROP below is explicit RESTRICT. RESTRICT is Postgres' default, but it
-- is written out so the guarantee is visible and so any unexpected external
-- dependant aborts the migration instead of being silently destroyed. The drop
-- ORDER is what makes RESTRICT sufficient: each table is removed only after
-- everything referencing it is already gone.
--
--   allowance_breakdowns -> {calculation_snapshots, shifts}   (drop 1st)
--   audit_logs           -> {}                                (no referrers)
--   calculation_snapshots -> {engine_versions, shifts}         (drop after 1)
--   shifts                                                     (drop after 1,3)
--   engine_versions                                            (drop after 3)
--
-- RLS policies and indexes are internal dependencies of their own table and are
-- removed with it — they never require CASCADE.
--
-- OUTBOUND FKs TO auth.users are ON DELETE SET NULL. Dropping a child table
-- removes only its own constraint; auth.users is not read, written or altered.
--
-- OUT OF SCOPE, DELIBERATELY LEFT IN PLACE
-- The enum types public.allowance_line_type, public.audit_action,
-- public.ingestion_source and public.shift_status are used only by these five
-- tables and become unreferenced afterwards. GOV-89 approves five relations, not
-- the types, so they are preserved. Their disposition is an independently
-- meaningful discovery for a separate Issue.
--
-- The migration is guarded at both ends: it refuses to start if the dependency
-- surface is not exactly what 00 proved, and it refuses to finish if any
-- protected surface moved. Both guards RAISE EXCEPTION, which rolls the whole
-- migration back.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── GUARD 1 — preservation boundary and drop-set shape ──────────────────────
DO $guard$
DECLARE
  v_present integer;
  v_missing text;
BEGIN
  -- public.profiles is the boundary: if it is not here, this is not the database
  -- GOV-89 was scoped against.
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'GOV-89 abort: public.profiles is absent. The preservation boundary cannot be verified.';
  END IF;

  -- The fat schema must be present and populated — dropping legacy public
  -- objects is only correct while the fat replacement surface exists.
  IF to_regnamespace('fat') IS NULL THEN
    RAISE EXCEPTION 'GOV-89 abort: schema `fat` is absent. Refusing to remove legacy public objects.';
  END IF;
  IF to_regclass('fat.profiles') IS NULL THEN
    RAISE EXCEPTION 'GOV-89 abort: fat.profiles is absent — the FAT runtime surface is not intact.';
  END IF;

  -- All five must be present. A partially-applied state is drift, not success.
  SELECT count(*) INTO v_present
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname IN ('allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts');

  IF v_present <> 5 THEN
    SELECT string_agg(t, ', ' ORDER BY t) INTO v_missing
    FROM unnest(ARRAY['allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts']) t
    WHERE to_regclass('public.' || t) IS NULL;
    RAISE EXCEPTION 'GOV-89 abort: expected all 5 target tables present, found %. Missing: %.', v_present, coalesce(v_missing,'(none)');
  END IF;
END
$guard$;


-- ─── GUARD 2 — nothing outside the drop set depends on the drop set ──────────
DO $deps$
DECLARE
  v_offender text;
BEGIN
  -- 2a. No foreign key from outside the drop set may point into it.
  SELECT string_agg(format('%I.%I.%I -> %I.%I',
                           src_ns.nspname, src.relname, con.conname,
                           tgt_ns.nspname, tgt.relname), '; ')
    INTO v_offender
  FROM pg_constraint con
  JOIN pg_class     src    ON src.oid    = con.conrelid
  JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
  JOIN pg_class     tgt    ON tgt.oid    = con.confrelid
  JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
  WHERE con.contype = 'f'
    AND tgt_ns.nspname = 'public'
    AND tgt.relname IN ('allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts')
    AND NOT (src_ns.nspname = 'public'
             AND src.relname IN ('allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts'));
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION 'GOV-89 abort: foreign key(s) from outside the drop set reference it: %', v_offender;
  END IF;

  -- 2b. No view / materialized view / rule anywhere may depend on the drop set.
  SELECT string_agg(DISTINCT format('%I.%I', dn.nspname, dep_c.relname), '; ')
    INTO v_offender
  FROM pg_depend    d
  JOIN pg_rewrite   r     ON r.oid     = d.objid
  JOIN pg_class     dep_c ON dep_c.oid = r.ev_class
  JOIN pg_namespace dn    ON dn.oid    = dep_c.relnamespace
  JOIN pg_class     src_c ON src_c.oid = d.refobjid
  JOIN pg_namespace sn    ON sn.oid    = src_c.relnamespace
  WHERE d.classid    = 'pg_rewrite'::regclass
    AND d.refclassid = 'pg_class'::regclass
    AND sn.nspname   = 'public'
    AND src_c.relname IN ('allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts')
    AND dep_c.oid <> src_c.oid;
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION 'GOV-89 abort: view/rule dependency outside the drop set: %', v_offender;
  END IF;

  -- 2c. No routine in an application schema may name the drop set.
  SELECT string_agg(format('%I.%I', n.nspname, p.proname), '; ')
    INTO v_offender
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('fat','mica','cab','shared','public')
    AND (p.prosrc ~* '\m(allowance_breakdowns|calculation_snapshots|engine_versions)\M'
         OR p.prosrc ~* '\m(audit_logs|shifts)\M');
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION 'GOV-89 abort: routine(s) reference the drop set: %', v_offender;
  END IF;
END
$deps$;


-- ─── SNAPSHOT — protected-surface state, compared again after the drops ──────
CREATE TEMP TABLE gov89_protected_snapshot AS
SELECT
  (SELECT count(*) FROM public.profiles)                                                        AS profiles_rows,
  (SELECT count(*) FROM pg_attribute  WHERE attrelid = 'public.profiles'::regclass
                                        AND attnum > 0 AND NOT attisdropped)                    AS profiles_cols,
  (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.profiles'::regclass)             AS profiles_cons,
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
  (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                   WHERE n.nspname='public' AND t.typtype='e')                                  AS public_enums,
  (SELECT count(*) FROM auth.users)                                                             AS auth_users,
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                   JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='auth' AND NOT t.tgisinternal)                                AS auth_triggers;


-- ─── THE DROPS — FK-safe order, explicit RESTRICT, never CASCADE ─────────────

-- 1. allowance_breakdowns: nothing references it; it references
--    calculation_snapshots and shifts, so it must go first.
DROP TABLE public.allowance_breakdowns RESTRICT;

-- 2. audit_logs: standalone. Referenced by nothing, references only auth.users.
DROP TABLE public.audit_logs RESTRICT;

-- 3. calculation_snapshots: its only referrer (allowance_breakdowns) is gone.
DROP TABLE public.calculation_snapshots RESTRICT;

-- 4. shifts: both referrers (allowance_breakdowns, calculation_snapshots) gone.
DROP TABLE public.shifts RESTRICT;

-- 5. engine_versions: its only referrer (calculation_snapshots) is gone.
DROP TABLE public.engine_versions RESTRICT;


-- ─── POST-CHECK — all five gone, every protected surface untouched ───────────
DO $post$
DECLARE
  v_left text;
  v_snap record;
  v_now  integer;
BEGIN
  -- All five must be absent.
  SELECT string_agg(format('public.%I', c.relname), ', ' ORDER BY c.relname) INTO v_left
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'GOV-89 abort: stale public relation(s) still present: %', v_left;
  END IF;

  SELECT * INTO v_snap FROM gov89_protected_snapshot;

  -- The public schema itself must still exist, now holding only public.profiles.
  IF to_regnamespace('public') IS NULL THEN
    RAISE EXCEPTION 'GOV-89 abort: schema `public` was dropped.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'GOV-89 abort: public.profiles was dropped.';
  END IF;

  SELECT count(*) INTO v_now FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('r','v','m','p');
  IF v_now <> 1 THEN
    RAISE EXCEPTION 'GOV-89 abort: expected exactly 1 public relation (profiles) after cleanup, found %.', v_now;
  END IF;

  -- public.profiles must be byte-for-byte the same shape and size.
  IF (SELECT count(*) FROM public.profiles) <> v_snap.profiles_rows THEN
    RAISE EXCEPTION 'GOV-89 abort: public.profiles row count changed (% -> %).',
      v_snap.profiles_rows, (SELECT count(*) FROM public.profiles);
  END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='public.profiles'::regclass
        AND attnum>0 AND NOT attisdropped) <> v_snap.profiles_cols THEN
    RAISE EXCEPTION 'GOV-89 abort: public.profiles column set changed.';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.profiles'::regclass) <> v_snap.profiles_cons THEN
    RAISE EXCEPTION 'GOV-89 abort: public.profiles constraint set changed.';
  END IF;

  -- Application schemas must be untouched.
  SELECT count(*) INTO v_now FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='fat' AND c.relkind IN ('r','v','m','p');
  IF v_now <> v_snap.fat_rels THEN
    RAISE EXCEPTION 'GOV-89 abort: fat relation count changed (% -> %).', v_snap.fat_rels, v_now;
  END IF;

  SELECT count(*) INTO v_now FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fat';
  IF v_now <> v_snap.fat_fns THEN
    RAISE EXCEPTION 'GOV-89 abort: fat function count changed (% -> %).', v_snap.fat_fns, v_now;
  END IF;

  SELECT count(*) INTO v_now FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='mica' AND c.relkind IN ('r','v','m','p');
  IF v_now <> v_snap.mica_rels THEN
    RAISE EXCEPTION 'GOV-89 abort: mica relation count changed (% -> %).', v_snap.mica_rels, v_now;
  END IF;

  SELECT count(*) INTO v_now FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='cab' AND c.relkind IN ('r','v','m','p');
  IF v_now <> v_snap.cab_rels THEN
    RAISE EXCEPTION 'GOV-89 abort: cab relation count changed (% -> %).', v_snap.cab_rels, v_now;
  END IF;

  SELECT count(*) INTO v_now FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='shared' AND c.relkind IN ('r','v','m','p');
  IF v_now <> v_snap.shared_rels THEN
    RAISE EXCEPTION 'GOV-89 abort: shared relation count changed (% -> %).', v_snap.shared_rels, v_now;
  END IF;

  -- The four out-of-scope enum types must still be here.
  SELECT count(*) INTO v_now FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
   WHERE n.nspname='public' AND t.typtype='e';
  IF v_now <> v_snap.public_enums THEN
    RAISE EXCEPTION 'GOV-89 abort: public enum types changed (% -> %) — they are out of scope and must survive.',
      v_snap.public_enums, v_now;
  END IF;

  -- auth must be completely untouched, including the FAT user-seed trigger.
  IF (SELECT count(*) FROM auth.users) <> v_snap.auth_users THEN
    RAISE EXCEPTION 'GOV-89 abort: auth.users row count changed (% -> %).',
      v_snap.auth_users, (SELECT count(*) FROM auth.users);
  END IF;

  SELECT count(*) INTO v_now FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' AND NOT t.tgisinternal;
  IF v_now <> v_snap.auth_triggers THEN
    RAISE EXCEPTION 'GOV-89 abort: auth trigger count changed (% -> %).', v_snap.auth_triggers, v_now;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='auth' AND c.relname='users'
                   AND t.tgname='on_auth_user_created_fat' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'GOV-89 abort: the FAT auth seed trigger on_auth_user_created_fat is missing.';
  END IF;

  IF to_regprocedure('fat.handle_new_user()') IS NULL THEN
    RAISE EXCEPTION 'GOV-89 abort: fat.handle_new_user() is missing.';
  END IF;

  RAISE NOTICE 'GOV-89: 5 stale public relations dropped; public.profiles, fat.*, mica.*, cab.*, shared.*, auth.* and all public enum types intact.';
END
$post$;

DROP TABLE IF EXISTS gov89_protected_snapshot;
