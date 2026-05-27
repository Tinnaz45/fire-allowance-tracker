// ─── Spoilt Meal (SM) Entitlement Generator — scaffold (no-op) ───────────────
// Contract: ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 5.6.
//
// Status: entire entitlement set is TODO per ENTITLEMENT_RULES_v1.0.md
// § Spoilt Meal and CLAIM_TYPES_v1.0.md § Spoilt Meal. Generator MUST emit
// [] until the canonical set is defined.

/** @typedef {import('../types.js').EntitlementDraft}  EntitlementDraft */
/** @typedef {import('../types.js').EngineContext}     EngineContext */
/** @typedef {import('../types.js').SpoiltMealDetails} SpoiltMealDetails */
/** @typedef {import('../types.js').OperationalClaim}  OperationalClaim */

/**
 * @param {OperationalClaim}  _claim
 * @param {SpoiltMealDetails} _details
 * @param {EngineContext}     _ctx
 * @returns {EntitlementDraft[]}
 */
export function generateSpoiltMealEntitlements(_claim, _details, _ctx) {
  return []
}
