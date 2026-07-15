-- ─── Rename: station 60 → "Training Academy" ────────────────────────────────
-- Station id 60 (FS60) is named "Training Academy" everywhere it appears in the
-- app (Profile/Rostered, station search, Recall/Standby/M&D pickers, filters and
-- badges).
--
-- All user-facing labels are derived from fat.stations.name keyed by the
-- station id (see lib/distance/stationParser.js displayLabelForStation), so a
-- single name update propagates to every screen. Nothing else changes:
--   • id stays 60 (identity is carried by the numeric id, never the label)
--   • abbreviation stays 'FS60' (the bold "FS60" code shown beside the name)
--   • district / address / postcode / matrix cells / allowance logic untouched
--
-- No denormalized caches or historical snapshots depend on the prior name:
-- profile_ext.rostered_station_label is write-only (hydration re-derives from
-- fat.stations) and no recalls/standby/spoilt_meals/operational_claims label
-- snapshots reference station 60 by its old text. This is therefore a pure
-- display-name update.
--
-- Idempotent and enforcing: keyed on the stable station id, so re-running always
-- leaves id 60 named "Training Academy" regardless of its current value.
-- ─────────────────────────────────────────────────────────────────────────────

update fat.stations
   set name       = 'Training Academy',
       updated_at = now()
 where id = 60
   and name is distinct from 'Training Academy';
