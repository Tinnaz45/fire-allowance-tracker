// Verify the retain parent/auto-child dedupe logic added to ClaimsContext's
// groupedView builder. We simulate the same normalization in isolation here
// and assert that consumers (resolveEffectiveAmount, resolveSubclaimAmount,
// sum reductions) see correctly deduplicated totals.
//
// Run: node scripts/verify-retain-dedupe.mjs
//
// Note: this script intentionally re-implements the small set of resolver
// helpers from lib/reconciliation/reconciliationUtils.js + engine.js so it
// can run under bare Node without the Next.js `@/lib/*` path alias. The
// implementations are tiny and mirror the originals.

// ── Resolver helpers (mirrors engine.js / reconciliationUtils.js) ───────────
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

// ── Mirror of the dedupe pass added in ClaimsContext.groupedView ──
function normalizeRetainParents(children) {
  const hasRetainAutoChild = children.some(
    (c) => c.claimType === 'retain' && c.calculation_inputs?.autoChild != null
  )
  if (!hasRetainAutoChild) return children
  return children.map((c) => {
    const isRetainParent =
      c.claimType === 'retain' && c.calculation_inputs?.autoChild == null
    if (!isRetainParent) return c
    return {
      ...c,
      retain_amount:    0,
      overnight_cash:   0,
      total_amount:     0,
      adjusted_amount:  null,
      component_amount: 0,
    }
  })
}

let pass = 0, fail = 0
function expect(label, got, want) {
  const ok = Math.abs(got - want) < 1e-6
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(60)} got=${got}  want=${want}`)
  if (ok) pass++; else fail++
}

// ── Scenario 1: pure retain (no overnight, no meal) ─────────────────────────
// Reproduces the user's reported case: $169.58 actual displaying as $339.16.
{
  const parent = {
    id: 'p1', claimType: 'retain', claim_group_id: 'g1',
    generated_hours: 4.00, retain_rate_used: 42.395,
    retain_amount: 169.58, overnight_cash: 0, total_amount: 169.58,
    calculation_inputs: { generatedHours: 4.00, retainRulePath: 'mandatory-minimum' },
  }
  const maintChild = {
    id: 'c1', claimType: 'retain', claim_group_id: 'g1',
    generated_hours: 4.00, retain_rate_used: 42.395,
    retain_amount: 169.58, overnight_cash: 0, total_amount: 169.58,
    calculation_inputs: { autoChild: 'maint_stn_nn', generatedHours: 4.00 },
  }
  const rawChildren = [parent, maintChild]
  const beforeSum = rawChildren.reduce((s, c) => s + resolveEffectiveAmount(c), 0)
  expect('Pre-fix double-count (sanity)', beforeSum, 339.16)

  const normalized = normalizeRetainParents(rawChildren)
  const afterSum = normalized.reduce((s, c) => s + resolveSubclaimAmount(c), 0)
  expect('Post-dedupe sum equals single retain amount', afterSum, 169.58)

  // Parent row still in array (still visible in My Claims), but its dollars are 0
  expect('Parent still present in children list', normalized.length, 2)
  const normalizedParent = normalized.find((c) => c.id === 'p1')
  expect('Parent dollars zeroed', resolveSubclaimAmount(normalizedParent), 0)

  // Auto-child untouched
  const normalizedChild = normalized.find((c) => c.id === 'c1')
  expect('Auto-child untouched', resolveSubclaimAmount(normalizedChild), 169.58)
}

// ── Scenario 2: retain + overnight + meal (full breakdown) ──────────────────
{
  const parent = {
    id: 'p2', claimType: 'retain', claim_group_id: 'g2',
    generated_hours: 5.25, retain_rate_used: 32.50,
    retain_amount: 170.63, overnight_cash: 25.00, total_amount: 196.18,
    calculation_inputs: { generatedHours: 5.25 },
  }
  const maintChild = {
    id: 'c2a', claimType: 'retain', claim_group_id: 'g2',
    retain_amount: 170.63, overnight_cash: 0, total_amount: 170.63,
    calculation_inputs: { autoChild: 'maint_stn_nn' },
  }
  const overnightChild = {
    id: 'c2b', claimType: 'retain', claim_group_id: 'g2',
    retain_amount: 0, overnight_cash: 25.00, total_amount: 25.00,
    calculation_inputs: { autoChild: 'overnight_cash' },
  }
  const mealChild = {
    id: 'c2c', claimType: 'spoilt', claim_group_id: 'g2',
    meal_amount: 0.55, total_amount: 0.55,
    calculation_inputs: { autoChild: 'retain_meal' },
  }
  const raw = [parent, maintChild, overnightChild, mealChild]
  const normalized = normalizeRetainParents(raw)
  const sum = normalized.reduce((s, c) => s + resolveSubclaimAmount(c), 0)
  expect('Full breakdown sum = sum of children only', sum, 196.18)
}

// ── Scenario 3: legacy retain w/ no auto-children — must NOT zero ──────────
{
  // Historical row that pre-dates the auto-child architecture. It IS the
  // only retain row for its group, so its dollars are NOT duplicated.
  const legacyParent = {
    id: 'p3', claimType: 'retain', claim_group_id: 'g3',
    retain_amount: 100.00, overnight_cash: 0, total_amount: 100.00,
    calculation_inputs: null,
  }
  const raw = [legacyParent]
  const normalized = normalizeRetainParents(raw)
  expect('Legacy retain (no auto-children) preserved', resolveSubclaimAmount(normalized[0]), 100.00)
}

// ── Scenario 4: non-retain group untouched ──────────────────────────────────
{
  const standbyParent = {
    id: 'p4', claimType: 'standby', claim_group_id: 'g4',
    total_amount: 0,
    calculation_inputs: { autoChild: 'standby_and_dismi' },
  }
  const travelChild = {
    id: 'c4', claimType: 'standby', claim_group_id: 'g4',
    total_amount: 18.81, payment_method: 'Payslip',
    calculation_inputs: { autoChild: 'standby_excess_travel' },
  }
  const raw = [standbyParent, travelChild]
  const normalized = normalizeRetainParents(raw)
  const sum = normalized.reduce((s, c) => s + resolveSubclaimAmount(c), 0)
  expect('Standby group untouched', sum, 18.81)
  expect('Standby group same row count', normalized.length, 2)
}

// ── Scenario 5: parent adjusted_amount also zeroed when duplicated ──────────
// (Adjustments live on the parent only; when children carry the dollars, the
// adjustment is part of the duplication. Children are the truth source.)
{
  const parent = {
    id: 'p5', claimType: 'retain', claim_group_id: 'g5',
    retain_amount: 169.58, total_amount: 169.58, adjusted_amount: 200.00,
    calculation_inputs: {},
  }
  const child = {
    id: 'c5', claimType: 'retain', claim_group_id: 'g5',
    retain_amount: 169.58, total_amount: 169.58,
    calculation_inputs: { autoChild: 'maint_stn_nn' },
  }
  const normalized = normalizeRetainParents([parent, child])
  const sum = normalized.reduce((s, c) => s + resolveSubclaimAmount(c), 0)
  expect('Adjusted parent + child no double-count', sum, 169.58)
}

console.log()
console.log(`Total: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`)
process.exit(fail > 0 ? 1 : 0)
