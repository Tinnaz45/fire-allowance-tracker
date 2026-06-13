// Unit test for lib/featureFlags.js → isPaymentsEnabled().
// Pure env-resolution logic; no network, no DB. Run: node scripts/test-feature-flags.mjs
//
// isPaymentsEnabled() reads process.env at CALL time, so we mutate the env around
// each case and re-call. Resolution order under test:
//   1. NEXT_PUBLIC_PAYMENTS_ENABLED explicit override
//   2. NODE_ENV !== 'production' (local dev server) → ON
//   3. NEXT_PUBLIC_SUPABASE_URL targets the DEV ref → ON
//   4. else (PROD / unknown) → OFF

import { isPaymentsEnabled } from '../lib/featureFlags.js'

const DEV_URL  = 'https://kctctvpobbizhkiqkgqw.supabase.co'
const PROD_URL = 'https://wgcqzamuspuqpedqasbc.supabase.co'

let pass = 0, fail = 0
function expect(label, got, want) {
  const ok = got === want
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(64)} got=${got}  want=${want}`)
  if (ok) pass++; else fail++
}

// Helper: set the env triplet and evaluate.
function evalWith({ explicit, nodeEnv, url }) {
  if (explicit === undefined) delete process.env.NEXT_PUBLIC_PAYMENTS_ENABLED
  else process.env.NEXT_PUBLIC_PAYMENTS_ENABLED = explicit
  process.env.NODE_ENV = nodeEnv
  process.env.NEXT_PUBLIC_SUPABASE_URL = url
  return isPaymentsEnabled()
}

// ── Defaults (no explicit override) ──────────────────────────────────────────
expect('localhost dev server (NODE_ENV=development) → ON',
  evalWith({ explicit: undefined, nodeEnv: 'development', url: PROD_URL }), true)
expect('DEV deployment (prod build, DEV Supabase ref) → ON',
  evalWith({ explicit: undefined, nodeEnv: 'production', url: DEV_URL }), true)
expect('PROD deployment (prod build, PROD Supabase ref) → OFF',
  evalWith({ explicit: undefined, nodeEnv: 'production', url: PROD_URL }), false)
expect('Unknown target (prod build, blank URL) → OFF (fail-safe)',
  evalWith({ explicit: undefined, nodeEnv: 'production', url: '' }), false)
expect('localhost prod build w/ DEV creds → ON',
  evalWith({ explicit: undefined, nodeEnv: 'production', url: DEV_URL }), true)

// ── Explicit override wins over every environment default ─────────────────────
expect('override true forces ON even on PROD',
  evalWith({ explicit: 'true', nodeEnv: 'production', url: PROD_URL }), true)
expect('override 1 forces ON even on PROD',
  evalWith({ explicit: '1', nodeEnv: 'production', url: PROD_URL }), true)
expect('override on forces ON even on PROD',
  evalWith({ explicit: 'on', nodeEnv: 'production', url: PROD_URL }), true)
expect('override false forces OFF even on localhost dev',
  evalWith({ explicit: 'false', nodeEnv: 'development', url: DEV_URL }), false)
expect('override 0 forces OFF even on DEV',
  evalWith({ explicit: '0', nodeEnv: 'production', url: DEV_URL }), false)
expect('override off forces OFF even on DEV',
  evalWith({ explicit: 'off', nodeEnv: 'production', url: DEV_URL }), false)

// ── Blank / unrecognised override falls through to defaults ───────────────────
expect('blank override on PROD → falls through → OFF',
  evalWith({ explicit: '', nodeEnv: 'production', url: PROD_URL }), false)
expect('garbage override on DEV → falls through → ON',
  evalWith({ explicit: 'maybe', nodeEnv: 'production', url: DEV_URL }), true)
expect('whitespace override on PROD → falls through → OFF',
  evalWith({ explicit: '  ', nodeEnv: 'production', url: PROD_URL }), false)

console.log()
console.log(`Total: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`)
process.exit(fail > 0 ? 1 : 0)
