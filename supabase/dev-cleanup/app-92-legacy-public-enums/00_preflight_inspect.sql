-- ═══════════════════════════════════════════════════════════════════════════════
-- APP-92 — REMOVE UNREFERENCED LEGACY FIRE ALLOWANCE PUBLIC ENUMS (DEV)
-- Step 00: PREFLIGHT INSPECT — READ ONLY
--
-- Run this FIRST, against DEV (kctctvpobbizhkiqkgqw), and read every result
-- before running 01. Nothing here writes. Its job is to prove — not assume —
-- that the four enum types GOV-89 deliberately left behind are still
-- unreferenced by anything, anywhere in the database.
--
-- The drop set (exactly four, no more):
--   public.allowance_line_type
--   public.audit_action
--   public.ingestion_source
--   public.shift_status
--
-- STOP and report if any query below returns something other than the
-- documented expectation. Do not "fix" a mismatch by widening the drop set.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── A. The four types exist, with these exact labels ────────────────────────
-- EXPECT: exactly 4 rows, one per type, labels matching GOV-89's
-- 99_recover.sql definitions (this is also the source of truth this package's
-- own 99_recover.sql replays from).
WITH t AS (
  SELECT ty.oid, ty.typname, n.nspname
  FROM pg_type ty JOIN pg_namespace n ON n.oid = ty.typnamespace
  WHERE n.nspname = 'public' AND ty.typtype = 'e'
    AND ty.typname IN ('allowance_line_type','audit_action','ingestion_source','shift_status')
)
SELECT t.nspname || '.' || t.typname AS enum_type,
       (SELECT string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder)
          FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels
FROM t ORDER BY 1;


-- ─── B. Any column, in ANY schema, still typed as one of these four? ─────────
-- EXPECT: zero rows. This is the authoritative "is anything still using this
-- type" check — a live column typed to an enum is what would make a drop
-- destructive, and no CASCADE will ever be used to push past this.
SELECT n.nspname AS schema, c.relname AS relation, a.attname AS column,
       ty.typname AS enum_type
FROM pg_attribute a
JOIN pg_class     c  ON c.oid  = a.attrelid
JOIN pg_namespace n  ON n.oid  = c.relnamespace
JOIN pg_type      ty ON ty.oid = a.atttypid
WHERE ty.typname IN ('allowance_line_type','audit_action','ingestion_source','shift_status')
  AND a.attnum > 0 AND NOT a.attisdropped;


-- ─── C. Any function/procedure body, in ANY schema, naming these types ───────
-- EXPECT: zero rows. Deliberately broader than GOV-89's equivalent check (which
-- excluded platform schemas) — this scans every schema in the database,
-- because DEV is shared across multiple apps (fat, mica, cab, shared,
-- daily_emom, snowmen, ...) and a cross-app consumer must not be missed.
SELECT n.nspname AS schema, p.proname AS routine
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND p.prokind IN ('f','p')
  AND p.prosrc ~* '\m(allowance_line_type|audit_action|ingestion_source|shift_status)\M';


-- ─── D. Any check constraint / domain, anywhere, referencing these types ─────
-- EXPECT: zero rows.
SELECT conrelid::regclass AS table_or_domain, conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE pg_get_constraintdef(oid) ~* '\m(allowance_line_type|audit_action|ingestion_source|shift_status)\M';


-- ─── E. Full pg_depend sweep on the four type OIDs ────────────────────────────
-- EXPECT: only `deptype = 'i'` (internal) rows against `pg_type` itself — that
-- is Postgres' automatic bookkeeping between an enum and its own
-- implicitly-created array type (e.g. `_allowance_line_type`), not an external
-- consumer. ANY row with a different classid (pg_proc, pg_class, pg_rewrite,
-- pg_constraint, pg_cast, ...) or a non-'i' deptype means something still
-- depends on the type. STOP if that happens.
SELECT DISTINCT d.classid::regclass AS dependent_catalog, d.objid, d.deptype,
       ty.typname AS enum_type
FROM pg_type ty
JOIN pg_namespace tn ON tn.oid = ty.typnamespace
JOIN pg_depend d ON d.refobjid = ty.oid AND d.refclassid = 'pg_type'::regclass
WHERE tn.nspname = 'public'
  AND ty.typname IN ('allowance_line_type','audit_action','ingestion_source','shift_status')
ORDER BY 4, 1;


-- ─── F. Ownership and grants on the four types ────────────────────────────────
-- Recorded for the report. NULL acl means default type privileges apply
-- (PUBLIC USAGE), same as any ordinary Postgres enum — nothing bespoke to
-- preserve on recreation.
SELECT n.nspname || '.' || t.typname AS enum_type,
       pg_get_userbyid(t.typowner) AS owner,
       t.typacl::text AS acl
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
  AND t.typname IN ('allowance_line_type','audit_action','ingestion_source','shift_status');


-- ─── G. Protected-surface baseline ────────────────────────────────────────────
-- Capture these numbers. 02_validate.sql re-runs the identical query after the
-- migration; every count must be unchanged except "public enum types" (4 -> 0).
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
