-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0) — MIGRATION 05 (SEED)
--
-- Seed fat.station_distance_matrix from the live fat.travel_matrix_cells.
--
-- ── MATRIX-UNIT FINDING (resolves the activation-audit concern) ──────────────
-- The activation plan §5.4 assumed travel_matrix_cells held HOURS and should
-- seed fat.station_time_matrix. Live introspection FALSIFIES that assumption:
--
--   fat.travel_matrix_versions (the only active version) =
--     label  'FRV Index (km) - 1W (2026-05 import)'
--     file   index-km-1w.csv
--     unit   'km'                       ← authoritative
--   value range 0–555; Eastern Hill→Carlton = 2 (≈2 km, adjacent suburbs),
--   Eastern Hill→Mildura = 555 (≈550 km by road). 555 *hours* = 23 days (absurd).
--   The parser's 24-hour ceiling would have rejected 555 had it been imported
--   as hours — it was imported as km.
--
-- Therefore the loaded data is KILOMETRES and its canonical home is
-- station_distance_matrix (km), NOT station_time_matrix (hours). Seeding the
-- hours table from km values would corrupt the engine's "FRV Matrix Hours →
-- Payable Bridge" (generated_hours). station_time_matrix is left EMPTY: it
-- requires the FRV "Index (hr)" sheet, which has never been imported.
--
-- ── Direction expansion ──────────────────────────────────────────────────────
-- Source cells are upper-triangle only (station_a_id < station_b_id; 0 self,
-- 0 reverse). The canonical matrix PK is directed (from, to, version), so each
-- source cell is inserted in BOTH directions → 3321 × 2 = 6642 rows. The
-- matrix is symmetric, so distance_km is identical in each direction. Self
-- pairs are intentionally omitted (callers/engine treat from==to as 0).
--
-- matrix_version = the source version_id (uuid) cast to text — stable, unique,
-- and traceable back to the exact travel_matrix_versions row.
--
-- Idempotent: ON CONFLICT on the composite PK. Safe to replay.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Unit isolation (added 2026-06-14) ────────────────────────────────────────
-- When this seed was first written, travel_matrix_cells held ONLY the km
-- version, so an unconditional read was correct. After Phase 3 the table holds
-- BOTH a km version and an hours version simultaneously (see migration 06).
-- Reading unconditionally would insert decimal-HOURS values into distance_km —
-- silent corruption (hours are >= 0 so they pass the CHECK). The JOIN to
-- travel_matrix_versions + unit='km' filter keeps the km matrix km-only, exactly
-- mirroring the unit='hours' guard migration 06 uses for the time matrix.
insert into fat.station_distance_matrix (from_station_id, to_station_id, matrix_version, distance_km)
select c.station_a_id, c.station_b_id, c.version_id::text, c.value
from fat.travel_matrix_cells c
join fat.travel_matrix_versions v on v.id = c.version_id
where v.unit = 'km'
union all
select c.station_b_id, c.station_a_id, c.version_id::text, c.value
from fat.travel_matrix_cells c
join fat.travel_matrix_versions v on v.id = c.version_id
where v.unit = 'km'
on conflict (from_station_id, to_station_id, matrix_version) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- END migration 05 (seed station_distance_matrix)
-- ═══════════════════════════════════════════════════════════════════════════════
