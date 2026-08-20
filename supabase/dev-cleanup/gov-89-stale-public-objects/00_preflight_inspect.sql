-- ═══════════════════════════════════════════════════════════════════════════════
-- GOV-89 — REMOVE STALE FIRE ALLOWANCE PUBLIC-SCHEMA OBJECTS (DEV)
-- Step 00: PREFLIGHT INSPECT — READ ONLY
--
-- Run this FIRST, against DEV (kctctvpobbizhkiqkgqw), and read every result
-- before running 01. Nothing here writes. Its job is to prove — not assume —
-- that the five approved objects are safe to drop and that the removal order
-- in 01 is the correct one.
--
-- The drop set (exactly five, no more):
--   public.allowance_breakdowns
--   public.audit_logs
--   public.calculation_snapshots
--   public.engine_versions
--   public.shifts
--
-- STOP and report if any query below returns something other than the
-- documented expectation. Do not "fix" a mismatch by widening the drop set.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── A. Which relations does `public` actually hold? ─────────────────────────
-- EXPECT: exactly six rows — the five in the drop set, plus public.profiles,
-- which is the preservation boundary and must survive untouched.
SELECT c.relkind,
       n.nspname || '.' || c.relname AS obj,
       pg_catalog.pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r','v','m','p','f')
ORDER BY c.relkind, c.relname;


-- ─── B. Row counts ───────────────────────────────────────────────────────────
-- Recorded so the recovery artifact (99) can be checked for completeness.
-- These are legacy rows, NOT Fire Allowance Tracker runtime data.
SELECT 'allowance_breakdowns'      AS tbl, count(*) AS rows FROM public.allowance_breakdowns
UNION ALL SELECT 'audit_logs',             count(*) FROM public.audit_logs
UNION ALL SELECT 'calculation_snapshots',  count(*) FROM public.calculation_snapshots
UNION ALL SELECT 'engine_versions',        count(*) FROM public.engine_versions
UNION ALL SELECT 'shifts',                 count(*) FROM public.shifts
UNION ALL SELECT 'PROTECTED public.profiles', count(*) FROM public.profiles
ORDER BY 1;


-- ─── C. Every foreign key touching the drop set, in BOTH directions ──────────
-- This is the query that establishes the removal order, and the one that would
-- catch a still-live owner.
--
-- EXPECT exactly 8 rows:
--   4 OUTBOUND to auth.users (allowance_breakdowns, audit_logs,
--     calculation_snapshots, shifts — all ON DELETE SET NULL). Outbound FKs do
--     not block a drop and do not modify auth.users; they simply cease to exist
--     with their child table.
--   4 INBOUND, every one of them originating INSIDE the drop set:
--     allowance_breakdowns -> calculation_snapshots
--     allowance_breakdowns -> shifts
--     calculation_snapshots -> engine_versions
--     calculation_snapshots -> shifts
--
-- If ANY row shows a child_table outside the drop set pointing INTO it, that
-- object is still owned by something. STOP.
SELECT con.conname,
       cn.nspname || '.' || cl.relname  AS child_table,
       fn.nspname || '.' || fl.relname  AS parent_table,
       pg_get_constraintdef(con.oid)    AS def
FROM pg_constraint con
JOIN pg_class     cl ON cl.oid = con.conrelid
JOIN pg_namespace cn ON cn.oid = cl.relnamespace
JOIN pg_class     fl ON fl.oid = con.confrelid
JOIN pg_namespace fn ON fn.oid = fl.relnamespace
WHERE con.contype = 'f'
  AND (
       (cn.nspname = 'public' AND cl.relname IN ('allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts'))
    OR (fn.nspname = 'public' AND fl.relname IN ('allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts'))
  )
ORDER BY parent_table, child_table, con.conname;


-- ─── D. Any view / materialized view / rule depending on the drop set ────────
-- EXPECT: zero rows. A dependent view is exactly what a blind CASCADE would
-- silently destroy, which is why this task forbids CASCADE.
SELECT DISTINCT
       dn.nspname || '.' || dc.relname AS dependent_obj,
       dc.relkind,
       sn.nspname || '.' || sc.relname AS depends_on
FROM pg_depend d
JOIN pg_rewrite   r  ON r.oid  = d.objid
JOIN pg_class     dc ON dc.oid = r.ev_class
JOIN pg_namespace dn ON dn.oid = dc.relnamespace
JOIN pg_class     sc ON sc.oid = d.refobjid
JOIN pg_namespace sn ON sn.oid = sc.relnamespace
WHERE d.classid    = 'pg_rewrite'::regclass
  AND d.refclassid = 'pg_class'::regclass
  AND sn.nspname   = 'public'
  AND sc.relname IN ('allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts')
  AND dc.oid <> sc.oid;


-- ─── E. Any function/procedure whose body names the drop set ─────────────────
-- EXPECT: zero rows. Confirms no fat.*, mica.*, cab.* or shared.* routine reads
-- or writes these tables.
SELECT n.nspname || '.' || p.proname AS fn, p.prokind
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema','extensions','graphql',
                        'realtime','storage','vault','net','cron','pgbouncer')
  AND (p.prosrc ~* '\m(allowance_breakdowns|calculation_snapshots|engine_versions)\M'
       OR p.prosrc ~* '\m(audit_logs|shifts)\M')
ORDER BY 1;


-- ─── F. Triggers, RLS state, policies, and realtime publication membership ───
-- EXPECT: no triggers, no publication rows. RLS enabled = true on all five with
-- their owner-scoped policies. Policies and indexes are INTERNAL dependencies of
-- their table — they are removed with it and do NOT require CASCADE.
SELECT 'trigger' AS kind, c.relname AS obj, t.tgname AS detail, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
  AND c.relname IN ('allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts')
UNION ALL
SELECT 'policy', c.relname, pol.polname,
       'cmd=' || pol.polcmd::text
       || ' | using='  || coalesce(pg_get_expr(pol.polqual,      pol.polrelid), '-')
       || ' | check='  || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-')
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts')
UNION ALL
SELECT 'rls_enabled', c.relname, c.relrowsecurity::text, ''
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts')
UNION ALL
SELECT 'publication', c.relname, p.pubname, ''
FROM pg_publication_rel pr
JOIN pg_publication p ON p.oid = pr.prpubid
JOIN pg_class c ON c.oid = pr.prrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts')
ORDER BY 1, 2, 3;


-- ─── G. Enum types used by the drop set — OUT OF SCOPE, MUST SURVIVE ─────────
-- public.allowance_line_type, public.audit_action, public.ingestion_source and
-- public.shift_status are used ONLY by the five tables. They are NOT named in
-- GOV-89's approved scope, so 01 deliberately leaves them in place. They become
-- unreferenced after the drop; that is a separate, independently meaningful
-- discovery and belongs to its own Linear Issue — not to this one.
WITH t AS (
  SELECT ty.oid, ty.typname, n.nspname
  FROM pg_type ty JOIN pg_namespace n ON n.oid = ty.typnamespace
  WHERE n.nspname = 'public' AND ty.typtype = 'e'
)
SELECT t.nspname || '.' || t.typname AS enum_type,
       (SELECT string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder)
          FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels,
       coalesce((SELECT string_agg(DISTINCT cn.nspname || '.' || c.relname, ', ')
                   FROM pg_attribute a
                   JOIN pg_class c      ON c.oid  = a.attrelid
                   JOIN pg_namespace cn ON cn.oid = c.relnamespace
                  WHERE a.atttypid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
                    AND c.relkind IN ('r','v','m','p')), '(no columns)') AS used_by
FROM t ORDER BY 1;


-- ─── H. Protected-surface baseline ───────────────────────────────────────────
-- Capture these numbers. 02_validate.sql re-runs the identical query after the
-- migration; every count must be unchanged.
SELECT 'fat relations'      AS surface, count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fat'   AND c.relkind IN ('r','v','m','p')
UNION ALL SELECT 'fat functions',      count(*) FROM pg_proc  p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fat'
UNION ALL SELECT 'mica relations',     count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mica'  AND c.relkind IN ('r','v','m','p')
UNION ALL SELECT 'cab relations',      count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cab'   AND c.relkind IN ('r','v','m','p')
UNION ALL SELECT 'shared relations',   count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared'AND c.relkind IN ('r','v','m','p')
UNION ALL SELECT 'public relations',   count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'AND c.relkind IN ('r','v','m','p')
UNION ALL SELECT 'public enum types',  count(*) FROM pg_type  t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'
UNION ALL SELECT 'auth.users rows',    count(*) FROM auth.users
UNION ALL SELECT 'auth triggers',      count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' AND NOT t.tgisinternal
ORDER BY 1;
