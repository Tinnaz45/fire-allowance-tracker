-- ════════════════════════════════════════════════════════════════════════════
-- PROD ROLLOUT — fat.stations canonical FRV cutover
-- Step 99: ROLLBACK
--
-- Reverses 03_canonical_import.sql and 02_schema_extension.sql by restoring
-- the pre-cutover snapshot captured in 01_snapshot_existing.sql.
--
-- Sections are bracketed so you can run only the parts you need:
--   ROLLBACK A — restore station rows (and clear new columns)
--   ROLLBACK B — drop the four new columns (only run if A also runs and you
--                want the schema fully reverted)
--
-- DO NOT run B without A, or you will lose the new column values that 03
-- inserted, but the rows themselves will remain (no rollback of canonical data).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── ROLLBACK A — restore rows from snapshot ────────────────────────────────
BEGIN;

-- Sanity guard — refuse to rollback if no snapshot exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='fat' AND table_name='_stations_pre_frv_backup'
  ) THEN
    RAISE EXCEPTION 'No backup found at fat._stations_pre_frv_backup — refusing to rollback.';
  END IF;
END $$;

-- Wipe canonical rows and restore the snapshot.
DELETE FROM fat.stations;

-- Restore only the columns that existed in the pre-cutover schema. If the
-- backup table has the new district/street_address/suburb/postcode columns
-- (because the snapshot was taken AFTER step 02), they will still be in the
-- backup table but only the original 7 columns are written back here.
INSERT INTO fat.stations
  (id, name, abbreviation, region, is_active, created_at, updated_at)
SELECT id, name, abbreviation, region, is_active, created_at, updated_at
FROM fat._stations_pre_frv_backup;

COMMIT;

-- ─── ROLLBACK B — drop the four new columns (OPTIONAL) ──────────────────────
-- Only run if you want to revert the schema shape as well as the data.
-- ALTER TABLE fat.stations
--   DROP COLUMN IF EXISTS district,
--   DROP COLUMN IF EXISTS street_address,
--   DROP COLUMN IF EXISTS suburb,
--   DROP COLUMN IF EXISTS postcode;

-- ─── Cleanup (run only after confirming rollback succeeded) ─────────────────
-- DROP TABLE IF EXISTS fat._stations_pre_frv_backup;
