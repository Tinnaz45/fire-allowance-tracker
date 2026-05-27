// ─── fat.claim_entitlements (canonical) ──────────────────────────────────────
// Homogeneous: one row per generated entitlement regardless of type.
//
// Static accounting record: generated_amount, generated_hours, rule_id,
// rule_version, rule_explanation, formula_explanation, rate_id,
// rate_version_id, rate_snapshot, generated_at are immutable after
// creation. Manual edits land in edited_amount / edited_hours /
// edited_note. Effective payable amount = COALESCE(edited_amount,
// generated_amount). See entitlementHelpers.js.
//
// See DATABASE_ARCHITECTURE_v1.0.md § 3. Generated Entitlements.

/** @typedef {'dollars'|'hours'|'km'} EntitlementUnit */
/** @typedef {'payslip'|'petty_cash'|null} PaymentMethod */
/**
 * Payment status is stream-scoped:
 *   payslip   → 'pending' | 'paid'
 *   petty_cash → 'outstanding' | 'claimed'
 * Canonical TODO: decide whether to split into two columns per stream.
 * @typedef {'pending'|'paid'|'outstanding'|'claimed'|null} PaymentStatus
 */

/**
 * The entitlement_type enum is intentionally not pinned here — the catalogue
 * is still being codified in ENTITLEMENT_RULES_v1.0.md. Known values include:
 * 'small_meal', 'large_meal', 'excess_travel', 'relieving', 'standby_dismi',
 * 'muster_dismis', 'maint_stn'.
 * @typedef {string} EntitlementType
 */

/**
 * @typedef {Object} ClaimEntitlement
 * @property {string}             id
 * @property {string}             claim_id           // → operational_claims.id
 * @property {string}             owner_id           // denormalised for RLS
 * @property {EntitlementType}    entitlement_type
 * @property {EntitlementUnit}    unit
 *
 * @property {number|null}        generated_amount   // engine output; immutable. NULL for hours-first rows.
 * @property {number|null}        generated_hours    // engine output; immutable. NULL for dollars-first rows.
 * @property {number|null}        edited_amount      // manual override; NULL = none
 * @property {number|null}        edited_hours
 * @property {string|null}        edited_note
 * @property {boolean}            manual_override    // mirror of edited_* IS NOT NULL
 *
 * @property {string}             rule_id            // stable rule identifier
 * @property {string}             rule_version
 * @property {string|null}        rule_explanation
 * @property {string|null}        formula_explanation
 *
 * @property {string|null}        rate_id            // → rates.id
 * @property {string|null}        rate_version_id    // → rate_versions.id
 * @property {object}             rate_snapshot      // frozen jsonb
 *
 * @property {PaymentMethod}      payment_method
 * @property {PaymentStatus}      payment_status
 *
 * @property {string}             generated_at
 * @property {string}             updated_at
 */

export const CLAIM_ENTITLEMENTS_TABLE = 'claim_entitlements'
