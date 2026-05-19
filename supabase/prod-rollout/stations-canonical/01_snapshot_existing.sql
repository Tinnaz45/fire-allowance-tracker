-- ════════════════════════════════════════════════════════════════════════════
-- PROD ROLLOUT — fat.stations canonical FRV cutover
-- Step 01: SNAPSHOT existing PROD fat.stations into fat._stations_pre_frv_backup
-- This is the durable rollback source. Idempotent — re-running is safe.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Backup full pre-cutover state (including any columns added later)
DROP TABLE IF EXISTS fat._stations_pre_frv_backup;

CREATE TABLE fat._stations_pre_frv_backup AS
SELECT *, now() AS _snapshot_at FROM fat.stations;

-- Sanity-check: row count must equal current fat.stations rowcount
SELECT
  (SELECT count(*) FROM fat.stations)                 AS live_rows,
  (SELECT count(*) FROM fat._stations_pre_frv_backup) AS backup_rows;

COMMIT;
