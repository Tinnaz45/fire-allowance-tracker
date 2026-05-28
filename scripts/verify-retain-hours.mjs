// Verify FRV retain-hour rules against all supplied examples + edge cases.
// Run: node scripts/verify-retain-hours.mjs

import { calcRetainHours, calcRetainClaim } from '../lib/calculations/engine.js'

const cases = [
  // ── Day shift ─────────────────────────────────────────────────────────────
  { shift: 'Day',   bookedOffTime: '17:59', expected: 24.00, label: 'Day before-rostered-finish (cross-midnight, capped)' },
  { shift: 'Day',   bookedOffTime: '18:00', expected: 0.00,  label: 'Day at rostered finish (no retain)' },
  { shift: 'Day',   bookedOffTime: '18:01', expected: 0.25,  label: 'Day 1 min past finish (ceil to 0.25h)' },
  { shift: 'Day',   bookedOffTime: '18:15', expected: 0.25,  label: 'Day 18:15 example' },
  { shift: 'Day',   bookedOffTime: '18:25', expected: 0.50,  label: 'Day 18:25 example' },
  { shift: 'Day',   bookedOffTime: '18:55', expected: 1.00,  label: 'Day 18:55 example' },
  { shift: 'Day',   bookedOffTime: '18:59', expected: 1.00,  label: 'Day just before trigger (still pre-trigger)' },
  { shift: 'Day',   bookedOffTime: '19:00', expected: 4.00,  label: 'Day exact trigger → 4.00h mandatory min' },
  { shift: 'Day',   bookedOffTime: '20:30', expected: 4.00,  label: 'Day mid-flat-window → 4.00h' },
  { shift: 'Day',   bookedOffTime: '22:00', expected: 4.00,  label: 'Day at flat-end boundary → 4.00h' },
  { shift: 'Day',   bookedOffTime: '22:01', expected: 4.25,  label: 'Day 22:01 example' },
  { shift: 'Day',   bookedOffTime: '22:15', expected: 4.25,  label: 'Day 22:15 example' },
  { shift: 'Day',   bookedOffTime: '22:16', expected: 4.50,  label: 'Day 22:16 → next 0.25h bump' },
  { shift: 'Day',   bookedOffTime: '23:00', expected: 5.00,  label: 'Day 23:00 → 4 + 1h' },
  { shift: 'Day',   bookedOffTime: '00:30', expected: 6.50,  label: 'Day 00:30 cross-midnight example' },

  // ── Night shift (mirror of Day at 08:00 / 09:00 / 12:00) ─────────────────
  { shift: 'Night', bookedOffTime: '08:00', expected: 0.00,  label: 'Night at rostered finish (no retain)' },
  { shift: 'Night', bookedOffTime: '08:15', expected: 0.25,  label: 'Night 08:15 (parallel of Day 18:15)' },
  { shift: 'Night', bookedOffTime: '08:25', expected: 0.50,  label: 'Night 08:25 (parallel of Day 18:25)' },
  { shift: 'Night', bookedOffTime: '08:55', expected: 1.00,  label: 'Night 08:55 (parallel of Day 18:55)' },
  { shift: 'Night', bookedOffTime: '09:00', expected: 4.00,  label: 'Night exact trigger → 4.00h' },
  { shift: 'Night', bookedOffTime: '11:30', expected: 4.00,  label: 'Night mid-flat-window → 4.00h' },
  { shift: 'Night', bookedOffTime: '12:00', expected: 4.00,  label: 'Night at flat-end → 4.00h' },
  { shift: 'Night', bookedOffTime: '12:01', expected: 4.25,  label: 'Night 12:01 → 4.25h' },
  { shift: 'Night', bookedOffTime: '12:15', expected: 4.25,  label: 'Night 12:15 → 4.25h' },
  { shift: 'Night', bookedOffTime: '14:30', expected: 6.50,  label: 'Night 14:30 → 4 + 2.5h = 6.50h' },
  { shift: 'Night', bookedOffTime: '07:59', expected: 24.00, label: 'Night next-day before finish → capped at 24h' },
]

let pass = 0
let fail = 0
const failures = []

for (const { shift, bookedOffTime, expected, label } of cases) {
  const { hours, rulePath, explanation } = calcRetainHours({ shift, bookedOffTime })
  const ok = Math.abs(hours - expected) < 1e-9
  const tag = ok ? '✓' : '✗'
  const detail = `[${shift}] ${bookedOffTime} → ${hours.toFixed(2)}h (expected ${expected.toFixed(2)}h)`
  console.log(`${tag} ${detail.padEnd(50)} ${rulePath.padEnd(20)} :: ${label}`)
  if (ok) pass++
  else { fail++; failures.push({ label, expected, got: hours, rulePath, explanation }) }
}

console.log()
console.log(`Total: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`)

// ── Dollar derivation: with rate set ──────────────────────────────────────
console.log()
console.log('── Dollar derivation sanity check ──')
const breakdown = calcRetainClaim(
  { shift: 'Day', bookedOffTime: '22:15', overnightCash: 0 },
  { retainHourlyRate: 32.50, smallMealAllowance: 10.90, largeMealAllowance: 20.55 }
)
console.log('Day 22:15 @ $32.50/h:')
console.log(`  generatedHours      = ${breakdown.generatedHours.toFixed(2)}h`)
console.log(`  retainAmount        = $${breakdown.retainAmount.toFixed(2)} (expect $138.13 = 4.25 × 32.50)`)
console.log(`  retainHourlyRate    = $${breakdown.retainHourlyRate.toFixed(2)}`)
console.log(`  retainRulePath      = ${breakdown.retainRulePath}`)
console.log(`  retainExplanation   = ${breakdown.retainExplanation}`)

// ── Zero rate: hours still calculated, $0 ────────────────────────────────
const zeroRate = calcRetainClaim(
  { shift: 'Day', bookedOffTime: '19:00', overnightCash: 0 },
  { retainHourlyRate: 0, smallMealAllowance: 10.90, largeMealAllowance: 20.55 }
)
console.log()
console.log('Day 19:00 @ $0/h (rate not yet set):')
console.log(`  generatedHours = ${zeroRate.generatedHours.toFixed(2)}h (expect 4.00)`)
console.log(`  retainAmount   = $${zeroRate.retainAmount.toFixed(2)} (expect $0.00)`)

if (fail > 0) {
  console.log()
  console.log('── FAILURES ──')
  for (const f of failures) console.log(JSON.stringify(f, null, 2))
  process.exit(1)
}
process.exit(0)
