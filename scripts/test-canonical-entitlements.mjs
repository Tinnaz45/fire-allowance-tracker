#!/usr/bin/env node
// ─── Canonical Entitlement Generation — DEV integration test ─────────────────
// End-to-end proof that creating a Standby (SB) or Muster & Dismiss (MD)
// canonical operational claim generates and persists fat.claim_entitlements
// with correct units, rate snapshots, matrix-version snapshots, and idempotency.
//
// Exercises lib/fat/engine/persistEntitlements.js (which runs the pure engine
// in lib/fat/engine/ over a Supabase-backed context from context.js).
//
// SAFETY: DEV-ONLY. Refuses to run unless NEXT_PUBLIC_SUPABASE_URL points at the
// DEV project. All rows it creates are deleted on exit (cascade), and the test
// profile's rostered_station_id is restored.
//
// Required env (loaded from .env.local): NEXT_PUBLIC_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.
//
// Run:  node scripts/test-canonical-entitlements.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'
import {
  createCanonicalClaim,
  generateAndPersistEntitlements,
  resolveActiveMatrixVersion,
} from '../lib/fat/engine/persistEntitlements.js'

const DEV_REF = 'kctctvpobbizhkiqkgqw'

// ── env ───────────────────────────────────────────────────────────────────────
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

const fat = createClient(URL, KEY, { db: { schema: 'fat' } })

// ── tiny assert harness ─────────────────────────────────────────────────────
let passed = 0
let failed = 0
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const byType = (rows, t) => rows.find((r) => r.entitlement_type === t)
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6

async function main() {
  console.log('Canonical entitlement generation — DEV integration test\n')

  // ── Resolve fixtures: active matrix version + a real station pair with a cell ─
  const matrixVersion = await resolveActiveMatrixVersion(fat)
  console.log(`Active hours matrix version: ${matrixVersion}`)

  const { data: cellRows, error: cellErr } = await fat
    .from('station_time_matrix')
    .select('from_station_id, to_station_id, hours')
    .eq('matrix_version', matrixVersion)
    .neq('from_station_id', 0)
    .limit(1)
  if (cellErr) throw new Error(`station_time_matrix fixture: ${cellErr.message}`)
  if (!cellRows?.length) throw new Error('No station_time_matrix cells under the active version — cannot test excess travel.')
  const { from_station_id: A, to_station_id: B, hours: cellHours } = cellRows[0]
  console.log(`Station pair: rostered=${A} → dest=${B} (matrix hours=${cellHours})\n`)

  const { data: stnA } = await fat.from('stations').select('name').eq('id', A).maybeSingle()

  // ── Pick a test profile + temporarily set its rostered_station_id ────────────
  const { data: profiles, error: pErr } = await fat
    .from('profiles')
    .select('id, rostered_station_id')
    .limit(1)
  if (pErr) throw new Error(`profiles fetch: ${pErr.message}`)
  if (!profiles?.length) throw new Error('No fat.profiles rows in DEV to own the test claim.')
  const owner = profiles[0]
  const priorRostered = owner.rostered_station_id ?? null

  const createdClaimIds = []
  try {
    const { error: upErr } = await fat.from('profiles').update({ rostered_station_id: A }).eq('id', owner.id)
    if (upErr) throw new Error(`set rostered_station_id: ${upErr.message}`)

    const claimDate = '2026-06-10'

    // ─── TEST 1: Standby claim ────────────────────────────────────────────────
    console.log('TEST: Standby (SB) claim generation')
    const sb = await createCanonicalClaim(fat, {
      ownerId: owner.id,
      claimType: 'SB',
      claimDate,
      stationIdSnapshot: A,
      stationNameSnapshot: stnA?.name ?? null,
      sourceCalculationMode: 'frv_matrix',
      details: {
        standby_station_id: B,
        // Local 20:00 (no tz offset) → getHours() === 20 ≥ 19 → small-meal trigger,
        // independent of the machine timezone.
        standby_start_at: `${claimDate}T20:00:00`,
        matrix_version: matrixVersion,
      },
    })
    createdClaimIds.push(sb.claim.id)
    const sbRows = sb.persist.inserted
    check('SB generated 3 entitlements', sbRows.length === 3, `got ${sbRows.length}`)

    const sbExcess = byType(sbRows, 'excess_travel_standby')
    check('SB excess_travel_standby present', !!sbExcess)
    if (sbExcess) {
      check('  unit = hours', sbExcess.unit === 'hours')
      check('  generated_hours == matrix cell', near(sbExcess.generated_hours, cellHours), `${sbExcess.generated_hours} vs ${cellHours}`)
      check('  generated_amount is null (hours-first)', sbExcess.generated_amount == null)
      check('  rate_snapshot.matrix_version matches', sbExcess.rate_snapshot?.matrix_version === matrixVersion)
      check('  rate_snapshot carries from/to stations', sbExcess.rate_snapshot?.from_station_id === A && sbExcess.rate_snapshot?.to_station_id === B)
      check('  payment payslip/pending', sbExcess.payment_method === 'payslip' && sbExcess.payment_status === 'pending')
    }

    const sbDismi = byType(sbRows, 'standby_dismi')
    check('SB standby_dismi present', !!sbDismi)
    if (sbDismi) {
      check('  unit = hours, 0.5h', sbDismi.unit === 'hours' && near(sbDismi.generated_hours, 0.5), `hours=${sbDismi.generated_hours}`)
      check('  rate_snapshot.code = standby_hours', sbDismi.rate_snapshot?.code === 'standby_hours')
      check('  rate_id + rate_version_id set', !!sbDismi.rate_id && !!sbDismi.rate_version_id)
    }

    const sbMeal = byType(sbRows, 'small_meal')
    check('SB small_meal present (night arrival ≥19:00)', !!sbMeal)
    if (sbMeal) {
      check('  unit = dollars, $10.90', sbMeal.unit === 'dollars' && near(sbMeal.generated_amount, 10.9), `amt=${sbMeal.generated_amount}`)
      check('  generated_hours is null (dollars-first)', sbMeal.generated_hours == null)
      check('  payment petty_cash/outstanding', sbMeal.payment_method === 'petty_cash' && sbMeal.payment_status === 'outstanding')
    }

    // ─── TEST 2: Muster & Dismiss claim ───────────────────────────────────────
    console.log('\nTEST: Muster & Dismiss (MD) claim generation')
    const md = await createCanonicalClaim(fat, {
      ownerId: owner.id,
      claimType: 'MD',
      claimDate,
      stationIdSnapshot: A,
      stationNameSnapshot: stnA?.name ?? null,
      sourceCalculationMode: 'frv_matrix',
      details: {
        md_station_id: B,
        md_event_at: `${claimDate}T09:00:00`,
        matrix_version: matrixVersion,
      },
    })
    createdClaimIds.push(md.claim.id)
    const mdRows = md.persist.inserted
    check('MD generated 2 entitlements', mdRows.length === 2, `got ${mdRows.length}`)

    const mdExcess = byType(mdRows, 'excess_travel_md')
    check('MD excess_travel_md present', !!mdExcess)
    if (mdExcess) {
      check('  unit = hours == matrix cell', mdExcess.unit === 'hours' && near(mdExcess.generated_hours, cellHours))
      check('  rate_snapshot.matrix_version matches', mdExcess.rate_snapshot?.matrix_version === matrixVersion)
    }
    const mdDismis = byType(mdRows, 'muster_dismis')
    check('MD muster_dismis present', !!mdDismis)
    if (mdDismis) {
      check('  unit = hours, 1.0h', mdDismis.unit === 'hours' && near(mdDismis.generated_hours, 1.0), `hours=${mdDismis.generated_hours}`)
      check('  rate_snapshot.code = md_hours', mdDismis.rate_snapshot?.code === 'md_hours')
    }
    check('MD has NO small_meal', !byType(mdRows, 'small_meal'))

    // ─── TEST 3: Regeneration protection + no duplicates ──────────────────────
    console.log('\nTEST: Regeneration protection (idempotency)')
    const regen = await generateAndPersistEntitlements(fat, {
      claim: sb.claim,
      details: { standby_station_id: B, standby_start_at: `${claimDate}T20:00:00`, matrix_version: matrixVersion },
      ownerId: owner.id,
    })
    check('Second generation is skipped', regen.skipped === true)
    check('Second generation inserts nothing', regen.inserted.length === 0)

    const { count, error: cntErr } = await fat
      .from('claim_entitlements')
      .select('id', { count: 'exact', head: true })
      .eq('claim_id', sb.claim.id)
    if (cntErr) throw new Error(`count check: ${cntErr.message}`)
    check('SB entitlement count unchanged after re-run (no duplicates)', count === 3, `count=${count}`)

  } finally {
    // ─── Cleanup: delete claims (cascade → details + entitlements), restore profile ─
    console.log('\nCleanup...')
    for (const id of createdClaimIds) {
      const { error } = await fat.from('operational_claims').delete().eq('id', id)
      if (error) console.error(`  cleanup warning (claim ${id}): ${error.message}`)
    }
    const { error: restErr } = await fat.from('profiles').update({ rostered_station_id: priorRostered }).eq('id', owner.id)
    if (restErr) console.error(`  cleanup warning (restore rostered_station_id): ${restErr.message}`)
    console.log(`  deleted ${createdClaimIds.length} claim(s); restored rostered_station_id=${priorRostered}`)
  }

  // ── verify cleanup actually removed entitlements (cascade) ──────────────────
  const { count: leftover } = await fat
    .from('claim_entitlements')
    .select('id', { count: 'exact', head: true })
    .in('claim_id', createdClaimIds.length ? createdClaimIds : ['00000000-0000-0000-0000-000000000000'])
  check('Cleanup cascaded (0 leftover entitlements)', (leftover ?? 0) === 0, `leftover=${leftover}`)

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
