-- ════════════════════════════════════════════════════════════════════════════
-- PROD ROLLOUT — fat.stations canonical FRV cutover
-- Step 02: ADDITIVE SCHEMA EXTENSION
--
-- Adds four nullable text columns to fat.stations:
--   district, street_address, suburb, postcode
--
-- - No existing columns are altered or dropped.
-- - No constraints are added.
-- - Primary key, FKs, RLS, triggers, grants — all preserved.
-- - Existing runtime queries (app selects id, name, abbreviation) are unaffected.
-- - Rollback is a clean DROP COLUMN (see 99_rollback.sql).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE fat.stations
  ADD COLUMN IF NOT EXISTS district       text,
  ADD COLUMN IF NOT EXISTS street_address text,
  ADD COLUMN IF NOT EXISTS suburb         text,
  ADD COLUMN IF NOT EXISTS postcode       text;

COMMENT ON COLUMN fat.stations.district       IS 'FRV operational district (e.g. Central, Western 2, North & West Regional).';
COMMENT ON COLUMN fat.stations.street_address IS 'Street number + street name only (no suburb/postcode).';
COMMENT ON COLUMN fat.stations.suburb         IS 'Suburb component of station address.';
COMMENT ON COLUMN fat.stations.postcode       IS '4-digit Australian postcode for the station address.';

-- Verify shape post-migration
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='fat' AND table_name='stations'
ORDER BY ordinal_position;
