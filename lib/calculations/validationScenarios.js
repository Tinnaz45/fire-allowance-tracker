// ─── Calculation Validation Scenarios ────────────────────────────────────────
// A runnable test framework for all claim calculation functions.
//
// Usage (Node.js, no test runner needed):
//   node lib/calculations/validationScenarios.js
//
// Or import runAllScenarios() into a test page/component for in-browser validation.
//
// Each scenario defines:
//   name        — human-readable description
//   fn          — function to call (from engine.js)
//   args        — arguments to pass
//   expected    — expected output (deep-checked key by key)
//   notes       — explanation of the business rule being tested
// ─────────────────────────────────────────────────────────────────────────────

import {
  roundMoney,
  calcTravelAmount,
  calcTotalKm,
  calcMealAllowance,
  calcDoubleMealAllowance,
  calcSpoiltMealAmount,
  normaliseMealType,
  calcRecallClaim,
  calcRetainClaim,
  calcStandbyClaim,
  calcSpoiltClaim,
  calcDashboardSummary,
  resolveStoredAmount,
} from './engine.js'

// ─── Test rates — fixed values for deterministic tests ────────────────────────
// Only canonical editable rates here. Spoilt/delayed/standby-night meals all
// resolve to smallMealAllowance, and double meal = small + large.

const TEST_RATES = {
  kilometreRate:      1.20,  // confirmed FRV award rate
  smallMealAllowance: 10.90, // confirmed FRV award rate
  largeMealAllowance: 20.55, // confirmed FRV award rate (flat — NOT 2× small)
}

// ─── Scenario runner ──────────────────────────────────────────────────────────

function check(label, actual, expected) {
  const errors = []
  for (const [key, expectedVal] of Object.entries(expected)) {
    const actualVal = actual[key]
    // Use epsilon for float comparison
    if (typeof expectedVal === 'number') {
      if (Math.abs(actualVal - expectedVal) > 0.001) {
        errors.push(`  ${key}: expected ${expectedVal}, got ${actualVal}`)
      }
    } else {
      if (actualVal !== expectedVal) {
        errors.push(`  ${key}: expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actualVal)}`)
      }
    }
  }
  const pass = errors.length === 0
  return { label, pass, errors, actual }
}

function checkValue(label, actual, expected) {
  const pass = Math.abs(actual - expected) <= 0.001
  return { label, pass, errors: pass ? [] : [`  expected ${expected}, got ${actual}`], actual }
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

const SCENARIOS = [

  // ── roundMoney ──────────────────────────────────────────────────────────────

  {
    name: 'roundMoney: standard float',
    run: () => checkValue('0.1 + 0.2 rounds correctly', roundMoney(0.1 + 0.2), 0.30),
  },
  {
    name: 'roundMoney: half-up on .005',
    run: () => checkValue('1.005 rounds to 1.01', roundMoney(1.005), 1.01),
  },
  {
    name: 'roundMoney: negative',
    run: () => checkValue('negative returns 0', roundMoney(-5), -5.00),
  },
  {
    name: 'roundMoney: null input',
    run: () => checkValue('null returns 0', roundMoney(null), 0),
  },
  {
    name: 'roundMoney: NaN input',
    run: () => checkValue('NaN returns 0', roundMoney(NaN), 0),
  },

  // ── Travel ──────────────────────────────────────────────────────────────────

  {
    name: 'calcTravelAmount: 10km at $1.20/km',
    run: () => checkValue('10km travel', calcTravelAmount({ km: 10 }, TEST_RATES), 12.00),
  },
  {
    name: 'calcTravelAmount: 0km returns $0',
    run: () => checkValue('0km travel', calcTravelAmount({ km: 0 }, TEST_RATES), 0),
  },
  {
    name: 'calcTravelAmount: fractional km',
    run: () => checkValue('7.5km travel', calcTravelAmount({ km: 7.5 }, TEST_RATES), 9.00),
    // 7.5 × 1.20 = 9.00 → exactly 9.00
  },
  {
    name: 'calcTravelAmount: large distance 50km',
    run: () => checkValue('50km travel', calcTravelAmount({ km: 50 }, TEST_RATES), 60.00),
  },

  // ── Total km ────────────────────────────────────────────────────────────────

  {
    name: 'calcTotalKm: home + station',
    run: () => checkValue('15 + 8 = 23km', calcTotalKm({ distHomeKm: 15, distStnKm: 8 }), 23),
  },
  {
    name: 'calcTotalKm: no station leg',
    run: () => checkValue('20 + 0 = 20km', calcTotalKm({ distHomeKm: 20, distStnKm: 0 }), 20),
  },

  // ── Meal allowances ─────────────────────────────────────────────────────────

  {
    name: 'calcMealAllowance: none → $0',
    run: () => checkValue('no meal = $0', calcMealAllowance({ mealEntitlement: 'none' }, TEST_RATES), 0),
  },
  {
    name: 'calcMealAllowance: small → $10.90',
    run: () => checkValue('small meal', calcMealAllowance({ mealEntitlement: 'small' }, TEST_RATES), 10.90),
  },
  {
    name: 'calcMealAllowance: large → $20.55',
    run: () => checkValue('large meal', calcMealAllowance({ mealEntitlement: 'large' }, TEST_RATES), 20.55),
  },
  {
    // Double meal is derived: small + large = 10.90 + 20.55 = 31.45
    name: 'calcMealAllowance: double → $31.45 (derived = small + large)',
    run: () => checkValue('double meal', calcMealAllowance({ mealEntitlement: 'double' }, TEST_RATES), 31.45),
  },
  {
    name: 'calcDoubleMealAllowance: small + large',
    run: () => checkValue('double = small + large', calcDoubleMealAllowance(TEST_RATES), 31.45),
  },
  {
    name: 'calcDoubleMealAllowance: missing rates → $0',
    run: () => checkValue('double meal empty rates', calcDoubleMealAllowance({}), 0),
  },
  {
    name: 'calcMealAllowance: unknown type → $0',
    run: () => checkValue('unknown meal type', calcMealAllowance({ mealEntitlement: 'xyz' }, TEST_RATES), 0),
  },

  // ── Spoilt meals ─────────────────────────────────────────────────────────────

  {
    name: 'calcSpoiltMealAmount: Spoilt → $10.90 (sourced from smallMealAllowance)',
    run: () => checkValue('spoilt meal', calcSpoiltMealAmount({ mealType: 'Spoilt' }, TEST_RATES), 10.90),
  },
  {
    name: 'calcSpoiltMealAmount: Delayed → $10.90 (sourced from smallMealAllowance)',
    run: () => checkValue('delayed meal', calcSpoiltMealAmount({ mealType: 'Delayed' }, TEST_RATES), 10.90),
  },
  {
    name: 'calcSpoiltMealAmount: unknown type → $0',
    run: () => checkValue('unknown spoilt type', calcSpoiltMealAmount({ mealType: 'Other' }, TEST_RATES), 0),
  },

  // ── Legacy compatibility ──────────────────────────────────────────────────────

  {
    name: 'normaliseMealType: "Spoilt / Meal" (legacy) → "Spoilt"',
    run: () => checkValue('legacy meal type normalise', normaliseMealType('Spoilt / Meal'), 'Spoilt'),
  },
  {
    name: 'normaliseMealType: "Spoilt" (current) → "Spoilt" (pass-through)',
    run: () => checkValue('spoilt pass-through', normaliseMealType('Spoilt'), 'Spoilt'),
  },
  {
    name: 'normaliseMealType: "Delayed" (current) → "Delayed" (pass-through)',
    run: () => checkValue('delayed pass-through', normaliseMealType('Delayed'), 'Delayed'),
  },
  {
    name: 'calcSpoiltMealAmount: legacy "Spoilt / Meal" → $10.90 (compatibility)',
    run: () => checkValue('legacy spoilt / meal amount', calcSpoiltMealAmount({ mealType: 'Spoilt / Meal' }, TEST_RATES), 10.90),
  },
  {
    name: 'calcSpoiltClaim: legacy "Spoilt / Meal" → $10.90 (compatibility)',
    run: () => check('legacy spoilt / meal claim', calcSpoiltClaim({ mealType: 'Spoilt / Meal' }, TEST_RATES), { mealAmount: 10.90, totalAmount: 10.90 }),
  },

  // ── Recall ───────────────────────────────────────────────────────────────────

  {
    name: 'calcRecallClaim: typical recall — 20km home, 10km station, small meal',
    run: () => check('recall with meal', calcRecallClaim({
      distHomeKm: 20, distStnKm: 10, mealEntitlement: 'small',
    }, TEST_RATES), {
      totalKm:      30,
      travelAmount: 36.00,  // 30 × 1.20
      mealieAmount: 10.90,
      totalAmount:  46.90,  // 36.00 + 10.90
    }),
  },
  {
    name: 'calcRecallClaim: travel only, no meal',
    run: () => check('recall no meal', calcRecallClaim({
      distHomeKm: 15, distStnKm: 0, mealEntitlement: 'none',
    }, TEST_RATES), {
      totalKm:      15,
      travelAmount: 18.00,  // 15 × 1.20
      mealieAmount: 0,
      totalAmount:  18.00,
    }),
  },
  {
    name: 'calcRecallClaim: zero km, large meal (e.g. recalled while at station)',
    run: () => check('recall large meal zero km', calcRecallClaim({
      distHomeKm: 0, distStnKm: 0, mealEntitlement: 'large',
    }, TEST_RATES), {
      totalKm:      0,
      travelAmount: 0,
      mealieAmount: 20.55, // confirmed FRV flat rate
      totalAmount:  20.55,
    }),
  },
  {
    name: 'calcRecallClaim: zero km, double meal (derived = small + large)',
    run: () => check('recall double meal zero km', calcRecallClaim({
      distHomeKm: 0, distStnKm: 0, mealEntitlement: 'double',
    }, TEST_RATES), {
      totalKm:      0,
      travelAmount: 0,
      mealieAmount: 31.45, // 10.90 + 20.55 (derived)
      totalAmount:  31.45,
    }),
  },
  {
    name: 'calcRecallClaim: all zeros',
    run: () => check('recall all zero', calcRecallClaim({
      distHomeKm: 0, distStnKm: 0, mealEntitlement: 'none',
    }, TEST_RATES), {
      totalKm: 0, travelAmount: 0, mealieAmount: 0, totalAmount: 0,
    }),
  },

  // ── Retain (hours-only FRV calc) ─────────────────────────────────────────────
  // Retain has no configurable hourly rate and no derived dollar amount.

  {
    name: 'calcRetainClaim: pre-trigger Day shift',
    run: () => check('retain pre-trigger', calcRetainClaim({
      shift: 'Day', bookedOffTime: '18:25', overnightCash: 0,
    }, TEST_RATES), {
      generatedHours: 0.50,            // ceil(25/15) × 0.25
      retainAmount: 0,                 // hours-only — no dollar amount
      overnightCash: 0,
      totalAmount: 0,
    }),
  },
  {
    name: 'calcRetainClaim: mandatory min at exact trigger',
    run: () => check('retain min trigger', calcRetainClaim({
      shift: 'Day', bookedOffTime: '19:00', overnightCash: 45.00,
    }, TEST_RATES), {
      generatedHours: 4.00,
      retainAmount: 0,                 // hours-only — no dollar amount
      overnightCash: 45.00,
      totalAmount: 65.55,              // 45 overnight + 20.55 large meal (Day 19:00 → 1× Large)
    }),
  },
  {
    name: 'calcRetainClaim: post-flat-end cross-midnight',
    run: () => check('retain cross-midnight', calcRetainClaim({
      shift: 'Day', bookedOffTime: '00:30', overnightCash: 0,
    }, TEST_RATES), {
      generatedHours: 6.50,
      retainAmount: 0,                 // hours-only — no dollar amount
    }),
  },
  {
    name: 'calcRetainClaim: at-or-before rostered finish → 0',
    run: () => check('retain no-hours', calcRetainClaim({
      shift: 'Day', bookedOffTime: '18:00', overnightCash: 0,
    }, TEST_RATES), {
      generatedHours: 0,
      retainAmount: 0,
      overnightCash: 0,
      totalAmount: 0,
    }),
  },

  // ── Standby ──────────────────────────────────────────────────────────────────

  {
    name: 'calcStandbyClaim: day standby, 12km',
    run: () => check('day standby with travel', calcStandbyClaim({
      distKm: 12, hasNightMeal: false,
    }, TEST_RATES), {
      travelAmount: 14.40,  // 12 × 1.20
      nightMealie:  0,
      totalAmount:  14.40,
    }),
  },
  {
    name: 'calcStandbyClaim: night standby, 8km',
    run: () => check('night standby', calcStandbyClaim({
      distKm: 8, hasNightMeal: true,
    }, TEST_RATES), {
      travelAmount: 9.60,   // 8 × 1.20
      nightMealie:  10.90,
      totalAmount:  20.50,  // 9.60 + 10.90
    }),
  },
  {
    name: 'calcStandbyClaim: night standby, no travel (home station)',
    run: () => check('night standby no travel', calcStandbyClaim({
      distKm: 0, hasNightMeal: true,
    }, TEST_RATES), {
      travelAmount: 0,
      nightMealie:  10.90,
      totalAmount:  10.90,
    }),
  },

  // ── Spoilt claim ─────────────────────────────────────────────────────────────

  {
    name: 'calcSpoiltClaim: Spoilt → $10.90 (sourced from smallMealAllowance)',
    run: () => check('spoilt claim', calcSpoiltClaim({ mealType: 'Spoilt' }, TEST_RATES), {
      mealAmount: 10.90, totalAmount: 10.90,
    }),
  },
  {
    name: 'calcSpoiltClaim: Delayed → $10.90 (sourced from smallMealAllowance)',
    run: () => check('delayed claim', calcSpoiltClaim({ mealType: 'Delayed' }, TEST_RATES), {
      mealAmount: 10.90, totalAmount: 10.90,
    }),
  },

  // ── resolveStoredAmount ───────────────────────────────────────────────────────

  {
    name: 'resolveStoredAmount: prefers total_amount',
    run: () => checkValue('total_amount preferred', resolveStoredAmount({
      total_amount: 50, meal_amount: 22.80, amount: 10,
    }), 50),
  },
  {
    name: 'resolveStoredAmount: falls back to meal_amount',
    run: () => checkValue('meal_amount fallback', resolveStoredAmount({
      total_amount: null, meal_amount: 22.80,
    }), 22.80),
  },
  {
    name: 'resolveStoredAmount: falls back to amount',
    run: () => checkValue('amount fallback', resolveStoredAmount({
      total_amount: null, meal_amount: null, amount: 10,
    }), 10),
  },
  {
    name: 'resolveStoredAmount: all null → 0',
    run: () => checkValue('all null', resolveStoredAmount({
      total_amount: null, meal_amount: null, amount: null,
    }), 0),
  },

  // ── Dashboard summary ─────────────────────────────────────────────────────────

  {
    name: 'calcDashboardSummary: mixed claims',
    run: () => {
      const claims = [
        { claimType: 'recalls', total_amount: 46.25, status: 'Pending' },
        { claimType: 'spoilt',  meal_amount: 22.80,  status: 'Paid' },
        { claimType: 'standby', total_amount: 24.47, status: 'Pending' },
        { claimType: 'retain',  total_amount: 95.00, status: 'Disputed' },
      ]
      const result = calcDashboardSummary(claims)
      return check('dashboard summary', result, {
        grandTotal:   188.52,  // 46.25 + 22.80 + 24.47 + 95.00
        pendingTotal: 70.72,   // 46.25 + 24.47
        paidTotal:    22.80,
      })
    },
  },
  {
    name: 'calcDashboardSummary: empty claims',
    run: () => {
      const result = calcDashboardSummary([])
      return check('empty dashboard', result, {
        grandTotal: 0, pendingTotal: 0, paidTotal: 0,
      })
    },
  },

  // ── Rounding edge cases ───────────────────────────────────────────────────────

  {
    name: 'Rounding: 7.5km × $1.20 = $9.00 (exact)',
    run: () => checkValue('rounding 7.5km', calcTravelAmount({ km: 7.5 }, TEST_RATES), 9.00),
    // 7.5 × 1.20 = 9.00 → exact, no rounding needed
  },
  {
    name: 'Rounding: sum of rounded parts equals rounded total',
    run: () => {
      // This tests that individual roundings don't cause drift in totals
      const result = calcRecallClaim({ distHomeKm: 7.5, distStnKm: 0, mealEntitlement: 'small' }, TEST_RATES)
      // travelAmount = round(7.5 × 1.20) = round(9.00) = 9.00
      // mealieAmount = 10.90
      // totalAmount should = round(9.00 + 10.90) = 19.90
      return checkValue('sum rounding stability', result.totalAmount, 19.90)
    },
  },
  {
    name: 'Rounding: rate change impact — $1.21/km vs $1.20/km on 50km',
    run: () => {
      const at120 = calcTravelAmount({ km: 50 }, { ...TEST_RATES, kilometreRate: 1.20 })
      const at121 = calcTravelAmount({ km: 50 }, { ...TEST_RATES, kilometreRate: 1.21 })
      const diff  = roundMoney(at121 - at120)
      return checkValue('rate change 50km impact', diff, 0.50)
    },
  },
]

// ─── Runner ───────────────────────────────────────────────────────────────────

export function runAllScenarios() {
  const results = SCENARIOS.map((scenario) => {
    try {
      const result = scenario.run()
      return { ...result, scenarioName: scenario.name }
    } catch (err) {
      return {
        scenarioName: scenario.name,
        label: 'ERROR',
        pass: false,
        errors: [err.message],
        actual: null,
      }
    }
  })

  const passed = results.filter((r) => r.pass).length
  const failed = results.filter((r) => !r.pass).length
  const total  = results.length

  return { results, passed, failed, total }
}

// ─── CLI runner (Node.js) ──────────────────────────────────────────────────────

if (typeof process !== 'undefined' && process.argv?.[1]?.includes('validationScenarios')) {
  const { results, passed, failed, total } = runAllScenarios()

  console.log('\n═══ Fire Allowance Tracker — Calculation Validation ═══\n')
  for (const r of results) {
    const icon = r.pass ? '✅' : '❌'
    console.log(`${icon} ${r.scenarioName}`)
    if (!r.pass) {
      for (const e of r.errors) console.log(`     ${e}`)
    }
  }
  console.log(`\n─── Results: ${passed}/${total} passed, ${failed} failed ───\n`)

  if (failed > 0) process.exit(1)
}
