-- ════════════════════════════════════════════════════════════════════════════
-- PROD ROLLOUT — fat.stations canonical FRV cutover
-- Step 04: POST-CUTOVER VALIDATION (read-only)
--
-- Every check below must pass before declaring the import successful.
-- The "expected" comments show DEV baseline values from 2026-05-18.
-- ════════════════════════════════════════════════════════════════════════════

-- A. Cardinality (expected: total=82, active=82, distinct ids=82, min=1, max=96)
SELECT
  (SELECT count(*)            FROM fat.stations)                                AS total_rows,
  (SELECT count(*)            FROM fat.stations WHERE is_active)                AS active_rows,
  (SELECT count(DISTINCT id)  FROM fat.stations)                                AS distinct_ids,
  (SELECT count(DISTINCT abbreviation) FROM fat.stations)                       AS distinct_abbrevs,
  (SELECT count(DISTINCT name)         FROM fat.stations)                       AS distinct_names,
  (SELECT min(id)             FROM fat.stations)                                AS min_id,
  (SELECT max(id)             FROM fat.stations)                                AS max_id;

-- B. Field completeness (every expected zero)
SELECT
  (SELECT count(*) FROM fat.stations WHERE district       IS NULL OR district       = '') AS missing_district,
  (SELECT count(*) FROM fat.stations WHERE street_address IS NULL OR street_address = '') AS missing_street,
  (SELECT count(*) FROM fat.stations WHERE suburb         IS NULL OR suburb         = '') AS missing_suburb,
  (SELECT count(*) FROM fat.stations WHERE postcode !~ '^[0-9]{4}$')                      AS bad_postcode,
  (SELECT count(*) FROM fat.stations WHERE abbreviation !~ '^FS[0-9]{2}$')                AS bad_abbrev;

-- C. Gap parity vs FRV spreadsheet (expected: gaps_match = TRUE)
WITH expected_gaps(g) AS (
  VALUES (17),(21),(36),(37),(49),(65),(69),(74),(75),(76),(77),(78),(79),(83)
)
SELECT
  (SELECT array_agg(s ORDER BY s)
     FROM generate_series(1,96) s
     LEFT JOIN fat.stations st ON st.id = s
     WHERE st.id IS NULL) = (SELECT array_agg(g ORDER BY g) FROM expected_gaps) AS gaps_match;

-- D. District distribution (expected nine districts; DEV baseline counts):
--    Central=12, Eastern=11, North & West Regional=6, Northern=12,
--    Southern 1=9, Southern 2=8, Western 1=9, Western 2=10, Western 3=5
SELECT district, count(*) AS n FROM fat.stations GROUP BY district ORDER BY district;

-- E. FK safety: no profile_ext rows orphaned by the cutover (expected: 0)
SELECT count(*) AS orphaned_profile_ext
FROM fat.profile_ext p
LEFT JOIN fat.stations s ON s.id = p.station_id
WHERE p.station_id IS NOT NULL AND s.id IS NULL;

-- F. Non-FK reference safety: any historical claim rows pointing at ids that
--    no longer exist? Expected zero if pre-flight inventory was clean.
WITH used AS (
  SELECT 'recalls.rostered' AS tbl, rostered_stn_id AS sid FROM fat.recalls      WHERE rostered_stn_id IS NOT NULL
  UNION ALL SELECT 'recalls.recall', recall_stn_id      FROM fat.recalls         WHERE recall_stn_id   IS NOT NULL
  UNION ALL SELECT 'retain',         station_id          FROM fat.retain          WHERE station_id      IS NOT NULL
  UNION ALL SELECT 'standby.rostered', rostered_stn_id  FROM fat.standby         WHERE rostered_stn_id IS NOT NULL
  UNION ALL SELECT 'standby.standby',  standby_stn_id   FROM fat.standby         WHERE standby_stn_id  IS NOT NULL
  UNION ALL SELECT 'spoilt.station',   station_id       FROM fat.spoilt_meals    WHERE station_id      IS NOT NULL
  UNION ALL SELECT 'spoilt.claim',     claim_stn_id     FROM fat.spoilt_meals    WHERE claim_stn_id    IS NOT NULL
)
SELECT u.tbl, u.sid, count(*) AS rows_pointing_at_missing_id
FROM used u
LEFT JOIN fat.stations s ON s.id = u.sid
WHERE s.id IS NULL
GROUP BY u.tbl, u.sid
ORDER BY u.tbl, u.sid;

-- G. Runtime selector parity — simulates app reads
SELECT id, name, abbreviation FROM fat.stations WHERE is_active = true ORDER BY id LIMIT 5;
