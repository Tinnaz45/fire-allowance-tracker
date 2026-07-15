-- ─── Rename: station 60 "VEMTC" → "Training Academy" ─────────────────────────
-- The rostered station formerly displayed as "FS60 - VEMTC" is renamed to
-- "FS60 - Training Academy" everywhere it appears in the app (Profile/Rostered,
-- station search, Recall/Standby/M&D pickers, filters and badges).
--
-- All user-facing labels are derived from fat.stations.name keyed by the
-- station id (see lib/distance/stationParser.js displayLabelForStation), so a
-- single name update propagates to every screen. Nothing else changes:
--   • id stays 60 (identity is carried by the numeric id, never the label)
--   • abbreviation stays 'FS60' (the bold "FS60" code shown beside the name)
--   • district / address / postcode / matrix cells / allowance logic untouched
--
-- No denormalized caches or historical snapshots hold the old text: profile_ext
-- .rostered_station_label is write-only (hydration re-derives from fat.stations)
-- and no recalls/standby/spoilt_meals/operational_claims label snapshots
-- reference "VEMTC". This is therefore a pure display-name update.
--
-- Idempotent: matches on id, safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

update fat.stations
   set name       = 'Training Academy',
       updated_at = now()
 where id = 60
   and name = 'VEMTC';
