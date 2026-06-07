#!/usr/bin/env node
// ─── payment_method schema-cache fix — DEV verification ──────────────────────
// Proves the root cause and the fix at the exact PostgREST layer the app hits:
//
//   ROOT CAUSE: ClaimsContext wrote `payment_method` onto fat.standby /
//   fat.spoilt_meals INSERT payloads, but neither prototype table has that
//   column → PostgREST rejects with "Could not find the 'payment_method'
//   column of 'standby' in the schema cache". This blocked BOTH Standby and
//   Muster & Dismiss saves (M&D is a fat.standby row with standby_type='M&D').
//
//   FIX: payment_method tagging lives only on canonical fat.claim_entitlements
//   (written by the entitlement engine). The 3 prototype writes were removed.
//
// This script inserts the EXACT column sets ClaimsContext now builds, both WITH
// payment_method (must reproduce the error) and WITHOUT (must succeed), through
// the same supabase-js + schema('fat') path the UI uses. All rows are deleted.
//
// SAFETY: DEV-ONLY. Refuses to run unless URL targets DEV.
// Run:  node scripts/verify-payment-method-fix.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'

const DEV_REF = 'kctctvpobbizhkiqkgqw'
try { process.loadEnvFile('.env.local') } catch { /* ambient env */ }
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env.local).'); process.exit(2) }
if (!URL.includes(DEV_REF)) { console.error(`REFUSING TO RUN: URL not DEV (${DEV_REF}). Got: ${URL}`); process.exit(2) }

const fat = createClient(URL, KEY, { db: { schema: 'fat' } })

const USER_ID = '7c90ba30-2b55-4d45-8d97-d631bc0ca1e6'
const FY_ID   = '40f30d91-a0e6-4e4e-b780-539b1bb48b4c'
const DATE    = '2099-01-01' // sentinel date, cleaned up regardless

let passed = 0, failed = 0
const created = [] // {table, id}
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

// Column sets mirroring ClaimsContext (current, fixed) — minus payment_method.
const standbyParent = (type) => ({
  user_id: USER_ID, date: DATE, status: 'Pending', standby_type: type, shift: 'Day',
  rostered_stn_label: 'TEST-ROST', standby_stn_label: 'TEST-DEST',
  dist_km: 0, travel_amount: 0, night_mealie: 0, total_amount: 0, adjusted_amount: null,
  financial_year_id: FY_ID, calculation_inputs: { autoChild: type === 'M&D' ? 'md_event' : 'standby_and_dismi' },
})
const excessTravelChild = () => ({
  user_id: USER_ID, date: DATE, status: 'Pending', standby_type: 'Standby', shift: 'Day',
  dist_km: 12, travel_amount: 9.99, night_mealie: 0, total_amount: 9.99,
  financial_year_id: FY_ID, calculation_inputs: { autoChild: 'standby_excess_travel', distKm: 12 },
})
const smallMealChild = () => ({
  user_id: USER_ID, date: DATE, status: 'Pending', meal_type: 'Spoilt', shift: 'Night',
  meal_amount: 5.55, total_amount: 5.55, financial_year_id: FY_ID,
  calculation_inputs: { autoChild: 'standby_small_meal' },
})

async function insertOK(table, row, label) {
  const { data, error } = await fat.from(table).insert(row).select('id').single()
  check(label, !error, error?.message || '')
  if (data?.id) created.push({ table, id: data.id })
  return !error
}
async function insertReproducesBug(table, row, label) {
  const { error } = await fat.from(table).insert({ ...row, payment_method: 'Payslip' }).select('id').single()
  const isSchemaCache = !!error && /payment_method/i.test(error.message) && /schema cache|could not find/i.test(error.message)
  check(label, isSchemaCache, error ? `got: ${error.message}` : 'INSERT unexpectedly succeeded')
}

async function main() {
  console.log('payment_method schema-cache fix — DEV verification\n')

  console.log('1) Reproduce the reported bug (payload WITH payment_method must be rejected):')
  await insertReproducesBug('standby', standbyParent('Standby'), "Standby parent + payment_method → schema-cache error")
  await insertReproducesBug('standby', standbyParent('M&D'),     "M&D parent + payment_method → schema-cache error")
  await insertReproducesBug('spoilt_meals', smallMealChild(),    "Small-meal child + payment_method → schema-cache error")

  console.log('\n2) Confirm the fix (current column sets, NO payment_method, must succeed):')
  await insertOK('standby', standbyParent('Standby'), 'Standby parent saves')
  await insertOK('standby', standbyParent('M&D'),     'Muster & Dismiss parent saves')
  await insertOK('standby', excessTravelChild(),      'Excess Travel child (Payslip) saves')
  await insertOK('spoilt_meals', smallMealChild(),    'Small Meal Allowance child (Petty Cash) saves')

  // cleanup
  console.log('\n3) Cleanup:')
  let cleaned = 0
  for (const { table, id } of created) {
    const { error } = await fat.from(table).delete().eq('id', id)
    if (!error) cleaned++; else console.error(`  ! failed to delete ${table}/${id}: ${error.message}`)
  }
  check(`removed all ${created.length} test rows`, cleaned === created.length)

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
