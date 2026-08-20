-- ═══════════════════════════════════════════════════════════════════════════════
-- GOV-89 — REMOVE STALE FIRE ALLOWANCE PUBLIC-SCHEMA OBJECTS (DEV)
-- Step 02: POST-MIGRATION VALIDATION — READ ONLY
--
-- Run after 01. Nothing here writes. Check A is the removal itself; checks B–G
-- are the preservation boundary — they prove the migration took the five objects
-- it was approved to take and nothing else.
--
-- Every check emits a `verdict` column. Any value other than PASS is a failure
-- and must be reported, not worked around.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── A. All five approved objects are ABSENT ─────────────────────────────────
SELECT t AS object,
       CASE WHEN to_regclass('public.' || t) IS NULL THEN 'PASS — absent'
            ELSE 'FAIL — still present' END AS verdict
FROM unnest(ARRAY['allowance_breakdowns','audit_logs','calculation_snapshots',
                  'engine_versions','shifts']) t
ORDER BY t;


-- ─── B. public schema survives and holds ONLY public.profiles ────────────────
SELECT CASE
         WHEN to_regnamespace('public') IS NULL THEN 'FAIL — public schema dropped'
         WHEN to_regclass('public.profiles') IS NULL THEN 'FAIL — public.profiles missing'
         WHEN (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='public' AND c.relkind IN ('r','v','m','p')) = 1
           THEN 'PASS — public holds exactly public.profiles'
         ELSE 'FAIL — unexpected relation count in public'
       END AS verdict,
       (SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind IN ('r','v','m','p')) AS public_relations;


-- ─── C. public.profiles is untouched ─────────────────────────────────────────
-- Compare against the values 00 recorded. EXPECT 2 rows.
SELECT 'public.profiles' AS obj,
       (SELECT count(*) FROM public.profiles) AS rows,
       (SELECT count(*) FROM pg_attribute  WHERE attrelid='public.profiles'::regclass
                                             AND attnum>0 AND NOT attisdropped) AS columns,
       (SELECT count(*) FROM pg_constraint WHERE conrelid='public.profiles'::regclass) AS constraints,
       (SELECT relrowsecurity FROM pg_class WHERE oid='public.profiles'::regclass) AS rls_enabled;


-- ─── D. Protected-surface counts — must equal 00 section H exactly ───────────
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


-- ─── E. FAT auth wiring intact ───────────────────────────────────────────────
-- The user-seed path FAT owns on auth.users must be exactly as it was.
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                          JOIN pg_namespace n ON n.oid=c.relnamespace
                         WHERE n.nspname='auth' AND c.relname='users'
                           AND t.tgname='on_auth_user_created_fat' AND NOT t.tgisinternal)
            THEN 'PASS' ELSE 'FAIL' END AS trigger_on_auth_user_created_fat,
       CASE WHEN to_regprocedure('fat.handle_new_user()')          IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS fat_handle_new_user,
       CASE WHEN to_regprocedure('fat.increment_claim_sequence(uuid,uuid,text)') IS NOT NULL THEN 'PASS' ELSE 'CHECK — signature differs' END AS fat_increment_claim_sequence,
       CASE WHEN to_regclass('fat.profiles')   IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS fat_profiles,
       CASE WHEN to_regclass('fat.stations')   IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS fat_stations;


-- ─── F. No dangling reference to a dropped object anywhere ───────────────────
-- EXPECT: zero rows. Nothing may still point at the removed relations.
SELECT 'orphan_fk' AS kind, con.conname AS name,
       src_ns.nspname || '.' || src.relname AS location
FROM pg_constraint con
JOIN pg_class src ON src.oid = con.conrelid
JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
WHERE con.contype='f' AND con.confrelid = 0
UNION ALL
SELECT 'routine_referencing_dropped_object', n.nspname || '.' || p.proname, n.nspname
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('fat','mica','cab','shared','public')
  AND (p.prosrc ~* '\mpublic\.(allowance_breakdowns|audit_logs|calculation_snapshots|engine_versions|shifts)\M');


-- ─── G. The four out-of-scope enum types are still present ───────────────────
-- GOV-89 approved five RELATIONS. These types were left deliberately. They are
-- now unreferenced — an out-of-scope discovery for a separate Issue, not a
-- failure of this one.
SELECT t AS enum_type,
       CASE WHEN to_regtype('public.' || t) IS NOT NULL THEN 'PASS — preserved'
            ELSE 'FAIL — removed out of scope' END AS verdict,
       coalesce((SELECT string_agg(DISTINCT cn.nspname || '.' || c.relname, ', ')
                   FROM pg_attribute a
                   JOIN pg_class c      ON c.oid  = a.attrelid
                   JOIN pg_namespace cn ON cn.oid = c.relnamespace
                  WHERE a.atttypid = to_regtype('public.' || t)
                    AND a.attnum > 0 AND NOT a.attisdropped
                    AND c.relkind IN ('r','v','m','p')),
                '(now unreferenced — see out-of-scope note)') AS used_by
FROM unnest(ARRAY['allowance_line_type','audit_action','ingestion_source','shift_status']) t
ORDER BY t;
