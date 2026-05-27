// ─── Retain (RT) Entitlement Generator — scaffold (no-op) ────────────────────
// Contract: ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 5.2.
//
// Status: entire entitlement set is TODO per CLAIM_TYPES_v1.0.md § Retain
// and ENTITLEMENT_RULES_v1.0.md § Retain. Generator MUST emit [] until the
// canonical set is defined.

/** @typedef {import('../types.js').EntitlementDraft} EntitlementDraft */
/** @typedef {import('../types.js').EngineContext}    EngineContext */
/** @typedef {import('../types.js').RetainDetails}    RetainDetails */
/** @typedef {import('../types.js').OperationalClaim} OperationalClaim */

/**
 * @param {OperationalClaim} _claim
 * @param {RetainDetails}    _details
 * @param {EngineContext}    _ctx
 * @returns {EntitlementDraft[]}
 */
export function generateRetainEntitlements(_claim, _details, _ctx) {
  return []
}
