-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0) — MIGRATION 02
--
-- Drop NOT NULL on fat.claim_entitlements.generated_amount so the entitlement
-- engine can persist hours-first rows (Standby Excess Travel, Standby&Dismi,
-- M&D Excess Travel, Muster&Dismis) with generated_hours populated and
-- generated_amount NULL.
--
-- Rationale: resolved 2026-05-26 per ENTITLEMENT_RULES_v1.0.md
-- § FRV Matrix Hours → Payable Bridge and ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md
-- § 6.1. Matrix output is the canonical payable quantity on
-- claim_entitlements.generated_hours; no implicit hours→dollars conversion
-- at generation time.
--
-- Companion app-layer change: lib/fat/models/claimEntitlement.js widens
-- the @property typedef to {number|null}.
--
-- Idempotent: alter ... drop not null is a no-op when the constraint is
-- already absent.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table fat.claim_entitlements
  alter column generated_amount drop not null;

comment on column fat.claim_entitlements.generated_amount is
  'Engine output at creation. NEVER overwritten. Manual edits land in '
  'edited_amount with edited_note. NULL for hours-first rows '
  '(matrix-driven or fixed-hour rules) — see ENTITLEMENT_RULES_v1.0.md '
  '§ FRV Matrix Hours → Payable Bridge.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- END migration 02
-- ═══════════════════════════════════════════════════════════════════════════════
