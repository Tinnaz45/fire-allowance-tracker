/**
 * Muster & Dismiss petty-cash kilometre rule tests.
 *
 * Rule (confirmed): payable one-way km = max(0, A − B)
 *   A = Home → Rostered Station (one-way km)
 *   B = Home → M&D Station      (one-way km)
 * Petty cash = payable km × kilometre rate (no return-leg doubling).
 *
 * Run with:  node --test __tests__/md-petty-cash-km.test.mjs
 *
 * These use Node's built-in runner (node:test) because the repo ships ESM `.js`
 * modules without a jest ESM transform configured. engine.js is pure (its only
 * import is ./defaultRates.js), so it loads natively.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  calcMdPayableKm,
  calcStandbyClaim,
  buildStandbyCalcLines,
  resolveEffectiveAmount,
} from '../lib/calculations/engine.js'

const RATES = { kilometreRate: 0.99, smallMealAllowance: 10.90 }

// ─── calcMdPayableKm — core rule + floor + missing inputs ─────────────────────

test('A=80, B=30 → 50 km payable (positive difference)', () => {
  assert.equal(calcMdPayableKm({ homeToRosteredKm: 80, homeToMdKm: 30 }), 50)
})

test('A=30, B=80 → 0 km payable (negative difference floors to 0)', () => {
  assert.equal(calcMdPayableKm({ homeToRosteredKm: 30, homeToMdKm: 80 }), 0)
})

test('A=B → 0 km payable (equal distances)', () => {
  assert.equal(calcMdPayableKm({ homeToRosteredKm: 42.5, homeToMdKm: 42.5 }), 0)
})

test('missing home distance (both undefined) → 0 km', () => {
  assert.equal(calcMdPayableKm({ homeToRosteredKm: undefined, homeToMdKm: undefined }), 0)
  assert.equal(calcMdPayableKm({}), 0)
})

test('missing rostered-station distance (A null) → 0 km', () => {
  assert.equal(calcMdPayableKm({ homeToRosteredKm: null, homeToMdKm: 30 }), 0)
})

test('missing M&D-station distance (B null) → 0 km (never overpays A − 0)', () => {
  // Critical: a missing B must NOT default to 0 and pay A. It yields 0 payable.
  assert.equal(calcMdPayableKm({ homeToRosteredKm: 80, homeToMdKm: null }), 0)
  assert.equal(calcMdPayableKm({ homeToRosteredKm: 80, homeToMdKm: NaN }), 0)
})

test('negative inputs are rejected → 0 km', () => {
  assert.equal(calcMdPayableKm({ homeToRosteredKm: -80, homeToMdKm: 30 }), 0)
  assert.equal(calcMdPayableKm({ homeToRosteredKm: 80, homeToMdKm: -30 }), 0)
})

test('rounds payable to 0.1 km', () => {
  assert.equal(calcMdPayableKm({ homeToRosteredKm: 80.36, homeToMdKm: 30.11 }), 50.3)
})

// ─── petty-cash dollar amount = payableKm × rate (feeds travel_amount & CSV) ───
// The Excess Travel child persists travel_amount = calcStandbyClaim(distKm).
// The petty-cash CSV sums that same travel_amount, so this identity is exactly
// what the export reports.

test('petty cash dollars = payableKm × kilometreRate', () => {
  const payableKm = calcMdPayableKm({ homeToRosteredKm: 80, homeToMdKm: 30 }) // 50
  const { travelAmount, totalAmount } = calcStandbyClaim({ distKm: payableKm, hasNightMeal: false }, RATES)
  assert.equal(travelAmount, 49.5)   // 50 × 0.99
  assert.equal(totalAmount, 49.5)    // M&D has no meal
})

test('zero-floor claim yields $0 petty cash', () => {
  const payableKm = calcMdPayableKm({ homeToRosteredKm: 30, homeToMdKm: 80 }) // 0
  const { travelAmount } = calcStandbyClaim({ distKm: payableKm, hasNightMeal: false }, RATES)
  assert.equal(travelAmount, 0)
})

test('petty-cash CSV amount identity: exported amount = payableKm × rate', () => {
  // The petty-cash CSV sums resolveSubclaimAmount → resolveEffectiveAmount →
  // total_amount for each Petty-Cash child. Reproduce the persisted Excess
  // Travel child row exactly as ClaimsContext writes it for M&D and assert the
  // exported amount equals payableKm × rate.
  const payableKm = calcMdPayableKm({ homeToRosteredKm: 80, homeToMdKm: 30 }) // 50
  const { travelAmount } = calcStandbyClaim({ distKm: payableKm, hasNightMeal: false }, RATES)
  const excessTravelChild = {
    claimType: 'standby',
    standby_type: 'M&D',
    dist_km: payableKm,
    travel_amount: travelAmount,
    total_amount: travelAmount,   // ClaimsContext sets total_amount = travel_amount
    adjusted_amount: null,
    payment_method: 'Petty Cash',
  }
  assert.equal(resolveEffectiveAmount(excessTravelChild), 49.5)
  assert.equal(resolveEffectiveAmount(excessTravelChild), Math.round(payableKm * RATES.kilometreRate * 100) / 100)
})

// ─── buildStandbyCalcLines — M&D breakdown clearly labels A − B ────────────────

test('M&D breakdown shows Home→Rostered minus Home→M&D with A, B and payable', () => {
  const lines = buildStandbyCalcLines(
    { distKm: 50, standbyType: 'M&D', homeToRosteredKm: 80, homeToMdKm: 30 },
    RATES,
  )
  const text = lines.join('\n')
  assert.match(text, /Home→Rostered minus Home→M&D/)
  assert.match(text, /Home → Rostered Station \(A\): 80 km/)
  assert.match(text, /Home → M&D Station \(B\): 30 km/)
  assert.match(text, /Payable km = max\(0, A − B\) = 50 km/)
  assert.match(text, /50 km × \$0\.99\/km = \$49\.50/)
  assert.match(text, /Total: \$49\.50/)
  // M&D never has a meal line other than the "none" note.
  assert.match(text, /No meal allowance|no meal allowance/)
})

test('M&D breakdown floored (A<B) shows 0 km / $0.00', () => {
  const lines = buildStandbyCalcLines(
    { distKm: 0, standbyType: 'M&D', homeToRosteredKm: 30, homeToMdKm: 80 },
    RATES,
  )
  const text = lines.join('\n')
  assert.match(text, /Payable km = max\(0, A − B\) = 0 km/)
  assert.match(text, /0 km × \$0\.99\/km = \$0\.00/)
  assert.match(text, /Total: \$0\.00/)
})

test('M&D breakdown without A/B (manual fallback) still uses distKm as payable', () => {
  const lines = buildStandbyCalcLines(
    { distKm: 12.5, standbyType: 'M&D' },
    RATES,
  )
  const text = lines.join('\n')
  assert.match(text, /Payable km \(manual entry\): 12\.5 km/)
  assert.match(text, /12\.5 km × \$0\.99\/km = \$12\.38/)
})

// ─── Regression: Standby path is unchanged (home rule must not leak) ──────────

test('Standby breakdown unchanged: rostered↔standby km × rate, no A/B lines', () => {
  const lines = buildStandbyCalcLines(
    { distKm: 40, standbyType: 'Standby', shift: 'Night', arrivedTime: '1930' },
    RATES,
  )
  const text = lines.join('\n')
  assert.match(text, /── Excess Travel ──/)          // original Standby header
  assert.doesNotMatch(text, /Home→Rostered minus/)    // no M&D home rule
  assert.doesNotMatch(text, /\(A\):/)
  assert.match(text, /40 km × \$0\.99\/km = \$39\.60/)
  // Night + arrival ≥ 19:00 → small meal eligible (unchanged behaviour).
  assert.match(text, /Small Meal Allowance/)
})

test('Standby day shift unchanged: travel only, no meal', () => {
  const lines = buildStandbyCalcLines(
    { distKm: 20, standbyType: 'Standby', shift: 'Day', arrivedTime: '0800' },
    RATES,
  )
  const text = lines.join('\n')
  assert.match(text, /20 km × \$0\.99\/km = \$19\.80/)
  assert.match(text, /None eligible for this shift/)
})
