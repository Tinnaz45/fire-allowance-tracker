// Verify FRV retain-hour rules against all supplied examples + edge cases.
// Run: node scripts/verify-retain-hours.mjs

import { calcRetainHours, calcRetainClaim } from '../lib/calculations/engine.js'
import { RETAIN_OVERTIME_HOURLY_RATE } from '../lib/calculations/defaultRates.js'

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

// ── Maint Stn N/N dollar derivation (canonical overtime rate) ─────────────────
console.log()
console.log(`── Maint Stn N/N $ derivation ($${RETAIN_OVERTIME_HOURLY_RATE.toFixed(4)}/h) ──`)
const dollarCases = [
  { shift: 'Day', bookedOffTime: '19:00', expectHours: 4.00, expectAmount: 404.09, label: '4.00h → Maint Stn N/N $404.09' },
  { shift: 'Day', bookedOffTime: '22:15', expectHours: 4.25, expectAmount: 429.35, label: '4.25h → Maint Stn N/N $429.35' },
]
for (const { shift, bookedOffTime, expectHours, expectAmount, label } of dollarCases) {
  const b = calcRetainClaim({ shift, bookedOffTime, overnightCash: 0 }, { smallMealAllowance: 10.90, largeMealAllowance: 20.55 })
  const okH = Math.abs(b.generatedHours - expectHours) < 0.001
  const okA = Math.abs(b.retainAmount - expectAmount) < 0.001
  const ok = okH && okA
  if (ok) pass++; else { fail++; failures.push({ label, expectHours, gotHours: b.generatedHours, expectAmount, gotAmount: b.retainAmount }) }
  console.log(`${ok ? '✓' : '✗'} [${shift}] ${bookedOffTime} → ${b.generatedHours.toFixed(2)}h × $${b.retainHourlyRate.toFixed(4)} = $${b.retainAmount.toFixed(2)}  (${label})`)
}
// Direct rate spot-check: 1.25h → $126.28
{
  const amt = Math.round((1.25 * RETAIN_OVERTIME_HOURLY_RATE + Number.EPSILON) * 100) / 100
  const ok = Math.abs(amt - 126.28) < 0.001
  if (ok) pass++; else { fail++; failures.push({ label: '1.25h → $126.28', gotAmount: amt }) }
  console.log(`${ok ? '✓' : '✗'} 1.25h × $${RETAIN_OVERTIME_HOURLY_RATE.toFixed(4)} = $${amt.toFixed(2)}  (expect $126.28)`)
}

console.log()
console.log(`Total (incl. $): Pass: ${pass}   Fail: ${fail}`)

if (fail > 0) {
  console.log()
  console.log('── FAILURES ──')
  for (const f of failures) console.log(JSON.stringify(f, null, 2))
  process.exit(1)
}
process.exit(0)
