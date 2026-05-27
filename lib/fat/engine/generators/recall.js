// ─── Recall (RC) Entitlement Generator — scaffold (no-op) ────────────────────
// Contract: ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 5.1.
//
// Status: ALL Recall entitlements are gated on unresolved canonical TODOs
// in ENTITLEMENT_RULES_v1.0.md § Recall → Entitlements:
//   - Large Meal trigger condition
//   - Travel Allowance formula
//   - Excess Travel threshold + formula
//   - Relieving Allowance trigger
//
// The generator scaffold exists so the dispatcher in lib/fat/engine/index.js
// can integrate, but it returns [] until the canonical rules land.
//
// TODO: implement once ENTITLEMENT_RULES_v1.0.md § Recall lands.
// Do NOT carry forward prototype `autoChild` slugs (callback_ops,
// excess_travel, petty_cash_meal, …) as rule_id values without the canonical
// {family}.{variant}.{version} rewrite — see § 5.1 Generator MUST NOT.

/** @typedef {import('../types.js').EntitlementDraft} EntitlementDraft */
/** @typedef {import('../types.js').EngineContext}    EngineContext */
/** @typedef {import('../types.js').RecallDetails}    RecallDetails */
/** @typedef {import('../types.js').OperationalClaim} OperationalClaim */

/**
 * @param {OperationalClaim} _claim
 * @param {RecallDetails}    _details
 * @param {EngineContext}    _ctx
 * @returns {EntitlementDraft[]}
 */
export function generateRecallEntitlements(_claim, _details, _ctx) {
  return []
}
