/**
 * Recall + Retain meal-entitlement helper tests.
 *
 * Run with: npx jest __tests__/recall-retain-entitlements.test.js
 *
 * Covers:
 *   - calculateRecallMealEntitlements() — Day ≤09:59, Day ≥10:00, Night,
 *     Notified, sub-threshold duration.
 *   - calcRetainMealEligibility() — inclusive ≥ thresholds, stacking small
 *     meals every +2h.
 */

import {
  calculateRecallMealEntitlements,
  calcRetainMealEligibility,
  calcRecallClaim,
} from '../lib/calculations/engine.js'

const RATES = {
  kilometreRate:      0.99,
  smallMealAllowance: 10.90,
  largeMealAllowance: 20.55,
}

// ─── Recall entitlement helper ───────────────────────────────────────────────

describe('calculateRecallMealEntitlements — Day shift', () => {
  test('arrival ≤ 09:59 → 1× Large + 1× Small', () => {
    const r = calculateRecallMealEntitlements({
      shift: 'Day', notified: false, arrivalTime: '09:00',
    })
    expect(r.largeCount).toBe(1)
    expect(r.smallCount).toBe(1)
    expect(r.mealEntitlement).toBe('double')
    expect(r.tier).toBe('large+small')
  })

  test('arrival 09:59 boundary → 1× Large + 1× Small', () => {
    const r = calculateRecallMealEntitlements({
      shift: 'Day', notified: false, arrivalTime: '09:59',
    })
    expect(r.mealEntitlement).toBe('double')
  })

  test('arrival 10:00 boundary → 1× Large only', () => {
    const r = calculateRecallMealEntitlements({
      shift: 'Day', notified: false, arrivalTime: '10:00',
    })
    expect(r.largeCount).toBe(1)
    expect(r.smallCount).toBe(0)
    expect(r.mealEntitlement).toBe('large')
  })

  test('arrival 14:00 → 1× Large only (single meal)', () => {
    const r = calculateRecallMealEntitlements({
      shift: 'Day', notified: false, arrivalTime: '14:00',
    })
    expect(r.mealEntitlement).toBe('large')
  })

  test('arrival 17:00 (only 1h to shift end) → below threshold, no meal', () => {
    const r = calculateRecallMealEntitlements({
      shift: 'Day', notified: false, arrivalTime: '17:00',
    })
    expect(r.mealEntitlement).toBe('none')
    expect(r.reason).toBe('below-min-duration')
  })
})

describe('calculateRecallMealEntitlements — Night shift', () => {
  test('Night arrival 20:00 → 1× Large only (never double)', () => {
    const r = calculateRecallMealEntitlements({
      shift: 'Night', notified: false, arrivalTime: '20:00',
    })
    expect(r.largeCount).toBe(1)
    expect(r.smallCount).toBe(0)
    expect(r.mealEntitlement).toBe('large')
  })

  test('Night arrival 02:00 → 1× Large only', () => {
    const r = calculateRecallMealEntitlements({
      shift: 'Night', notified: false, arrivalTime: '02:00',
    })
    expect(r.mealEntitlement).toBe('large')
    expect(r.smallCount).toBe(0)
  })

  test('Night arrival 07:00 (1h to shift end) → no meal (below 4h)', () => {
    const r = calculateRecallMealEntitlements({
      shift: 'Night', notified: false, arrivalTime: '07:00',
    })
    expect(r.mealEntitlement).toBe('none')
  })
})

describe('calculateRecallMealEntitlements — Notified', () => {
  test('Notified Day shift suppresses meal entitlement', () => {
    const r = calculateRecallMealEntitlements({
      shift: 'Day', notified: true, arrivalTime: '08:00',
    })
    expect(r.mealEntitlement).toBe('none')
    expect(r.tier).toBe('notified')
    expect(r.label).toBe('No meal allowances are entitled for Notified Recalls')
  })

  test('Notified Night shift suppresses meal entitlement', () => {
    const r = calculateRecallMealEntitlements({
      shift: 'Night', notified: true, arrivalTime: '20:00',
    })
    expect(r.mealEntitlement).toBe('none')
  })
})

describe('calculateRecallMealEntitlements — missing inputs', () => {
  test('no shift → none', () => {
    const r = calculateRecallMealEntitlements({
      shift: null, notified: false, arrivalTime: '08:00',
    })
    expect(r.mealEntitlement).toBe('none')
    expect(r.reason).toBe('no-shift')
  })

  test('no arrival time → none', () => {
    const r = calculateRecallMealEntitlements({
      shift: 'Day', notified: false, arrivalTime: '',
    })
    expect(r.mealEntitlement).toBe('none')
    expect(r.reason).toBe('no-arrival')
  })
})

// ─── calcRecallClaim integration (auto-derived meal) ─────────────────────────

describe('calcRecallClaim — auto-derived meal from shift/arrival/notified', () => {
  test('Day shift 09:00 + 20km home → travel + Large+Small meal', () => {
    const r = calcRecallClaim({
      distHomeKm: 20, distStnKm: 0,
      shift: 'Day', notified: false, arrivalTime: '09:00',
    }, RATES)
    // 40km return × 0.99 = 39.60
    expect(r.travelAmount).toBeCloseTo(39.60, 2)
    expect(r.mealEntitlement).toBe('double')
    expect(r.mealieAmount).toBeCloseTo(31.45, 2) // 10.90 + 20.55
    expect(r.totalAmount).toBeCloseTo(71.05, 2)
  })

  test('Night shift 22:00 + 0km → Large only', () => {
    const r = calcRecallClaim({
      distHomeKm: 0, distStnKm: 0,
      shift: 'Night', notified: false, arrivalTime: '22:00',
    }, RATES)
    expect(r.mealEntitlement).toBe('large')
    expect(r.mealieAmount).toBeCloseTo(20.55, 2)
    expect(r.totalAmount).toBeCloseTo(20.55, 2)
  })

  test('Notified Recall → travel only, no meal', () => {
    const r = calcRecallClaim({
      distHomeKm: 10, distStnKm: 0,
      shift: 'Day', notified: true, arrivalTime: '08:00',
    }, RATES)
    expect(r.mealEntitlement).toBe('none')
    expect(r.mealieAmount).toBe(0)
    expect(r.travelAmount).toBeCloseTo(19.80, 2) // 20km × 0.99
    expect(r.totalAmount).toBeCloseTo(19.80, 2)
  })

  test('legacy callsite using mealEntitlement still works', () => {
    const r = calcRecallClaim({
      distHomeKm: 10, distStnKm: 0,
      mealEntitlement: 'large',
    }, RATES)
    expect(r.mealEntitlement).toBe('large')
    expect(r.mealieAmount).toBeCloseTo(20.55, 2)
  })
})

// ─── Retain meal eligibility — stacking thresholds ───────────────────────────

describe('calcRetainMealEligibility — Night shift stacking', () => {
  test('retained until 09:00 → 1× Large only (inclusive boundary)', () => {
    const r = calcRetainMealEligibility({ shift: 'Night', bookedOffTime: '09:00' })
    expect(r.largeCount).toBe(1)
    expect(r.smallCount).toBe(0)
    expect(r.tier).toBe('large')
  })

  test('retained until 09:59 → 1× Large only', () => {
    const r = calcRetainMealEligibility({ shift: 'Night', bookedOffTime: '09:59' })
    expect(r.largeCount).toBe(1)
    expect(r.smallCount).toBe(0)
  })

  test('retained until 10:00 → 1× Large + 1× Small (inclusive)', () => {
    const r = calcRetainMealEligibility({ shift: 'Night', bookedOffTime: '10:00' })
    expect(r.largeCount).toBe(1)
    expect(r.smallCount).toBe(1)
    expect(r.tier).toBe('large+small')
  })

  test('retained until 12:00 → 1× Large + 2× Small', () => {
    const r = calcRetainMealEligibility({ shift: 'Night', bookedOffTime: '12:00' })
    expect(r.largeCount).toBe(1)
    expect(r.smallCount).toBe(2)
  })

  test('retained until 14:00 → 1× Large + 3× Small', () => {
    const r = calcRetainMealEligibility({ shift: 'Night', bookedOffTime: '14:00' })
    expect(r.largeCount).toBe(1)
    expect(r.smallCount).toBe(3)
  })

  test('retained until 08:59 (before threshold) → no meal', () => {
    const r = calcRetainMealEligibility({ shift: 'Night', bookedOffTime: '08:59' })
    expect(r.largeCount).toBe(0)
    expect(r.smallCount).toBe(0)
    expect(r.tier).toBe('none')
  })
})

describe('calcRetainMealEligibility — Day shift stacking', () => {
  test('retained until 19:00 → 1× Large only (inclusive)', () => {
    const r = calcRetainMealEligibility({ shift: 'Day', bookedOffTime: '19:00' })
    expect(r.largeCount).toBe(1)
    expect(r.smallCount).toBe(0)
  })

  test('retained until 19:59 → 1× Large only', () => {
    const r = calcRetainMealEligibility({ shift: 'Day', bookedOffTime: '19:59' })
    expect(r.largeCount).toBe(1)
    expect(r.smallCount).toBe(0)
  })

  test('retained until 20:00 → 1× Large + 1× Small (Day-shift +2h from rostered finish)', () => {
    const r = calcRetainMealEligibility({ shift: 'Day', bookedOffTime: '20:00' })
    expect(r.largeCount).toBe(1)
    expect(r.smallCount).toBe(1)
  })

  test('retained until 22:00 → 1× Large + 2× Small', () => {
    const r = calcRetainMealEligibility({ shift: 'Day', bookedOffTime: '22:00' })
    expect(r.largeCount).toBe(1)
    expect(r.smallCount).toBe(2)
  })

  test('retained past midnight 00:00 → 1× Large + 3× Small', () => {
    const r = calcRetainMealEligibility({ shift: 'Day', bookedOffTime: '00:00' })
    expect(r.largeCount).toBe(1)
    expect(r.smallCount).toBe(3)
  })
})

describe('calcRetainMealEligibility — missing inputs', () => {
  test('no shift → none', () => {
    const r = calcRetainMealEligibility({ shift: null, bookedOffTime: '10:00' })
    expect(r.tier).toBe('none')
  })

  test('no booked-off time → none', () => {
    const r = calcRetainMealEligibility({ shift: 'Night', bookedOffTime: '' })
    expect(r.tier).toBe('none')
  })
})
