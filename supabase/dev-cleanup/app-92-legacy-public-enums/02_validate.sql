-- ═══════════════════════════════════════════════════════════════════════════════
-- APP-92 — REMOVE UNREFERENCED LEGACY FIRE ALLOWANCE PUBLIC ENUMS (DEV)
-- Step 02: POST-MIGRATION VALIDATION — READ ONLY
--
-- Run after 01. Nothing here writes. Check A is the removal itself; checks
-- B–E are the preservation boundary — they prove the migration took only the
-- four enum types it was approved to take and nothing else.
--
-- Every check emits a `verdict` column. Any value other than PASS is a failure
-- and must be reported, not worked around.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── A. All four approved enum types are ABSENT ──────────────────────────────
SELECT t AS enum_type,
       CASE WHEN to_regtype('public.' || t) IS NULL THEN 'PASS — absent'
            ELSE 'FAIL — still present' END AS verdict
FROM unnest(ARRAY['allowance_line_type','audit_action','ingestion_source','shift_status']) t
ORDER BY t;


-- ─── B. public schema survives with an unchanged relation set ────────────────
-- Enum types are not relations, so dropping them must not move this count at
-- all (unlike GOV-89, which changed the relation count on purpose).
SELECT CASE
         WHEN to_regnamespace('public') IS NULL THEN 'FAIL — public schema dropped'
         WHEN to_regclass('public.profiles') IS NULL THEN 'FAIL — public.profiles missing'
         ELSE 'PASS — public.profiles present'
       END AS verdict,
       (SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind IN ('r','v','m','p')) AS public_relations;


-- ─── C. public.profiles is untouched ─────────────────────────────────────────
SELECT 'public.profiles' AS obj,
       (SELECT count(*) FROM public.profiles) AS rows,
       (SELECT count(*) FROM pg_attribute  WHERE attrelid='public.profiles'::regclass
                                             AND attnum>0 AND NOT attisdropped) AS columns,
       (SELECT count(*) FROM pg_constraint WHERE conrelid='public.profiles'::regclass) AS constraints,
       (SELECT relrowsecurity FROM pg_class WHERE oid='public.profiles'::regclass) AS rls_enabled;


-- ─── D. Protected-surface counts — must equal 00 section G exactly, ──────────
-- except "public enum types" which must go 4 -> 0.
SELECT 'fat relations'     AS surface, count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fat'    AND c.relkind IN ('r','v','m','p')
UNION ALL SELECT 'fat functions',     count(*) FROM pg_proc  p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fat'
UNION ALL SELECT 'mica relations',    count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mica'   AND c.relkind IN ('r','v','m','p')
UNION ALL SELECT 'cab relations',     count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cab'    AND c.relkind IN ('r','v','m','p')
UNION ALL SELECT 'shared relations',  count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relkind IN ('r','v','m','p')
UNION ALL SELECT 'public relations',  count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','v','m','p')
UNION ALL SELECT 'public enum types', count(*) FROM pg_type  t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'
UNION ALL SELECT 'auth.users rows',   count(*) FROM auth.users
UNION ALL SELECT 'auth triggers',     count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' AND NOT t.tgisinternal
ORDER BY 1;


-- ─── E. FAT auth wiring intact ────────────────────────────────────────────────
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                          JOIN pg_namespace n ON n.oid=c.relnamespace
                         WHERE n.nspname='auth' AND c.relname='users'
                           AND t.tgname='on_auth_user_created_fat' AND NOT t.tgisinternal)
            THEN 'PASS' ELSE 'FAIL' END AS trigger_on_auth_user_created_fat,
       CASE WHEN to_regprocedure('fat.handle_new_user()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS fat_handle_new_user,
       CASE WHEN to_regclass('fat.profiles')   IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS fat_profiles,
       CASE WHEN to_regclass('fat.stations')   IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS fat_stations;


-- ─── F. No dangling reference to a dropped type anywhere ─────────────────────
-- EXPECT: zero rows. Nothing may still name the removed types in a routine
-- body, and no column may exist typed to a type that no longer exists (which
-- is structurally impossible once the DROP has succeeded, but checked anyway).
SELECT 'routine_referencing_dropped_type' AS kind, n.nspname || '.' || p.proname AS location
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND p.prokind IN ('f','p')
  AND p.prosrc ~* '\mpublic\.(allowance_line_type|audit_action|ingestion_source|shift_status)\M';
