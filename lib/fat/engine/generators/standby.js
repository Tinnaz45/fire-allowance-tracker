// ─── Standby (SB) Entitlement Generator ──────────────────────────────────────
// Pure function. Returns zero or more EntitlementDraft rows from a draft
// Standby operational claim + its 1:1 standby_details row.
//
// Contract: ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 5.3.
// Resolved per ENTITLEMENT_RULES_v1.0.md § Standby → Entitlements.
//
// Emits, when triggers fire:
//   1. excess_travel_standby  — hours-first (FRV Matrix hours, rostered → standby station)
//   2. standby_dismi          — hours-first (fixed 0.5h from rate code 'standby_hours')
//   3. small_meal             — dollars-first (rate code 'small_meal', petty cash stream)

/** @typedef {import('../types.js').EntitlementDraft}    EntitlementDraft */
/** @typedef {import('../types.js').EngineContext}       EngineContext */
/** @typedef {import('../types.js').StandbyDetails}      StandbyDetails */
/** @typedef {import('../types.js').OperationalClaim}    OperationalClaim */

// ─── Trigger helpers (local to this generator) ───────────────────────────────

function hasExcessTravelTrigger(claim, details, profileSnapshot) {
  const from = profileSnapshot?.rostered_station_id
  const to   = details?.standby_station_id
  if (from == null || to == null) return false
  if (from === to) return false
  return true
}

/**
 * Small Meal trigger for a Standby claim. Matches the existing engine rule
 * (lib/calculations/engine.js § isStandbyNightMealEligible): night-shift
 * arrival at or after 19:00 local time.
 *
 * The canonical StandbyDetails row carries only standby_start_at, so the
 * shift and arrival-time fields collapse into a single timestamptz. Hour
 * derivation here mirrors the legacy parse logic.
 */
function hasSmallMealTrigger(details) {
  const startAt = details?.standby_start_at
  if (!startAt) return false
  const d = new Date(startAt)
  if (Number.isNaN(d.getTime())) return false
  // Local-time hour-of-day. The canonical accounting record stores the user-
  // submitted timestamp; the engine reads it in the same TZ frame.
  return d.getHours() >= 19
}

// ─── Generators (one per draft row) ──────────────────────────────────────────

function buildExcessTravelDraft(claim, details, ctx) {
  const from = ctx.profileSnapshot.rostered_station_id
  const to   = details.standby_station_id
  const matrixVersion = details.matrix_version
  if (matrixVersion == null) return null
  const hit = ctx.matrixLookup(from, to, matrixVersion)
  if (hit == null) return null

  return {
    entitlement_type:    'excess_travel_standby',
    unit:                'hours',
    generated_amount:    null,
    generated_hours:     hit.hours,
    edited_amount:       null,
    edited_hours:        null,
    edited_note:         null,
    manual_override:     false,
    rule_id:             'excess_travel.standby.v1',
    rule_version:        'v1',
    rule_explanation:    'Standby Excess Travel — FRV Matrix hours, rostered station → standby station.',
    formula_explanation: 'hours = station_time_matrix[rostered_station_id, standby_station_id, matrix_version]',
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

function buildStandbyDismiDraft(claim, ctx) {
  const lookup = ctx.rateLookup('standby_hours', claim.claim_date)
  if (lookup == null) return null

  return {
    entitlement_type:    'standby_dismi',
    unit:                'hours',
    generated_amount:    null,
    generated_hours:     lookup.value,
    edited_amount:       null,
    edited_hours:        null,
    edited_note:         null,
    manual_override:     false,
    rule_id:             'standby_dismi.fixed.v1',
    rule_version:        'v1',
    rule_explanation:    'Standby&Dismi — fixed hours for the standby+dismiss event itself.',
    formula_explanation: "hours = rate_versions.value where code='standby_hours' and effective_from <= claim_date",
    rate_id:             lookup.rate.id,
    rate_version_id:     lookup.rateVersion.id,
    rate_snapshot: {
      code:              'standby_hours',
      value:             lookup.value,
      version_label:     lookup.rateVersion.version_label,
      effective_from:    lookup.rateVersion.effective_from,
    },
    payment_method:      'payslip',
    payment_status:      'pending',
  }
}

function buildSmallMealDraft(claim, ctx) {
  const lookup = ctx.rateLookup('small_meal', claim.claim_date)
  if (lookup == null) return null

  return {
    entitlement_type:    'small_meal',
    unit:                'dollars',
    generated_amount:    lookup.value,
    generated_hours:     null,
    edited_amount:       null,
    edited_hours:        null,
    edited_note:         null,
    manual_override:     false,
    rule_id:             'meal.small.v1',
    rule_version:        'v1',
    rule_explanation:    'Small Meal Allowance — standby night-shift arrival at or after 19:00.',
    formula_explanation: "amount = rate_versions.value where code='small_meal' and effective_from <= claim_date",
    rate_id:             lookup.rate.id,
    rate_version_id:     lookup.rateVersion.id,
    rate_snapshot: {
      code:              'small_meal',
      value:             lookup.value,
      version_label:     lookup.rateVersion.version_label,
      effective_from:    lookup.rateVersion.effective_from,
    },
    payment_method:      'petty_cash',
    payment_status:      'outstanding',
  }
}

/**
 * @param {OperationalClaim} claim
 * @param {StandbyDetails}   details
 * @param {EngineContext}    ctx
 * @returns {EntitlementDraft[]}
 */
export function generateStandbyEntitlements(claim, details, ctx) {
  const drafts = []

  if (hasExcessTravelTrigger(claim, details, ctx.profileSnapshot)) {
    const d = buildExcessTravelDraft(claim, details, ctx)
    if (d) drafts.push(d)
  }

  // Standby&Dismi fires for every SB claim — the standby+dismiss event itself
  // is the trigger. Skip only when the rate lookup fails (engine surfaces null
  // upstream; the caller decides whether to abort or persist zero rows).
  {
    const d = buildStandbyDismiDraft(claim, ctx)
    if (d) drafts.push(d)
  }

  if (hasSmallMealTrigger(details)) {
    const d = buildSmallMealDraft(claim, ctx)
    if (d) drafts.push(d)
  }

  return drafts
}
