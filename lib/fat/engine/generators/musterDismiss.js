// ─── Muster & Dismiss (MD) Entitlement Generator ─────────────────────────────
// Pure function. Returns zero or more EntitlementDraft rows from a draft
// M&D operational claim + its 1:1 muster_dismiss_details row.
//
// Contract: ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 5.4.
// Resolved per ENTITLEMENT_RULES_v1.0.md § Muster & Dismiss → Entitlements.
//
// Emits, when triggers fire:
//   1. excess_travel_md — hours-first (FRV Matrix hours, rostered → md station)
//   2. muster_dismis    — hours-first (fixed 1.0h from rate code 'md_hours')
//
// Payment routing: recommended default per § 5.4 is payslip / pending. The
// canonical payment-method-routing TODO for M&D is still open in
// PAYMENT_RECONCILIATION_v1.0.md; this generator emits the recommended
// default and the routing layer is free to override.

/** @typedef {import('../types.js').EntitlementDraft}     EntitlementDraft */
/** @typedef {import('../types.js').EngineContext}        EngineContext */
/** @typedef {import('../types.js').MusterDismissDetails} MusterDismissDetails */
/** @typedef {import('../types.js').OperationalClaim}     OperationalClaim */

function hasExcessTravelTrigger(claim, details, profileSnapshot) {
  const from = profileSnapshot?.rostered_station_id
  const to   = details?.md_station_id
  if (from == null || to == null) return false
  if (from === to) return false
  return true
}

function buildExcessTravelDraft(claim, details, ctx) {
  const from = ctx.profileSnapshot.rostered_station_id
  const to   = details.md_station_id
  const matrixVersion = details.matrix_version
  if (matrixVersion == null) return null
  const hit = ctx.matrixLookup(from, to, matrixVersion)
  if (hit == null) return null

  return {
    entitlement_type:    'excess_travel_md',
    unit:                'hours',
    generated_amount:    null,
    generated_hours:     hit.hours,
    edited_amount:       null,
    edited_hours:        null,
    edited_note:         null,
    manual_override:     false,
    rule_id:             'excess_travel.md.v1',
    rule_version:        'v1',
    rule_explanation:    'M&D Excess Travel — FRV Matrix hours, rostered station → M&D station.',
    formula_explanation: 'hours = station_time_matrix[rostered_station_id, md_station_id, matrix_version]',
    rate_id:             null,
    rate_version_id:     null,
    rate_snapshot: {
      matrix_version:    hit.matrixVersion,
      matrix_hours:      hit.hours,
      from_station_id:   from,
      to_station_id:     to,
    },
    payment_method:      'payslip',
    payment_status:      'pending',
  }
}

function buildMusterDismisDraft(claim, ctx) {
  const lookup = ctx.rateLookup('md_hours', claim.claim_date)
  if (lookup == null) return null

  return {
    entitlement_type:    'muster_dismis',
    unit:                'hours',
    generated_amount:    null,
    generated_hours:     lookup.value,
    edited_amount:       null,
    edited_hours:        null,
    edited_note:         null,
    manual_override:     false,
    rule_id:             'muster_dismis.fixed.v1',
    rule_version:        'v1',
    rule_explanation:    'Muster&Dismis — fixed hours for the muster+dismiss event itself.',
    formula_explanation: "hours = rate_versions.value where code='md_hours' and effective_from <= claim_date",
    rate_id:             lookup.rate.id,
    rate_version_id:     lookup.rateVersion.id,
    rate_snapshot: {
      code:              'md_hours',
      value:             lookup.value,
      version_label:     lookup.rateVersion.version_label,
      effective_from:    lookup.rateVersion.effective_from,
    },
    payment_method:      'payslip',
    payment_status:      'pending',
  }
}

/**
 * @param {OperationalClaim}     claim
 * @param {MusterDismissDetails} details
 * @param {EngineContext}        ctx
 * @returns {EntitlementDraft[]}
 */
export function generateMusterDismissEntitlements(claim, details, ctx) {
  const drafts = []

  if (hasExcessTravelTrigger(claim, details, ctx.profileSnapshot)) {
    const d = buildExcessTravelDraft(claim, details, ctx)
    if (d) drafts.push(d)
  }

  {
    const d = buildMusterDismisDraft(claim, ctx)
    if (d) drafts.push(d)
  }

  return drafts
}
