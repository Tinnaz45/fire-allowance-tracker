#!/usr/bin/env node
// ─── Rostered-station backfill — real-profile validation ─────────────────────
// Proves that AFTER the DEV backfill (profile_ext.station_id →
// profiles.rostered_station_id), the canonical engine generates excess-travel
// entitlements for a REAL user using their ACTUAL persisted rostered station —
// with NO test-side override of rostered_station_id.
//
// This is the missing half of test-canonical-bridge.mjs: that test forces
// rostered_station_id to an arbitrary matrix cell's from-station and restores it
// afterwards (it proves the wiring, not the data). Here we instead pick the real
// profile whose rostered_station_id is already populated, choose a destination
// that has a live (rostered → dest) hours-matrix cell, and confirm:
//   • SB  → excess_travel_standby (hours == cell) + standby_dismi + small_meal
//   • M&D → excess_travel_md      (hours == cell) + muster_dismis
//
// SAFETY: DEV-ONLY. Refuses to run unless NEXT_PUBLIC_SUPABASE_URL targets DEV.
// Only the operational_claims rows it creates are deleted on exit (cascade).
// fat.profiles.rostered_station_id is NEVER written — it is the real value.
//
// Run:  node scripts/validate-rostered-station-backfill.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'

const DEV_REF = 'kctctvpobbizhkiqkgqw'

try { process.loadEnvFile('.env.local') } catch { /* fall back to ambient env */ }
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env.local).')
  process.exit(2)
}
if (!URL.includes(DEV_REF)) {
  console.error(`REFUSING TO RUN: NEXT_PUBLIC_SUPABASE_URL does not target DEV (${DEV_REF}). Got: ${URL}`)
  process.exit(2)
}

const { mirrorClaimToCanonical } = await import('../lib/claims/canonicalBridge.js')

const fat = createClient(URL, KEY, { db: { schema: 'fat' } })

let passed = 0
let failed = 0
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const byType = (rows, t) => rows.find((r) => r.entitlement_type === t)
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6
async function entitlementsFor(claimId) {
  const { data } = await fat.from('claim_entitlements').select('*').eq('claim_id', claimId)
  return data || []
}

async function main() {
  console.log('Rostered-station backfill — real-profile validation (DEV)\n')

  // ── 1. Pick a REAL profile whose rostered_station_id is already populated ────
  // No override — this is exactly what the backfill produced for live users.
  const { data: profiles, error: pErr } = await fat
    .from('profiles')
    .select('id, first_name, last_name, rostered_station_id')
    .not('rostered_station_id', 'is', null)
    .limit(1)
  if (pErr) throw new Error(`profiles fetch: ${pErr.message}`)
  if (!profiles?.length) {
    throw new Error('No fat.profiles row has rostered_station_id populated — backfill did not run or no eligible users.')
  }
  const owner = profiles[0]
  const rostered = owner.rostered_station_id
  const { data: rStn } = await fat.from('stations').select('name').eq('id', rostered).maybeSingle()
  console.log(`Real owner: ${owner.first_name} ${owner.last_name} (${owner.id})`)
  console.log(`Persisted rostered_station_id = ${rostered} (${rStn?.name ?? '?'}) — NOT overridden\n`)

  // ── 2. Choose a destination with a live (rostered → dest) hours-matrix cell ──
  const { data: cells, error: cErr } = await fat
    .from('station_time_matrix')
    .select('to_station_id, hours, matrix_version')
    .eq('from_station_id', rostered)
    .neq('to_station_id', rostered)
    .order('hours', { ascending: false })
    .limit(1)
  if (cErr) throw new Error(`station_time_matrix fetch: ${cErr.message}`)
  if (!cells?.length) {
    throw new Error(`No station_time_matrix cell from rostered station ${rostered} — cannot exercise excess travel.`)
  }
  const dest = cells[0].to_station_id
  const cellHours = cells[0].hours
  const { data: dStn } = await fat.from('stations').select('name').eq('id', dest).maybeSingle()
  const labelRostered = `FS${rostered} - ${rStn?.name ?? ''}`.trim()
  const labelDest     = `FS${dest} - ${dStn?.name ?? ''}`.trim()
  console.log(`Excess-travel leg: ${labelRostered} (${rostered}) → ${labelDest} (${dest}); cell hours=${cellHours}\n`)

  const claimDate = '2026-06-12'
  const createdClaimIds = []
  try {
    // ─── SB: night arrival ≥ 19:00 (fixed standby_dismi + small_meal + excess) ─
    console.log('TEST: Standby mirror with REAL rostered station')
    const sb = await mirrorClaimToCanonical({
      client: fat,
      userId: owner.id,
      claimType: 'standby',
      date: claimDate,
      fields: { rosteredStn: labelRostered, standbyStn: labelDest, arrivedTime: '20:00', shift: 'Night', standbyType: 'Standby' },
      routingMeta: null,
    })
    check('SB mirror returned mirrored:true', sb.mirrored === true, JSON.stringify(sb))
    if (sb.claimId) createdClaimIds.push(sb.claimId)
    const sbRows = await entitlementsFor(sb.claimId)
    const sbExcess = byType(sbRows, 'excess_travel_standby')
    check('SB excess_travel_standby GENERATES (real profile)', !!sbExcess)
    check('  excess hours == matrix cell', sbExcess && near(sbExcess.generated_hours, cellHours), `${sbExcess?.generated_hours} vs ${cellHours}`)
    check('  excess unit=hours, amount null (hours-first)', sbExcess && sbExcess.unit === 'hours' && sbExcess.generated_amount == null)
    check('SB fixed standby_dismi still generates (0.5h)', !!byType(sbRows, 'standby_dismi') && near(byType(sbRows, 'standby_dismi').generated_hours, 0.5))
    check('SB small_meal still generates (FFH ≥19:00)', !!byType(sbRows, 'small_meal'))

    // ─── M&D: no arrival time (fixed muster_dismis + excess, no small meal) ─────
    console.log('\nTEST: M&D mirror with REAL rostered station')
    const md = await mirrorClaimToCanonical({
      client: fat,
      userId: owner.id,
      claimType: 'md',
      date: claimDate,
      fields: { rosteredStn: labelRostered, standbyStn: labelDest, arrivedTime: '', shift: 'Day', standbyType: 'M&D' },
      routingMeta: null,
    })
    check('MD mirror returned mirrored:true', md.mirrored === true, JSON.stringify(md))
    if (md.claimId) createdClaimIds.push(md.claimId)
    const mdRows = await entitlementsFor(md.claimId)
    const mdExcess = byType(mdRows, 'excess_travel_md')
    check('MD excess_travel_md GENERATES (real profile)', !!mdExcess)
    check('  excess hours == matrix cell', mdExcess && near(mdExcess.generated_hours, cellHours), `${mdExcess?.generated_hours} vs ${cellHours}`)
    check('MD fixed muster_dismis still generates (1.0h)', !!byType(mdRows, 'muster_dismis') && near(byType(mdRows, 'muster_dismis').generated_hours, 1.0))
    check('MD has NO small_meal (no arrival)', !byType(mdRows, 'small_meal'))
  } finally {
    console.log('\nCleanup (claims only — rostered_station_id left intact)...')
    for (const id of createdClaimIds) {
      const { error } = await fat.from('operational_claims').delete().eq('id', id)
      if (error) console.error(`  cleanup warning (claim ${id}): ${error.message}`)
    }
    console.log(`  deleted ${createdClaimIds.length} claim(s)`)
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
