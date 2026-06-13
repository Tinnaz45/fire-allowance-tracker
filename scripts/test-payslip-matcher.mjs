#!/usr/bin/env node
// ─── OCR Payslip Import — candidate matcher (Step O4) — DEV integration test ──
// Proves the candidate-recommendation engine that pre-fills the review queue:
//
//   UNIT  pure signal scorers + re-normalization (hours-first reaches the bands
//         despite an absent amount signal — blocker #8 resolution) + the
//         identifying-evidence guard (date proximity never matches on its own).
//   DB    listPayslipMatchCandidates hard filters (payslip + pending only;
//         petty-cash excluded), scoreImportLines persists candidate +
//         match_confidence + match_breakdown, and createManualEntryImport
//         auto-scores new imports. Operator confirmation stays mandatory — the
//         matcher writes ONLY the three suggestion columns, never canonical state.
//
// SAFETY: DEV-ONLY. Refuses unless NEXT_PUBLIC_SUPABASE_URL targets DEV. Every row
// it creates is deleted on exit; the test profile's rostered_station_id is restored.
//
// Run:  node scripts/test-payslip-matcher.mjs
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
const { createManualEntryImport } = await import('../lib/fat/services/payslipImports.js')
const {
  scoreCandidate, rankCandidates, confidenceBand, inferLineType,
  scoreAmount, scorePayCycle, scoreReference, scoreType,
  listPayslipMatchCandidates, scoreImportLines,
  MATCH_THRESHOLDS, SIGNAL_WEIGHTS, MATCHER_NAME,
} = await import('../lib/fat/services/payslipMatcher.js')

const fat = createClient(URL, KEY, { db: { schema: 'fat' } })

// ── tiny assert harness ─────────────────────────────────────────────────────
let passed = 0, failed = 0
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const byType = (rows, t) => rows.find((r) => r.entitlement_type === t)

async function main() {
  console.log('OCR Payslip Import — candidate matcher (Step O4) — DEV integration test\n')

  // ── PURE UNIT: signal scorers + combination ─────────────────────────────────
  console.log('UNIT: signal scorers (§ 5.2)')
  const entHours = { id: 'e-hours', entitlement_type: 'excess_travel_standby', unit: 'hours', generated_hours: 0.5, generated_amount: null, payment_method: 'payslip', payment_status: 'pending', _claim_date: '2026-06-19' }
  const entDollars = { id: 'e-dollars', entitlement_type: 'small_meal', unit: 'dollars', generated_amount: 10.9, generated_hours: null, payment_method: 'payslip', payment_status: 'pending', _claim_date: '2026-06-19' }
  const lineExcess = { parsed_reference: 'EXCESS TRAVEL', parsed_description: 'excess travel SB', parsed_amount: 50, parsed_date: '2026-06-19' }

  check('scoreAmount: exact dollars match → 1', scoreAmount({ parsed_amount: 10.9 }, entDollars).score === 1)
  check('scoreAmount: NOT applicable for hours-first (blocker #8)', scoreAmount(lineExcess, entHours).applicable === false)
  check('scoreAmount: relative closeness for a near miss', Math.abs(scoreAmount({ parsed_amount: 9.81 }, entDollars).score - 0.9) < 0.02)

  check('scorePayCycle: same day → 1', scorePayCycle(lineExcess, entHours, '2026-06-19').score === 1)
  const farCycle = scorePayCycle({ parsed_date: '2026-08-30' }, entHours, null)
  check('scorePayCycle: far apart → low', farCycle.applicable && farCycle.score < 0.2)
  check('scorePayCycle: NOT applicable with no dates', scorePayCycle({}, { id: 'x' }, null).applicable === false)

  check('scoreReference: token overlap with type label', scoreReference(lineExcess, entHours).score > 0.5)
  check('inferLineType: "EXCESS TRAVEL" → excess_travel_*', String(inferLineType(lineExcess)).startsWith('excess_travel'))
  check('scoreType: matching family → high', scoreType(lineExcess, entHours).score >= 0.5)
  check('scoreType: "MEAL" vs excess_travel → conflict 0', scoreType({ parsed_description: 'meal allowance' }, entHours).score === 0)

  console.log('\nUNIT: scoreCandidate combination + re-normalization (§ 5.2, blocker #8)')
  const scHours = scoreCandidate(lineExcess, entHours, { importPayDate: '2026-06-19' })
  check('hours-first amount signal not applicable', scHours.signals.amount.applicable === false)
  check('hours-first re-normalizes over the 0.55 applicable weight', Math.abs(scHours.applicable_weight - 0.55) < 1e-9, String(scHours.applicable_weight))
  check('hours-first STILL reaches a band (confidence > review threshold)', scHours.confidence >= MATCH_THRESHOLDS.REVIEW, String(scHours.confidence))
  check('confidence is a re-normalized mean, not a capped 0.55 sum', scHours.confidence > 0.6, String(scHours.confidence))
  check('identifying evidence present (type+reference)', scHours.identifying === true)

  const scDollars = scoreCandidate({ parsed_reference: 'SMALL MEAL', parsed_description: 'small meal', parsed_amount: 10.9, parsed_date: '2026-06-19' }, entDollars, { importPayDate: '2026-06-19' })
  check('dollars-first uses all four signals (amount applicable)', scDollars.signals.amount.applicable === true && Math.abs(scDollars.applicable_weight - 1) < 1e-9)
  check('dollars-first exact match → auto band', scDollars.band === 'auto', `${scDollars.confidence}`)

  console.log('\nUNIT: identifying-evidence guard (date alone never matches)')
  const noiseLine = { parsed_reference: 'UNION FEE', parsed_description: 'payroll deduction', parsed_amount: 12, parsed_date: '2026-06-19' }
  const scNoise = scoreCandidate(noiseLine, entHours, { importPayDate: '2026-06-19' })
  check('payroll-noise line in the pay window scores 0 (no identifying signal)', scNoise.confidence === 0 && scNoise.identifying === false, String(scNoise.confidence))
  check('confidenceBand: 0.95→auto, 0.6→review, 0.3→none', confidenceBand(0.95) === 'auto' && confidenceBand(0.6) === 'review' && confidenceBand(0.3) === 'none')
  check('SIGNAL_WEIGHTS sum to 1.0', Math.abs(Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9)

  console.log('\nUNIT: rankCandidates orders by confidence, best first')
  const ranked = rankCandidates(lineExcess, [entDollars, entHours], { importPayDate: '2026-06-19' })
  check('ranked best is the excess_travel hours entitlement', ranked[0].entitlement_id === entHours.id, JSON.stringify(ranked.map((r) => [r.entitlement?.entitlement_type, r.confidence])))

  // ── DB FIXTURE: a Standby claim (hours-first payslip ents + a petty-cash meal) ─
  const { data: cellRows } = await fat
    .from('station_time_matrix')
    .select('from_station_id, to_station_id')
    .neq('from_station_id', 0).limit(1)
  if (!cellRows?.length) throw new Error('No station_time_matrix cells — cannot generate excess travel.')
  const { from_station_id: A, to_station_id: B } = cellRows[0]
  const { data: stnA } = await fat.from('stations').select('name').eq('id', A).maybeSingle()
  const { data: stnB } = await fat.from('stations').select('name').eq('id', B).maybeSingle()
  const labelA = `FS${A} - ${stnA?.name ?? ''}`.trim()
  const labelB = `FS${B} - ${stnB?.name ?? ''}`.trim()

  const { data: profiles } = await fat.from('profiles').select('id, rostered_station_id').limit(1)
  if (!profiles?.length) throw new Error('No fat.profiles rows in DEV.')
  const owner = profiles[0]
  const priorRostered = owner.rostered_station_id ?? null

  const createdClaimIds = []
  const createdImportIds = []
  try {
    await fat.from('profiles').update({ rostered_station_id: A }).eq('id', owner.id)
    const claimDate = '2026-06-19'

    console.log('\nSETUP: Standby canonical claim (excess_travel_standby + standby_dismi + small_meal)')
    const sb = await mirrorClaimToCanonical({
      client: fat, userId: owner.id, claimType: 'standby', date: claimDate,
      fields: { rosteredStn: labelA, standbyStn: labelB, arrivedTime: '20:00', shift: 'Night', standbyType: 'Standby' },
    })
    if (sb.claimId) createdClaimIds.push(sb.claimId)
    check('claim mirrored with 3 entitlements', sb.mirrored && sb.entitlements === 3, JSON.stringify(sb))
    const { data: ents } = await fat.from('claim_entitlements').select('*').eq('claim_id', sb.claimId)
    const excess = byType(ents, 'excess_travel_standby')  // hours-first, payslip
    const dismi = byType(ents, 'standby_dismi')           // hours-first, payslip
    const meal = byType(ents, 'small_meal')               // dollars-first, PETTY CASH

    // ── candidate hard filters (§ 5.1) ────────────────────────────────────────
    console.log('\nTEST: listPayslipMatchCandidates hard filters (§ 5.1)')
    const cands = await listPayslipMatchCandidates(owner.id, fat)
    check('candidates include the new payslip excess entitlement', cands.some((c) => c.id === excess.id))
    check('candidates include the new payslip standby_dismi entitlement', cands.some((c) => c.id === dismi.id))
    check('candidates EXCLUDE the petty-cash small_meal (stream filter)', !cands.some((c) => c.id === meal.id))
    check('every candidate is payslip + pending', cands.every((c) => c.payment_method === 'payslip' && c.payment_status === 'pending'))
    check('candidates carry the embedded claim date for date proximity', cands.find((c) => c.id === excess.id)?._claim_date === claimDate)

    // ── createManualEntryImport auto-scores (Step O4 wired into creation) ───────
    console.log('\nTEST: createManualEntryImport auto-scores new lines')
    const { import: imp, lines } = await createManualEntryImport({
      ownerId: owner.id,
      form: {
        pay_date: claimDate,
        pay_period_ref: 'PP-13',
        lines: [
          { reference: 'EXCESS TRAVEL', description: 'excess travel standby', amount: '50.00' },
          { reference: 'STANDBY DISMISSAL', description: 'standby dismissal', amount: '25.00' },
          { reference: 'UNION FEE', description: 'payroll deduction — not mine', amount: '12.00' },
        ],
      },
    }, fat)
    createdImportIds.push(imp.id)
    const [lExcess, lDismi, lNoise] = lines.sort((a, b) => a.line_index - b.line_index)

    check('excess line was auto-scored with a candidate', !!lExcess.candidate_entitlement_id && lExcess.match_confidence > 0, JSON.stringify({ c: lExcess.candidate_entitlement_id, m: lExcess.match_confidence }))
    check('excess line top candidate is an excess_travel entitlement', cands.find((c) => c.id === lExcess.candidate_entitlement_id)?.entitlement_type?.startsWith('excess_travel'))
    check('excess line confidence clears the review band', lExcess.match_confidence >= MATCH_THRESHOLDS.REVIEW, String(lExcess.match_confidence))
    check('excess line breakdown: amount NOT applicable (hours-first)', lExcess.match_breakdown?.signals?.amount?.applicable === false)
    check('excess line breakdown stamped matcher identity', lExcess.match_breakdown?.matcher === MATCHER_NAME)

    check('standby line matched standby_dismi', cands.find((c) => c.id === lDismi.candidate_entitlement_id)?.entitlement_type === 'standby_dismi', String(lDismi.candidate_entitlement_id))
    check('standby line is a strong/likely match', ['auto', 'review'].includes(lDismi.match_breakdown?.band), JSON.stringify(lDismi.match_breakdown?.band))

    check('payroll-noise line got NO candidate pre-fill (identifying guard)', !lNoise.candidate_entitlement_id, String(lNoise.candidate_entitlement_id))
    check('payroll-noise line confidence is 0 / no band', (lNoise.match_confidence ?? 0) === 0 && lNoise.match_breakdown?.band === 'none')

    // ── the matcher never touched canonical state nor the line lifecycle ────────
    console.log('\nTEST: matcher is evidence-only (no lifecycle / canonical writes)')
    check('scored lines remain at status parsed (no synonym, no transition)', lines.every((l) => l.status === 'parsed'))
    const { count: linkCount } = await fat.from('entitlement_payment_links').select('id', { count: 'exact', head: true }).eq('entitlement_id', excess.id)
    check('no payment links created by matching', (linkCount ?? 0) === 0)
    const { data: excAfter } = await fat.from('claim_entitlements').select('payment_status').eq('id', excess.id).maybeSingle()
    check('entitlement payment_status untouched (still pending)', excAfter?.payment_status === 'pending')

    // ── scoreImportLines is idempotent + re-runnable ───────────────────────────
    console.log('\nTEST: scoreImportLines re-run is idempotent')
    const rerun = await scoreImportLines({ importId: imp.id, ownerId: owner.id }, fat)
    check('re-run scored the 3 open lines again', rerun.scored === 3, String(rerun.scored))
    const rExcess = rerun.lines.find((l) => l.id === lExcess.id)
    check('re-run yields the same excess candidate + confidence', rExcess.candidate_entitlement_id === lExcess.candidate_entitlement_id && Number(rExcess.match_confidence) === Number(lExcess.match_confidence))

  } finally {
    console.log('\nCleanup...')
    for (const id of createdImportIds) {
      const { error } = await fat.from('payslip_imports').delete().eq('id', id) // cascade removes lines
      if (error) console.error(`  cleanup warning (import ${id}): ${error.message}`)
    }
    for (const id of createdClaimIds) {
      const { error } = await fat.from('operational_claims').delete().eq('id', id)
      if (error) console.error(`  cleanup warning (claim ${id}): ${error.message}`)
    }
    await fat.from('profiles').update({ rostered_station_id: priorRostered }).eq('id', owner.id)
    console.log(`  deleted ${createdImportIds.length} import(s), ${createdClaimIds.length} claim(s); restored rostered_station_id=${priorRostered}`)
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
