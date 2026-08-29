-- ═══════════════════════════════════════════════════════════════════════════════
-- APP-92 — REMOVE UNREFERENCED LEGACY FIRE ALLOWANCE PUBLIC ENUMS (DEV)
-- Step 99: RECOVERY / ROLLBACK
--
-- Reverses 01_drop_legacy_public_enums.sql by recreating the four enum types
-- with the exact labels captured live from DEV (kctctvpobbizhkiqkgqw) by this
-- package's own 00_preflight_inspect.sql section A, immediately before the
-- drop. These labels are also byte-identical to the ones GOV-89's
-- 99_recover.sql already carries (../gov-89-stale-public-objects/99_recover.sql),
-- since GOV-89 captured the same four types.
--
-- WHY THIS IS SUFFICIENT
-- Unlike GOV-89's recovery, there is no data to replay: an enum type has no
-- rows of its own, and 00/01 already proved nothing else in the database used
-- these types. Recreating the type with its original labels, in its original
-- schema, fully reverses the drop — there is no dependent column, constraint,
-- or row to restore alongside it, because nothing referenced them.
--
-- GRANTS: typacl was NULL for all four before the drop (00 section F) — i.e.
-- only Postgres' default type privileges (PUBLIC USAGE) applied. Recreating
-- the type re-establishes that same default automatically; no explicit GRANT
-- is replayed here.
--
-- DEV ONLY. Do not run against PRODUCTION (PROD never had this migration
-- applied — it still carries these types via its own live tables).
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── Guard: refuse to recover over a live type ────────────────────────────────
DO $guard$
DECLARE v_present text;
BEGIN
  SELECT string_agg('public.' || t, ', ' ORDER BY t) INTO v_present
  FROM unnest(ARRAY['allowance_line_type','audit_action','ingestion_source','shift_status']) t
  WHERE to_regtype('public.' || t) IS NOT NULL;
  IF v_present IS NOT NULL THEN
    RAISE EXCEPTION 'APP-92 recovery abort: these types already exist: %. Drop them first or you will not get a clean restore.', v_present;
  END IF;
END
$guard$;


-- ─── Recreate the four enum types with their captured labels ─────────────────
CREATE TYPE public.allowance_line_type AS ENUM
  ('ordinary','saturday','sunday','public_holiday','overtime_1_5x','overtime_2x',
   'on_call','non_rostered_on_call','call_out','ph_call_out','call_back',
   'fbt_draft','fbt_submitted');

CREATE TYPE public.audit_action AS ENUM
  ('shift_created','shift_updated','shift_archived','snapshot_created',
   'breakdown_written','export_generated','import_completed');

CREATE TYPE public.ingestion_source AS ENUM
  ('manual','ocr_upload','etcs_parse','ai_draft','batch_import','system');

CREATE TYPE public.shift_status AS ENUM ('draft','confirmed','archived');


-- ─── Verify the restore ───────────────────────────────────────────────────────
DO $verify$
DECLARE v_missing text; v_n integer;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO v_missing
  FROM unnest(ARRAY['allowance_line_type','audit_action','ingestion_source','shift_status']) t
  WHERE to_regtype('public.' || t) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'APP-92 recovery abort: type(s) not restored: %', v_missing;
  END IF;

  SELECT count(*) INTO v_n FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
   WHERE n.nspname='public' AND t.typtype='e'
     AND t.typname IN ('allowance_line_type','audit_action','ingestion_source','shift_status');
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'APP-92 recovery abort: expected 4 restored enum types, found %.', v_n;
  END IF;

  RAISE NOTICE 'APP-92 recovery: all 4 enum types restored with their captured labels.';
END
$verify$;

COMMIT;
