-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0) — MIGRATION 06 (SEED)
--
-- Seed fat.station_time_matrix from the live fat.travel_matrix_cells (HOURS).
--
-- ── Source ───────────────────────────────────────────────────────────────────
-- The FRV workbook tab "Index (hr)" — station-to-station ONE-WAY travel time in
-- decimal hours, quarter-hour (0.25) increments. Imported via
-- scripts/import-travel-matrix.mjs --unit hours into fat.travel_matrix_cells
-- under its own travel_matrix_versions row (unit='hours'). This is the canonical
-- hours source that migration 05 explicitly left for later: 05 seeded km only and
-- left station_time_matrix EMPTY because travel_matrix_cells then held km.
--
-- ── Unit isolation ───────────────────────────────────────────────────────────
-- Unlike migration 05 (which read every cell), this seed JOINs to
-- travel_matrix_versions and filters unit='hours'. travel_matrix_cells now holds
-- BOTH a km version and an hours version simultaneously; reading unconditionally
-- would mix kilometres into the hours table. The filter keeps them isolated.
--
-- ── Direction expansion ──────────────────────────────────────────────────────
-- Source cells are upper-triangle only (station_a_id < station_b_id; no self, no
-- reverse). The canonical matrix PK is directed (from, to, version), so each
-- source cell is inserted in BOTH directions. The matrix is symmetric, so `hours`
-- is identical in each direction. Self pairs are intentionally omitted (callers /
-- engine treat from==to as 0).
--
-- ── Coverage note (data quality) ─────────────────────────────────────────────
-- The hours sheet is SPARSE: only 1368 of the 3321 active station pairs carry a
-- value (~41%). Direction expansion → 1368 × 2 = 2736 directed rows. The distance
-- matrix (km) is fully populated (6642 rows); the hours matrix is not. One source
-- pair (station 14 ↔ 60) held an out-of-range typo ("75") and was rejected at
-- import, so it is absent here. Callers must treat a missing (from,to,version)
-- row as "no hours datum", NOT as zero.
--
-- matrix_version = the source version_id (uuid) cast to text — stable, unique,
-- and traceable back to the exact travel_matrix_versions row.
--
-- Idempotent: ON CONFLICT on the composite PK. Safe to replay.
-- ═══════════════════════════════════════════════════════════════════════════════

insert into fat.station_time_matrix (from_station_id, to_station_id, matrix_version, hours)
select c.station_a_id, c.station_b_id, c.version_id::text, c.value
from fat.travel_matrix_cells c
join fat.travel_matrix_versions v on v.id = c.version_id
where v.unit = 'hours'
union all
select c.station_b_id, c.station_a_id, c.version_id::text, c.value
from fat.travel_matrix_cells c
join fat.travel_matrix_versions v on v.id = c.version_id
where v.unit = 'hours'
on conflict (from_station_id, to_station_id, matrix_version) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- END migration 06 (seed station_time_matrix)
-- ═══════════════════════════════════════════════════════════════════════════════
