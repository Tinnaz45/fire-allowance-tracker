-- ════════════════════════════════════════════════════════════════════════════
-- PROD ROLLOUT — fat.stations canonical FRV cutover
-- Step 00: PRE-FLIGHT INSPECTION (read-only)
-- Run this first. Read every result before continuing to step 01.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Current schema shape (expect: id INT PK, name, abbreviation, region, is_active, timestamps)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='fat' AND table_name='stations'
ORDER BY ordinal_position;

-- 2. Current rowcount, id range, distinct counts
SELECT count(*) AS rows,
       count(DISTINCT id) AS distinct_ids,
       min(id) AS min_id,
       max(id) AS max_id,
       sum(CASE WHEN is_active THEN 1 ELSE 0 END) AS active_rows
FROM fat.stations;

-- 3. Existing FK references TO fat.stations (expect: only fat.profile_ext.station_id)
SELECT tc.table_schema   AS referencing_schema,
       tc.table_name     AS referencing_table,
       kcu.column_name   AS referencing_column,
       rc.delete_rule, rc.update_rule
FROM information_schema.referential_constraints rc
JOIN information_schema.table_constraints tc
  ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = rc.unique_constraint_name AND ccu.constraint_schema = rc.unique_constraint_schema
WHERE ccu.table_schema = 'fat' AND ccu.table_name = 'stations';

-- 4. Inventory of EVERY claim/profile row currently holding a station id (numerical, even where FK is set null).
--    Use this BEFORE cutover to know which user references will need remapping if the existing station IDs
--    are derived from bad DEV data rather than canonical FRV numbers.
WITH used AS (
  SELECT 'profile_ext'      AS tbl, station_id      AS sid FROM fat.profile_ext   WHERE station_id      IS NOT NULL
  UNION ALL SELECT 'recalls.rostered', rostered_stn_id  FROM fat.recalls         WHERE rostered_stn_id  IS NOT NULL
  UNION ALL SELECT 'recalls.recall',   recall_stn_id    FROM fat.recalls         WHERE recall_stn_id    IS NOT NULL
  UNION ALL SELECT 'retain',           station_id       FROM fat.retain          WHERE station_id       IS NOT NULL
  UNION ALL SELECT 'standby.rostered', rostered_stn_id  FROM fat.standby         WHERE rostered_stn_id  IS NOT NULL
  UNION ALL SELECT 'standby.standby',  standby_stn_id   FROM fat.standby         WHERE standby_stn_id   IS NOT NULL
  UNION ALL SELECT 'spoilt.station',   station_id       FROM fat.spoilt_meals    WHERE station_id       IS NOT NULL
  UNION ALL SELECT 'spoilt.claim',     claim_stn_id     FROM fat.spoilt_meals    WHERE claim_stn_id     IS NOT NULL
)
SELECT tbl, sid, count(*) AS row_count
FROM used
GROUP BY tbl, sid
ORDER BY tbl, sid;

-- 5. Spot-check: do the currently-stored station ids look canonical (FRV) or stale (DEV-derived)?
SELECT id, name, abbreviation FROM fat.stations ORDER BY id;
