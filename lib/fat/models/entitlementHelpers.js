// ─── Entitlement helpers ─────────────────────────────────────────────────────
// Pure functions — no Supabase dependency. Effective payable resolution and
// manual-override detection per DATABASE_ARCHITECTURE_v1.0.md § 3 and
// ENTITLEMENT_RULES_v1.0.md § Manual Override Rules.
//
// Hours-first rows persist with generated_amount = NULL — callers must use
// effectiveAmount + effectiveHours (per the row's `unit`) rather than the
// legacy effectivePayable helper, which assumes a non-null generated_amount.
// See ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 4 for the migration plan.

/**
 * Effective dollar amount for an entitlement row.
 * COALESCE(edited_amount, generated_amount). Returns null for hours-first
 * rows (no dollar prediction at generation time). Callers MUST treat null
 * as "no dollar value at this time" — not as zero.
 *
 * @param {{ edited_amount: number|null, generated_amount: number|null }} entitlement
 * @returns {number|null}
 */
export function effectiveAmount(entitlement) {
  return entitlement.edited_amount ?? entitlement.generated_amount
}

/**
 * Effective hours quantity for an entitlement row.
 * COALESCE(edited_hours, generated_hours). Returns null for dollars-first
 * rows (the row carries no hours quantity).
 *
 * @param {{ edited_hours: number|null, generated_hours: number|null }} entitlement
 * @returns {number|null}
 */
export function effectiveHours(entitlement) {
  return entitlement.edited_hours ?? entitlement.generated_hours
}

/**
 * Effective payable dollar amount — legacy helper retained during Phase 3
 * migration. Equivalent to effectiveAmount, but asserts a non-null result
 * (will throw if called on an hours-first row). Prefer effectiveAmount +
 * effectiveHours at new call sites; remove this once the last legacy caller
 * is migrated.
 *
 * @deprecated Use effectiveAmount (and effectiveHours for hours-first rows).
 * @param {{ edited_amount: number|null, generated_amount: number|null }} entitlement
 * @returns {number}
 */
export function effectivePayable(entitlement) {
  const value = effectiveAmount(entitlement)
  if (value == null) {
    throw new Error(
      'effectivePayable called on an entitlement with no dollar value. '
      + 'Hours-first rows must use effectiveHours; see '
      + 'ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 4.'
    )
  }
  return value
}

/**
 * Mirror predicate for `claim_entitlements.manual_override`. The schema
 * stores this as a column for query convenience; this helper lets engine
 * code compute the same value pre-insert.
 *
 * @param {{ edited_amount: number|null, edited_hours: number|null }} entitlement
 * @returns {boolean}
 */
export function isManualOverride(entitlement) {
  return entitlement.edited_amount != null || entitlement.edited_hours != null
}
