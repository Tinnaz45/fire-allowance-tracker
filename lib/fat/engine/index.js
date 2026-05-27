// ─── Entitlement Engine — Phase 3 entry point ────────────────────────────────
// Pure dispatcher. Returns EntitlementDraft[] for a draft operational claim +
// its 1:1 detail row, given an injected lookup context. NEVER writes to the
// database — the caller (claim writer) owns the transaction.
//
// Contract: ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 2 (boundary) and § 5
// (per-claim generators).
//
// Static-snapshot philosophy (§ 1):
//   - One generation per claim. The engine is invoked once at claim-create
//     time and never re-runs after generated_at.
//   - Inputs are never mutated.
//   - Output rows are write-once; the claim writer attaches claim_id /
//     owner_id and inserts.

import { generateRecallEntitlements }        from './generators/recall.js'
import { generateRetainEntitlements }        from './generators/retain.js'
import { generateStandbyEntitlements }       from './generators/standby.js'
import { generateMusterDismissEntitlements } from './generators/musterDismiss.js'
import { generateDelayedMealEntitlements }   from './generators/delayedMeal.js'
import { generateSpoiltMealEntitlements }    from './generators/spoiltMeal.js'

/** @typedef {import('./types.js').EntitlementDraft} EntitlementDraft */
/** @typedef {import('./types.js').EngineContext}    EngineContext */
/** @typedef {import('./types.js').OperationalClaim} OperationalClaim */
/** @typedef {import('./types.js').ClaimType}        ClaimType */

const GENERATORS = {
  RC: generateRecallEntitlements,
  RT: generateRetainEntitlements,
  SB: generateStandbyEntitlements,
  MD: generateMusterDismissEntitlements,
  DM: generateDelayedMealEntitlements,
  SM: generateSpoiltMealEntitlements,
}

/**
 * Pure entitlement generator. Dispatches to the per-claim-type generator
 * and returns the draft entitlement rows for the claim writer to persist.
 *
 * @param {OperationalClaim} claim    — draft of the operational_claims row about to be inserted
 * @param {object}           details  — draft of the 1:1 detail row for claim.claim_type
 * @param {EngineContext}    ctx
 * @returns {EntitlementDraft[]}
 */
export function generateEntitlements(claim, details, ctx) {
  const generator = GENERATORS[claim.claim_type]
  if (generator == null) {
    throw new Error(
      `generateEntitlements: unknown claim_type '${claim.claim_type}'. `
      + 'Expected one of RC, RT, SB, MD, DM, SM.'
    )
  }
  return generator(claim, details, ctx)
}

export {
  generateRecallEntitlements,
  generateRetainEntitlements,
  generateStandbyEntitlements,
  generateMusterDismissEntitlements,
  generateDelayedMealEntitlements,
  generateSpoiltMealEntitlements,
}
