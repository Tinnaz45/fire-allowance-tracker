-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0) — MIGRATION 04 (SEED)
--
-- Seed fat.rates + fat.rate_versions with the canonical allowance values the
-- entitlement engine looks up by `code`. One append-only rate_versions row per
-- rate, effective 2025-06-01 (≤ the earliest live claim date 2026-05-29, so
-- every existing claim resolves to this version). Sets rates.active_version_id.
--
-- Two evidence sources, both retained verbatim for traceability:
--
--   (A) DEFAULT_RATES  (lib/calculations/defaultRates.js — the user-confirmed
--       "approved defaults"):
--         kilometreRate       1.20   → code travel_per_km   (dollars_per_km)
--         smallMealAllowance  10.90  → code small_meal      (dollars)
--         largeMealAllowance  20.55  → code large_meal      (dollars)
--
--   (B) Engine rate-code contract (lib/fat/engine/generators/*.js + the
--       validateDrafts.js fixtures + the payslip evidence block in
--       defaultRates.js). The implemented Standby/M&D generators look up two
--       FIXED-HOURS rates that are NOT in DEFAULT_RATES — their value is a
--       number of hours (unit='hours'), later bridged to dollars downstream:
--         standby_hours  0.50  → Standby&Dismi fixed hours (payslip: 0.50h = $50.51)
--         md_hours       1.00  → Muster&Dismis fixed hours (payslip: 1.00h = $101.02)
--       Seeded here so generateStandbyEntitlements / generateMusterDismissEntitlements
--       can resolve their rate lookups in the next (wiring) phase.
--
-- NOT seeded (documented gap — see docs/CANONICAL_SEED_REPORT_v1.0.md):
--   • RETAIN_OVERTIME_HOURLY_RATE ($101.0225/h) — the hours→dollars bridge
--     constant. No generator looks it up by code, and "dollars_per_hour" is
--     not in the fat.rates.unit CHECK enum. Left for a unit-enum decision.
--
-- Idempotent: ON CONFLICT guards on rates.code and (rate_id, version_label);
-- the active_version_id back-fill only writes when it differs. Safe to replay.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. rates (one row per canonical code) ───────────────────────────────────
insert into fat.rates (code, display_name, unit) values
  ('travel_per_km', 'Kilometre Rate',                'dollars_per_km'),
  ('small_meal',    'Small Meal Allowance',          'dollars'),
  ('large_meal',    'Large Meal Allowance',          'dollars'),
  ('standby_hours', 'Standby & Dismiss (fixed hrs)', 'hours'),
  ('md_hours',      'Muster & Dismiss (fixed hrs)',  'hours')
on conflict (code) do nothing;

-- ─── 2. rate_versions (append-only; effective 2025-06-01) ────────────────────
insert into fat.rate_versions (rate_id, version_label, value, effective_from)
select rt.id, 'initial-2025-06', x.value, date '2025-06-01'
from (values
  ('travel_per_km', 1.2000),
  ('small_meal',   10.9000),
  ('large_meal',   20.5500),
  ('standby_hours', 0.5000),
  ('md_hours',      1.0000)
) as x(code, value)
join fat.rates rt on rt.code = x.code
on conflict (rate_id, version_label) do nothing;

-- ─── 3. point each rate at its active version ────────────────────────────────
update fat.rates rt
set active_version_id = rv.id
from fat.rate_versions rv
where rv.rate_id = rt.id
  and rv.version_label = 'initial-2025-06'
  and rt.code in ('travel_per_km','small_meal','large_meal','standby_hours','md_hours')
  and rt.active_version_id is distinct from rv.id;

-- ═══════════════════════════════════════════════════════════════════════════════
-- END migration 04 (seed rates)
-- ═══════════════════════════════════════════════════════════════════════════════
