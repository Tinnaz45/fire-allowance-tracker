#!/usr/bin/env node
// ─── Canonical Bridge — DEV integration test ─────────────────────────────────
// End-to-end proof that the LIVE wiring layer — lib/claims/canonicalBridge.js
// (mirrorClaimToCanonical), the function ClaimsContext.addClaim now invokes on
// every Standby / M&D save — maps prototype form fields to canonical
// operational_claims + *_details + claim_entitlements correctly.
//
// This exercises the REAL bridge code (station-label → id resolution, timestamp
// composition, matrix-version pinning, createCanonicalClaim) with a service-role
// fat client injected via the bridge's `client` param — the same path the UI
// runs, minus the browser/auth shell.
//
// SAFETY: DEV-ONLY. Refuses to run unless NEXT_PUBLIC_SUPABASE_URL targets DEV.
// All rows it creates are deleted on exit (cascade); the test profile's
// rostered_station_id is restored.
//
// Run:  node scripts/test-canonical-bridge.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'

const DEV_REF = 'kctctvpobbizhkiqkgqw'

// env MUST be loaded before importing the bridge (lib/supabaseClient.js reads
// NEXT_PUBLIC_* at module-load and throws if absent), so the bridge is pulled in
// via dynamic import below — after loadEnvFile.
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
const { generateAndPersistEntitlements } = await import('../lib/fat/engine/persistEntitlements.js')

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

async function entitlementsFor(claimId) {
  const { data } = await fat.from('claim_entitlements').select('*').eq('claim_id', claimId)
  return data || []
}

async function main() {
  console.log('Canonical bridge (live wiring) — DEV integration test\n')

  // ── Fixtures: active matrix version + a real station pair with a cell ───────
  const { data: cellRows, error: cellErr } = await fat
    .from('station_time_matrix')
    .select('from_station_id, to_station_id, hours, matrix_version')
    .neq('from_station_id', 0)
    .limit(1)
  if (cellErr) throw new Error(`station_time_matrix fixture: ${cellErr.message}`)
  if (!cellRows?.length) throw new Error('No station_time_matrix cells — cannot test excess travel.')
  const { from_station_id: A, to_station_id: B, hours: cellHours, matrix_version: cellVersion } = cellRows[0]

  const { data: stnA } = await fat.from('stations').select('name').eq('id', A).maybeSingle()
  const { data: stnB } = await fat.from('stations').select('name').eq('id', B).maybeSingle()
  // Canonical picker label shape ("FS{id} - {name}") — exactly what the form's
  // StationPicker writes into fields.rosteredStn / fields.standbyStn.
  const labelA = `FS${A} - ${stnA?.name ?? ''}`.trim()
  const labelB = `FS${B} - ${stnB?.name ?? ''}`.trim()
  console.log(`Station pair: rostered ${labelA} (${A}) → dest ${labelB} (${B}); matrix hours=${cellHours}, version=${cellVersion}\n`)

  // ── Pick a test profile + set its rostered_station_id (engine reads this) ───
  const { data: profiles, error: pErr } = await fat.from('profiles').select('id, rostered_station_id').limit(1)
  if (pErr) throw new Error(`profiles fetch: ${pErr.message}`)
  if (!profiles?.length) throw new Error('No fat.profiles rows in DEV to own the test claim.')
  const owner = profiles[0]
  const priorRostered = owner.rostered_station_id ?? null

  const createdClaimIds = []
  try {
    const { error: upErr } = await fat.from('profiles').update({ rostered_station_id: A }).eq('id', owner.id)
    if (upErr) throw new Error(`set rostered_station_id: ${upErr.message}`)

    const claimDate = '2026-06-12'

    // ─── TEST 1: Standby mirror (night arrival ≥ 19:00) ───────────────────────
    console.log('TEST: Standby mirror via mirrorClaimToCanonical()')
    const sb = await mirrorClaimToCanonical({
      client: fat,
      userId: owner.id,
      claimType: 'standby',
      date: claimDate,
      fields: { rosteredStn: labelA, standbyStn: labelB, arrivedTime: '20:00', shift: 'Night', standbyType: 'Standby' },
      routingMeta: null,
    })
    check('mirror returned mirrored:true', sb.mirrored === true, JSON.stringify(sb))
    if (sb.claimId) createdClaimIds.push(sb.claimId)
    check('SB reported 3 entitlements', sb.entitlements === 3, `got ${sb.entitlements}`)

    // Parent operational_claims row
    const { data: sbClaim } = await fat.from('operational_claims').select('*').eq('id', sb.claimId).maybeSingle()
    check('SB operational_claims row exists', !!sbClaim)
    check('  claim_type = SB', sbClaim?.claim_type === 'SB')
    check('  station_id_snapshot = rostered A', sbClaim?.station_id_snapshot === A, `got ${sbClaim?.station_id_snapshot}`)
    check('  station_name_snapshot set', !!sbClaim?.station_name_snapshot)
    check('  source_calculation_mode = frv_matrix', sbClaim?.source_calculation_mode === 'frv_matrix')
    check('  status = submitted', sbClaim?.status === 'submitted')

    // Detail row
    const { data: sbDetail } = await fat.from('standby_details').select('*').eq('claim_id', sb.claimId).maybeSingle()
    check('SB standby_details row exists', !!sbDetail)
    check('  standby_station_id = dest B', sbDetail?.standby_station_id === B, `got ${sbDetail?.standby_station_id}`)
    check('  standby_start_at composed (not null)', !!sbDetail?.standby_start_at, `got ${sbDetail?.standby_start_at}`)
    check('  matrix_version pinned', !!sbDetail?.matrix_version)

    // Entitlements
    const sbRows = await entitlementsFor(sb.claimId)
    const sbExcess = byType(sbRows, 'excess_travel_standby')
    check('SB excess_travel_standby present', !!sbExcess)
    check('  generated_hours == matrix cell', sbExcess && near(sbExcess.generated_hours, cellHours), `${sbExcess?.generated_hours} vs ${cellHours}`)
    check('  unit hours / amount null', sbExcess && sbExcess.unit === 'hours' && sbExcess.generated_amount == null)
    const sbDismi = byType(sbRows, 'standby_dismi')
    check('SB standby_dismi present (0.5h)', !!sbDismi && near(sbDismi.generated_hours, 0.5), `hours=${sbDismi?.generated_hours}`)
    const sbMeal = byType(sbRows, 'small_meal')
    check('SB small_meal present (FFH ≥19:00)', !!sbMeal)
    check('  small_meal dollars-first', sbMeal && sbMeal.unit === 'dollars' && sbMeal.generated_hours == null)
    check('  owner_id stamped on entitlements', sbRows.every((r) => r.owner_id === owner.id))

    // ─── TEST 2: M&D mirror (no arrival time → no small meal) ──────────────────
    console.log('\nTEST: M&D mirror via mirrorClaimToCanonical()')
    const md = await mirrorClaimToCanonical({
      client: fat,
      userId: owner.id,
      claimType: 'md',
      date: claimDate,
      fields: { rosteredStn: labelA, standbyStn: labelB, arrivedTime: '', shift: 'Day', standbyType: 'M&D' },
      routingMeta: null,
    })
    check('mirror returned mirrored:true', md.mirrored === true, JSON.stringify(md))
    if (md.claimId) createdClaimIds.push(md.claimId)
    check('MD reported 2 entitlements', md.entitlements === 2, `got ${md.entitlements}`)

    const { data: mdClaim } = await fat.from('operational_claims').select('*').eq('id', md.claimId).maybeSingle()
    check('MD claim_type = MD', mdClaim?.claim_type === 'MD')
    const { data: mdDetail } = await fat.from('muster_dismiss_details').select('*').eq('claim_id', md.claimId).maybeSingle()
    check('MD muster_dismiss_details row exists', !!mdDetail)
    check('  md_station_id = dest B', mdDetail?.md_station_id === B)
    check('  md_event_at null (no arrival supplied)', mdDetail?.md_event_at == null, `got ${mdDetail?.md_event_at}`)

    const mdRows = await entitlementsFor(md.claimId)
    check('MD excess_travel_md present', !!byType(mdRows, 'excess_travel_md'))
    const mdDismis = byType(mdRows, 'muster_dismis')
    check('MD muster_dismis present (1.0h)', !!mdDismis && near(mdDismis.generated_hours, 1.0), `hours=${mdDismis?.generated_hours}`)
    check('MD has NO small_meal', !byType(mdRows, 'small_meal'))

    // ─── TEST 3: Idempotency / duplicate protection (per claim_id) ─────────────
    console.log('\nTEST: Duplicate protection (regeneration guard)')
    const regen = await generateAndPersistEntitlements(fat, {
      claim: sbClaim,
      details: sbDetail,
      ownerId: owner.id,
    })
    check('Re-generation on same claim is skipped', regen.skipped === true)
    check('Re-generation inserts nothing', regen.inserted.length === 0)
    const { count } = await fat.from('claim_entitlements').select('id', { count: 'exact', head: true }).eq('claim_id', sb.claimId)
    check('SB entitlement count unchanged (no duplicates)', count === 3, `count=${count}`)

    // ─── TEST 4: Non-fatal resilience (unresolvable rostered label) ───────────
    console.log('\nTEST: Non-fatal resilience (free-text station, no FK)')
    const fuzzy = await mirrorClaimToCanonical({
      client: fat,
      userId: owner.id,
      claimType: 'standby',
      date: claimDate,
      fields: { rosteredStn: 'somewhere unparseable', standbyStn: labelB, arrivedTime: '08:00', shift: 'Day', standbyType: 'Standby' },
      routingMeta: null,
    })
    check('mirror still succeeds with unresolved rostered label', fuzzy.mirrored === true, JSON.stringify(fuzzy))
    if (fuzzy.claimId) createdClaimIds.push(fuzzy.claimId)
    const { data: fuzzyClaim } = await fat.from('operational_claims').select('station_id_snapshot').eq('id', fuzzy.claimId).maybeSingle()
    check('  station_id_snapshot is null (no dangling FK)', fuzzyClaim?.station_id_snapshot == null)

  } finally {
    // ─── Cleanup ────────────────────────────────────────────────────────────
    console.log('\nCleanup...')
    for (const id of createdClaimIds) {
      const { error } = await fat.from('operational_claims').delete().eq('id', id)
      if (error) console.error(`  cleanup warning (claim ${id}): ${error.message}`)
    }
    const { error: restErr } = await fat.from('profiles').update({ rostered_station_id: priorRostered }).eq('id', owner.id)
    if (restErr) console.error(`  cleanup warning (restore rostered_station_id): ${restErr.message}`)
    console.log(`  deleted ${createdClaimIds.length} claim(s); restored rostered_station_id=${priorRostered}`)
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
