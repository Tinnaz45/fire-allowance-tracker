-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0) — MIGRATION 03
--
-- Add `platoon text` to fat.standby so the auto-resolved operational FRV
-- platoon can be snapshotted on Standby and M&D claims, matching the existing
-- `platoon` columns on fat.recalls, fat.retain and fat.spoilt_meals.
--
-- Rationale: the operational platoon is now auto-generated for every claim from
-- (date, shift) via resolveOperationalPlatoon (lib/platoon/resolveOperationalPlatoon.js,
-- the FRV 2026 repeating rotation). standby was the only operational table
-- missing the column. The resolved value is written at claim-creation time into
-- both this column and calculation_inputs.platoon, preserving it historically.
--
-- Idempotent: `add column if not exists` is a no-op when the column is present.
-- Nullable + additive: existing rows are unaffected; no backfill of historical
-- standby rows is performed (their snapshot predates the feature).
-- ═══════════════════════════════════════════════════════════════════════════════

alter table fat.standby add column if not exists platoon text;
