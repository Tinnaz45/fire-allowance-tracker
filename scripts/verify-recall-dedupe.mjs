// Verify the recall parent/auto-child double-count fix across BOTH aggregation
// paths:
//   1. Dollar totals — the groupedView operational-container dedupe (zeroes the
//      parent's dollars so children carry the payable totals). Drives Financial
//      Snapshot, group cards, reconciliation and exports.
//   2. Tax km/meals — calcTaxSummary counts the PARENT recall only and skips its
//      auto-children (callback_ops / excess_travel / petty_cash_meal).
//
// Run: node scripts/verify-recall-dedupe.mjs
//
// This script re-implements the small set of resolver/dedupe/tax helpers from
// lib/claims/claimMeta.js, lib/reconciliation/reconciliationUtils.js and
// lib/calculations/engine.js so it runs under bare Node without the Next.js
// `@/lib/*` path alias. The implementations mirror the originals exactly.

// ── Resolver helpers (mirror engine.js / reconciliationUtils.js) ────────────
function roundMoney(v) {
  if (v == null || !isFinite(v) || isNaN(v)) return 0
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100
}
function resolveStoredAmount(c) {
  if (c.claimType === 'spoilt' || c.claimType === 'delayed_meal') {
    if (c.meal_amount != null) return roundMoney(c.meal_amount)
  }
  return roundMoney(c.total_amount || 0)
}
function resolveEffectiveAmount(c) {
  if (!c) return 0
  if (c.adjusted_amount != null) return roundMoney(c.adjusted_amount)
  return resolveStoredAmount(c)
}
function resolveSubclaimAmount(c) {
  if (c == null) return 0
  if (c.component_amount != null && !isNaN(Number(c.component_amount))) {
    return Number(c.component_amount)
  }
  return resolveEffectiveAmount(c)
}

// ── Mirror of claimMeta.isOperationalContainerRow ───────────────────────────
function isOperationalContainerRow(claim, siblings) {
  if (!claim || claim.calculation_inputs?.autoChild != null) return false
  return (siblings || []).some((c) => c?.calculation_inputs?.autoChild != null)
}

// ── Mirror of the dedupe pass in ClaimsContext.groupedView ──────────────────
function normalizeContainerParents(children) {
  return children.map((c) => {
    if (!isOperationalContainerRow(c, children)) return c
    return {
      ...c,
      travel_amount:    0,
      mealie_amount:    0,
      retain_amount:    0,
      overnight_cash:   0,
      total_amount:     0,
      adjusted_amount:  null,
      component_amount: 0,
    }
  })
}

// ── Mirror of calcTaxSummary recall + spoilt branches (km + meals only) ─────
function calcTaxKmAndMeals(claims, smallRate = 10.90, largeRate = 20.55) {
  let smallMeals = 0, largeMeals = 0, travelKm = 0
  for (const claim of claims) {
    const type = (claim.claimType || '').toLowerCase()
    if (type === 'recalls' && !claim.calculation_inputs?.autoChild) {
      travelKm += Number(
        claim.calculation_inputs?.totalKm ||
        ((Number(claim.dist_home_km || 0) * 2) + (Number(claim.dist_stn_km || 0) * 2))
      )
      if (claim.mealie_amount > 0) {
        const ent = claim.calculation_inputs?.mealEntitlement || 'none'
        if (ent === 'double') { smallMeals++; largeMeals++ }
        else if (ent === 'large') { largeMeals++ }
      }
    }
    if (type === 'spoilt' || type === 'delayed_meal') {
      const ai = claim.calculation_inputs || {}
      if (ai.autoChild !== 'retain_meal' && ai.autoChild !== 'petty_cash_meal') smallMeals++
    }
    if (type === 'standby' || type === 'md') {
      travelKm += Number(claim.dist_km || 0)
      if (Number(claim.night_mealie || 0) > 0) smallMeals++
    }
  }
  return { smallMeals, largeMeals, travelKm }
}

// ── Pre-fix tax behaviour (the OLD buggy engine) — for sanity comparison ────
// Counts EVERY recalls row's km and treats every spoilt row (except retain_meal)
// as a small meal — i.e. the double/triple count the fix removes.
function calcTaxKmAndMealsBuggy(claims, smallRate = 10.90, largeRate = 20.55) {
  let smallMeals = 0, largeMeals = 0, travelKm = 0
  for (const claim of claims) {
    const type = (claim.claimType || '').toLowerCase()
    if (type === 'recalls') {
      travelKm += Number(
        claim.calculation_inputs?.totalKm ||
        ((Number(claim.dist_home_km || 0) * 2) + (Number(claim.dist_stn_km || 0) * 2))
      )
      if (claim.mealie_amount > 0) {
        const ent = claim.calculation_inputs?.mealEntitlement || 'none'
        if (ent === 'double') { smallMeals++; largeMeals++ }
        else if (ent === 'large') { largeMeals++ }
      }
    }
    if (type === 'spoilt' || type === 'delayed_meal') {
      if ((claim.calculation_inputs || {}).autoChild !== 'retain_meal') smallMeals++
    }
    if (type === 'standby' || type === 'md') {
      travelKm += Number(claim.dist_km || 0)
      if (Number(claim.night_mealie || 0) > 0) smallMeals++
    }
  }
  return { smallMeals, largeMeals, travelKm }
}

let pass = 0, fail = 0
function expect(label, got, want) {
  const ok = Math.abs(got - want) < 1e-6
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(62)} got=${got}  want=${want}`)
  if (ok) pass++; else fail++
}

// ── Scenario 1: REAL DEV recall group 0431e933 (large meal) ─────────────────
// Parent $196.95 (travel 176.40 + meal 20.55), totalKm 147; children:
// callback_ops 176.40, excess_travel 0.00, petty_cash_meal 20.55 (Large).
{
  const parent = {
    id: 'p1', claimType: 'recalls', claim_group_id: 'g1',
    total_amount: 196.95, travel_amount: 176.40, mealie_amount: 20.55,
    dist_home_km: 67.5, dist_stn_km: 6.0,
    calculation_inputs: { totalKm: 147, mealEntitlement: 'large' },
  }
  const callbackOps = {
    id: 'c1a', claimType: 'recalls', claim_group_id: 'g1',
    total_amount: 176.40, travel_amount: 176.40, mealie_amount: 0,
    dist_home_km: 67.5, dist_stn_km: 6.0,
    calculation_inputs: { autoChild: 'callback_ops' },
  }
  const excessTravel = {
    id: 'c1b', claimType: 'recalls', claim_group_id: 'g1',
    total_amount: 0, travel_amount: 0, mealie_amount: 0,
    dist_home_km: 0, dist_stn_km: 6.0,
    calculation_inputs: { autoChild: 'excess_travel' },
  }
  const mealChild = {
    id: 'c1c', claimType: 'spoilt', claim_group_id: 'g1',
    total_amount: 20.55, meal_amount: 20.55,
    calculation_inputs: { autoChild: 'petty_cash_meal' },
  }
  const raw = [parent, callbackOps, excessTravel, mealChild]

  const before = raw.reduce((s, c) => s + resolveEffectiveAmount(c), 0)
  expect('Pre-fix dollar double-count (sanity)', roundMoney(before), 393.90)

  const norm = normalizeContainerParents(raw)
  const after = norm.reduce((s, c) => s + resolveSubclaimAmount(c), 0)
  expect('Post-dedupe dollars = single recall total', roundMoney(after), 196.95)
  expect('Parent still present (count)', norm.length, 4)
  expect('Parent dollars zeroed', resolveSubclaimAmount(norm.find((c) => c.id === 'p1')), 0)
  expect('Callback-Ops child untouched', resolveSubclaimAmount(norm.find((c) => c.id === 'c1a')), 176.40)
  expect('Meal child untouched', resolveSubclaimAmount(norm.find((c) => c.id === 'c1c')), 20.55)

  // Tax: pre-fix counts km 3× (147+147+12) and meals 1 large + 1 spurious small.
  const taxBefore = calcTaxKmAndMealsBuggy(raw)
  expect('Pre-fix tax km (sanity, 3× count)', taxBefore.travelKm, 306)
  expect('Pre-fix tax small meals (sanity, spurious)', taxBefore.smallMeals, 1)
  expect('Pre-fix tax large meals (sanity)', taxBefore.largeMeals, 1)

  // Tax operates on the RAW claims array (not the deduped groupedView); the
  // parent-only skip logic lives in calcTaxKmAndMeals (mirrors calcTaxSummary).
  const tax = calcTaxKmAndMeals(raw)
  expect('Tax km counted once (parent route)', tax.travelKm, 147)
  expect('Tax large meals = 1 (parent only)', tax.largeMeals, 1)
  expect('Tax small meals = 0 (meal child skipped)', tax.smallMeals, 0)
}

// ── Scenario 2: double-meal recall — km once, meals = 1 small + 1 large ─────
{
  const parent = {
    id: 'p2', claimType: 'recalls', claim_group_id: 'g2',
    total_amount: 103.45, travel_amount: 72.00, mealie_amount: 31.45,
    dist_home_km: 20, dist_stn_km: 10,
    calculation_inputs: { totalKm: 60, mealEntitlement: 'double' },
  }
  const callbackOps = {
    id: 'c2a', claimType: 'recalls', claim_group_id: 'g2',
    total_amount: 72.00, travel_amount: 72.00, dist_home_km: 20, dist_stn_km: 10,
    calculation_inputs: { autoChild: 'callback_ops' },
  }
  const mealChild = {
    id: 'c2b', claimType: 'spoilt', claim_group_id: 'g2',
    total_amount: 31.45, meal_amount: 31.45,
    calculation_inputs: { autoChild: 'petty_cash_meal' },
  }
  const raw = [parent, callbackOps, mealChild]
  const norm = normalizeContainerParents(raw)
  expect('Double-meal recall dollars once', roundMoney(norm.reduce((s, c) => s + resolveSubclaimAmount(c), 0)), 103.45)
  const tax = calcTaxKmAndMeals(raw)
  expect('Double-meal tax km once', tax.travelKm, 60)
  expect('Double-meal tax small = 1', tax.smallMeals, 1)
  expect('Double-meal tax large = 1', tax.largeMeals, 1)
}

// ── Scenario 3: retain group still deduped (preserve existing behavior) ─────
{
  const parent = {
    id: 'p3', claimType: 'retain', claim_group_id: 'g3',
    retain_amount: 169.58, overnight_cash: 0, total_amount: 169.58,
    calculation_inputs: { generatedHours: 4.00 },
  }
  const maintChild = {
    id: 'c3', claimType: 'retain', claim_group_id: 'g3',
    retain_amount: 169.58, total_amount: 169.58,
    calculation_inputs: { autoChild: 'maint_stn_nn' },
  }
  const norm = normalizeContainerParents([parent, maintChild])
  expect('Retain dedupe preserved', roundMoney(norm.reduce((s, c) => s + resolveSubclaimAmount(c), 0)), 169.58)
}

// ── Scenario 4: standby group untouched (parent already $0, never container) ─
{
  const standbyParent = {
    id: 'p4', claimType: 'standby', claim_group_id: 'g4',
    total_amount: 0, dist_km: 0,
    calculation_inputs: { autoChild: 'standby_and_dismi' },
  }
  const travelChild = {
    id: 'c4', claimType: 'standby', claim_group_id: 'g4',
    total_amount: 18.81, dist_km: 19,
    calculation_inputs: { autoChild: 'standby_excess_travel' },
  }
  const smallMealChild = {
    id: 'c4b', claimType: 'spoilt', claim_group_id: 'g4',
    total_amount: 10.90, meal_amount: 10.90, night_mealie: 0,
    calculation_inputs: { autoChild: 'standby_small_meal' },
  }
  const raw = [standbyParent, travelChild, smallMealChild]
  const norm = normalizeContainerParents(raw)
  expect('Standby dollars untouched', roundMoney(norm.reduce((s, c) => s + resolveSubclaimAmount(c), 0)), 29.71)
  expect('Standby parent NOT zeroed/flagged', isOperationalContainerRow(standbyParent, raw), false)
  const tax = calcTaxKmAndMeals(raw)
  expect('Standby tax km counted once (child)', tax.travelKm, 19)
  expect('Standby tax small meal counted once (child)', tax.smallMeals, 1)
}

// ── Scenario 5: standalone recall, no children — NOT zeroed ─────────────────
{
  const lone = {
    id: 'p5', claimType: 'recalls', claim_group_id: 'g5',
    total_amount: 88.00, travel_amount: 60.00, mealie_amount: 28.00,
    dist_home_km: 25, dist_stn_km: 0,
    calculation_inputs: { totalKm: 50, mealEntitlement: 'large' },
  }
  const norm = normalizeContainerParents([lone])
  expect('Standalone recall preserved (no children)', resolveSubclaimAmount(norm[0]), 88.00)
  const tax = calcTaxKmAndMeals([lone])
  expect('Standalone recall tax km', tax.travelKm, 50)
  expect('Standalone recall tax large', tax.largeMeals, 1)
}

// ── Scenario 6: recall w/ adjusted_amount on the parent — also zeroed ───────
{
  const parent = {
    id: 'p6', claimType: 'recalls', claim_group_id: 'g6',
    total_amount: 196.95, adjusted_amount: 250.00,
    travel_amount: 176.40, mealie_amount: 20.55,
    calculation_inputs: { totalKm: 147, mealEntitlement: 'large' },
  }
  const callbackOps = {
    id: 'c6', claimType: 'recalls', claim_group_id: 'g6',
    total_amount: 176.40, calculation_inputs: { autoChild: 'callback_ops' },
  }
  const mealChild = {
    id: 'c6b', claimType: 'spoilt', claim_group_id: 'g6',
    total_amount: 20.55, meal_amount: 20.55,
    calculation_inputs: { autoChild: 'petty_cash_meal' },
  }
  const norm = normalizeContainerParents([parent, callbackOps, mealChild])
  expect('Adjusted parent + children no double-count', roundMoney(norm.reduce((s, c) => s + resolveSubclaimAmount(c), 0)), 196.95)
}

console.log()
console.log(`Total: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`)
process.exit(fail > 0 ? 1 : 0)
