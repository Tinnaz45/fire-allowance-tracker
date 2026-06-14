#!/usr/bin/env node
// ─── OCR Payslip Import MVP (O1–O4) — DEV integration test ───────────────────
// Proves the manual-entry-first staging pipeline end-to-end against DEV:
//
//   O1  staging tables exist + owner-only RLS (exercised via service-role writes)
//   O2  ManualEntryAdapter shapes operator input into canonical lines (no OCR)
//   O3  import + line lifecycle transitions (canonical vocabulary, no synonyms)
//   O4  staging services: createImport / addImportLines / updateLineResolution /
//       confirmImportLine — the confirm bridge composing the migration-08 RPCs.
//
// Success criterion (architecture § 8): an operator can type N payslip lines, move
// them through the lifecycle, confirm a line and watch a payment_records row appear
// and the entitlement flip to paid; ignore/reject lines with no canonical write;
// and the owner-coherence invariant line.owner_id == p_actor_id == record.owner_id
// holds on BOTH the linked and record-only confirm paths (§ 6.1 step 0 / O8).
//
// SAFETY: DEV-ONLY. Refuses unless NEXT_PUBLIC_SUPABASE_URL targets DEV. Every row
// it creates is deleted on exit; the test profile's rostered_station_id is restored.
//
// Run:  node scripts/test-payslip-import.mjs
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
const { getPaymentRecord } = await import('../lib/fat/services/paymentRecords.js')
const { manualEntryAdapter, ManualEntryAdapter } = await import('../lib/fat/adapters/manualEntryAdapter.js')
const {
  IMPORT_STATUS, IMPORT_LINE_STATUS,
  canTransitionImport, canTransitionLine,
  IMPORT_SOURCE_TO_RECORD_SOURCE,
} = await import('../lib/fat/models/payslipImport.js')
const {
  createImport, updateImportStatus, getImport, listImports,
  addImportLines, listImportLines, updateLineResolution,
  confirmImportLine, createManualEntryImport,
} = await import('../lib/fat/services/payslipImports.js')

const fat = createClient(URL, KEY, { db: { schema: 'fat' } })

// ── tiny assert harness ─────────────────────────────────────────────────────
let passed = 0, failed = 0
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
async function expectThrow(label, fn) {
  try { await fn(); check(label, false, 'expected throw, got success') }
  catch { check(label, true) }
}
const byType = (rows, t) => rows.find((r) => r.entitlement_type === t)

async function main() {
  console.log('OCR Payslip Import MVP (O1–O4) — DEV integration test\n')

  // ── Pure unit checks: adapter + lifecycle vocabulary (no DB) ────────────────
  console.log('UNIT: ManualEntryAdapter + lifecycle vocabulary (§ 2, § 4, § 9)')
  const adapterOut = await manualEntryAdapter.parse({
    pay_date: '2026-06-19',
    pay_period_ref: 'PP-13',
    lines: [
      { reference: 'EXCESS TRAVEL', description: 'excess travel SB', amount: '50.00', date: '2026-06-19' },
      { reference: 'STANDBY', description: 'standby dismissal', amount: '' },
      { reference: 'MEAL', description: 'small meal', amount: '18.5' },
    ],
  })
  check('adapter emits one canonical line per input row', adapterOut.lines.length === 3)
  check('adapter parses line_index 0..n', adapterOut.lines.every((l, i) => l.line_index === i))
  check('adapter coerces amount to number', adapterOut.lines[0].parsed_amount === 50)
  check('adapter leaves blank amount null (hours-first line)', adapterOut.lines[1].parsed_amount === null)
  check('adapter carries pay_date + pay_period_ref', adapterOut.pay_date === '2026-06-19' && adapterOut.pay_period_ref === 'PP-13')
  check('adapter stamps parser name/version', adapterOut.parser_name === 'manual_entry' && !!adapterOut.parser_version)
  check('adapter is a ManualEntryAdapter (no OCR)', manualEntryAdapter instanceof ManualEntryAdapter)
  await expectThrow('adapter rejects empty line set', () => manualEntryAdapter.parse({ lines: [] }))
  await expectThrow('adapter rejects a negative amount', () => manualEntryAdapter.parse({ lines: [{ amount: '-5' }] }))
  await expectThrow('adapter rejects a non-ISO date', () => manualEntryAdapter.parse({ lines: [{ date: '19/06/2026' }] }))

  check('import lifecycle: uploaded → parsing legal', canTransitionImport('uploaded', 'parsing'))
  check('import lifecycle: needs_review → confirmed legal', canTransitionImport('needs_review', 'confirmed'))
  check('import lifecycle: confirmed → superseded ILLEGAL (immutable records)', !canTransitionImport('confirmed', 'superseded'))
  check('import lifecycle: failed → parsing legal (re-parse)', canTransitionImport('failed', 'parsing'))
  check('line lifecycle: parsed → confirmed legal', canTransitionLine('parsed', 'confirmed'))
  check('line lifecycle: rejected → confirmed ILLEGAL (terminal)', !canTransitionLine('rejected', 'confirmed'))
  check('no synonyms: "reviewing"/"draft" are not statuses', !canTransitionImport('uploaded', 'draft') && !canTransitionLine('parsed', 'reviewing'))
  check('source map manual_entry → manual (§ 6.2)', IMPORT_SOURCE_TO_RECORD_SOURCE.manual_entry === 'manual')

  // ── Fixtures: a Standby canonical claim (SB/MD arrive pre-routed to payslip) ─
  const { data: cellRows } = await fat
    .from('station_time_matrix')
    .select('from_station_id, to_station_id, hours, matrix_version')
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
  const createdRecordIds = []
  try {
    await fat.from('profiles').update({ rostered_station_id: A }).eq('id', owner.id)
    const claimDate = '2026-06-19'

    console.log('\nSETUP: Standby canonical claim (excess_travel + standby_dismi + small_meal)')
    const sb = await mirrorClaimToCanonical({
      client: fat, userId: owner.id, claimType: 'standby', date: claimDate,
      fields: { rosteredStn: labelA, standbyStn: labelB, arrivedTime: '20:00', shift: 'Night', standbyType: 'Standby' },
    })
    if (sb.claimId) createdClaimIds.push(sb.claimId)
    check('claim mirrored with 3 entitlements', sb.mirrored && sb.entitlements === 3, JSON.stringify(sb))
    const { data: ents } = await fat.from('claim_entitlements').select('*').eq('claim_id', sb.claimId)
    const excess = byType(ents, 'excess_travel_standby')   // hours-first, payslip
    const dismi  = byType(ents, 'standby_dismi')           // hours-first, payslip
    const meal   = byType(ents, 'small_meal')              // dollars-first, petty_cash
    check('SB/MD entitlements are pre-routed to payslip', excess.payment_method === 'payslip' && dismi.payment_method === 'payslip')

    // ════════════════════════════════════════════════════════════════════════
    // O2+O3+O4: manual import end-to-end through the lifecycle
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: createManualEntryImport walks uploaded → parsing → parsed → needs_review (§ 4.1)')
    const { import: imp, lines } = await createManualEntryImport({
      ownerId: owner.id,
      form: {
        pay_date: claimDate,
        pay_period_ref: 'PP-13',
        lines: [
          { reference: 'EXCESS TRAVEL', description: 'excess travel SB', amount: '50.00' },
          { reference: 'STANDBY DISMISSAL', description: 'standby dismissal', amount: '0' },
          { reference: 'UNION FEE', description: 'payroll noise — not mine', amount: '12.00' },
          { reference: 'GARBAGE', description: 'misread row', amount: '999.00' },
        ],
      },
    }, fat)
    createdImportIds.push(imp.id)
    check('import created with source manual_entry', imp.source === 'manual_entry')
    check('import rested at needs_review', imp.status === IMPORT_STATUS.NEEDS_REVIEW, imp.status)
    check('import line_count = 4', imp.line_count === 4, String(imp.line_count))
    check('4 lines materialized at status parsed', lines.length === 4 && lines.every((l) => l.status === IMPORT_LINE_STATUS.PARSED))
    check('lines own owner_id denormalized', lines.every((l) => l.owner_id === owner.id))

    const [lExcess, lDismi, lIgnore, lReject] = lines.sort((a, b) => a.line_index - b.line_index)

    // ── update line: move a line to needs_review, attach a candidate suggestion ─
    console.log('\nTEST: updateLineResolution (operator edits a staging line, § 4.2)')
    const reviewed = await updateLineResolution({
      lineId: lExcess.id, status: IMPORT_LINE_STATUS.NEEDS_REVIEW,
      candidateEntitlementId: excess.id, resolutionNote: 'looks like the SB excess travel',
    }, fat)
    check('line moved parsed → needs_review', reviewed.status === IMPORT_LINE_STATUS.NEEDS_REVIEW)
    check('candidate entitlement suggestion stored', reviewed.candidate_entitlement_id === excess.id)
    await expectThrow('updateLineResolution refuses to set confirmed (must use the bridge)', () =>
      updateLineResolution({ lineId: lDismi.id, status: 'confirmed' }, fat))
    // reject + ignore-style lines (no canonical write)
    const rejected = await updateLineResolution({ lineId: lReject.id, status: IMPORT_LINE_STATUS.REJECTED, resolutionNote: 'OCR misread' }, fat)
    check('reject line is terminal rejected', rejected.status === IMPORT_LINE_STATUS.REJECTED)
    const ignored = await updateLineResolution({ lineId: lIgnore.id, status: IMPORT_LINE_STATUS.REJECTED, resolutionNote: 'out-of-scope payroll line' }, fat)
    check('out-of-scope line marked rejected (no canonical row)', ignored.status === IMPORT_LINE_STATUS.REJECTED)
    await expectThrow('updateLineResolution refuses an illegal transition (rejected → needs_review)', () =>
      updateLineResolution({ lineId: lReject.id, status: IMPORT_LINE_STATUS.NEEDS_REVIEW }, fat))

    // ════════════════════════════════════════════════════════════════════════
    // O4 confirm bridge — LINKED path (operator chose a routed payslip entitlement)
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: confirmImportLine LINKED path → record + link + entitlement flips paid (§ 6.1)')
    const beforeStatus = excess.payment_status
    const cLinked = await confirmImportLine({
      lineId: lExcess.id, actorId: owner.id,
      entitlementId: excess.id, linkKind: 'manual', allocatedAmount: 0,
    }, fat)
    check('linked confirm returned a payment_record_id', !!cLinked.payment_record_id, JSON.stringify(cLinked))
    check('linked confirm reports linked=true', cLinked.linked === true)
    check('linked confirm flipped entitlement → paid', cLinked.link_result?.new_status === 'paid', JSON.stringify(cLinked.link_result))
    createdRecordIds.push(cLinked.payment_record_id)

    const rec = await getPaymentRecord(cLinked.payment_record_id, fat)
    check('payment record exists, stream payslip', rec && rec.stream === 'payslip')
    check('record source mapped manual_entry → manual (§ 6.2)', rec.source === 'manual')
    check('OWNER COHERENCE: line.owner == actor == record.owner (linked path, § 6.1 step 0)',
      lExcess.owner_id === owner.id && rec.owner_id === owner.id)
    check('record raw_payload carries import + line provenance', rec.raw_payload?.import_id === imp.id && rec.raw_payload?.line_id === lExcess.id)

    const { data: excAfter } = await fat.from('claim_entitlements').select('payment_status').eq('id', excess.id).maybeSingle()
    check('entitlement persisted as paid', excAfter?.payment_status === 'paid', `${beforeStatus} → ${excAfter?.payment_status}`)

    const { data: lineAfter } = await fat.from('payslip_import_lines').select('*').eq('id', lExcess.id).maybeSingle()
    check('staging line stamped confirmed + record + link', lineAfter.status === 'confirmed' && lineAfter.payment_record_id === cLinked.payment_record_id && !!lineAfter.link_id)

    // audit row written by the composed link RPC
    const { data: auditRows } = await fat.from('reconciliation_audit').select('*').eq('entitlement_id', excess.id).eq('action', 'link_payment')
    check('reconciliation_audit recorded the link_payment transition (§ 7)', (auditRows ?? []).length >= 1)

    // ════════════════════════════════════════════════════════════════════════
    // O4 confirm bridge — RECORD-ONLY path (no entitlement chosen, § 6.4)
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: confirmImportLine RECORD-ONLY path → record, no link (§ 6.4)')
    const cRecordOnly = await confirmImportLine({ lineId: lDismi.id, actorId: owner.id }, fat)
    check('record-only confirm produced a record', !!cRecordOnly.payment_record_id)
    check('record-only confirm reports linked=false', cRecordOnly.linked === false)
    check('record-only confirm has no link_id', !cRecordOnly.link_id)
    createdRecordIds.push(cRecordOnly.payment_record_id)
    const rec2 = await getPaymentRecord(cRecordOnly.payment_record_id, fat)
    check('OWNER COHERENCE: line.owner == actor == record.owner (record-only path, § 6.1 step 0)',
      lDismi.owner_id === owner.id && rec2.owner_id === owner.id)
    const { data: noLinks } = await fat.from('entitlement_payment_links').select('id').eq('payment_record_id', cRecordOnly.payment_record_id)
    check('record-only line created NO link rows (unallocated queue)', (noLinks ?? []).length === 0)

    console.log('\nTEST: confirm reaches import status confirmed once all lines resolve (§ 4.1)')
    const impFinal = await getImport(imp.id, fat)
    check('import reached confirmed (all 4 lines terminal: 2 confirmed, 2 rejected)', impFinal.status === IMPORT_STATUS.CONFIRMED, impFinal.status)
    check('import confirmed_at stamped', !!impFinal.confirmed_at)

    // ════════════════════════════════════════════════════════════════════════
    // Guards: idempotency + owner coherence refusal + terminal refusal
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: confirm bridge guards (§ 6.1, § 6.3)')
    const cIdem = await confirmImportLine({ lineId: lExcess.id, actorId: owner.id, entitlementId: excess.id, linkKind: 'manual' }, fat)
    check('re-confirm is idempotent (no second record)', cIdem.idempotent === true && cIdem.payment_record_id === cLinked.payment_record_id, JSON.stringify(cIdem))
    const { count: recCount } = await fat.from('payment_records').select('id', { count: 'exact', head: true }).eq('owner_id', owner.id).contains('raw_payload', { line_id: lExcess.id })
    check('still exactly one record for the confirmed line', recCount === 1, String(recCount))

    await expectThrow('confirm refuses a wrong-owner actor (§ 6.1 step 0)', () =>
      confirmImportLine({ lineId: lDismi.id, actorId: '00000000-0000-0000-0000-000000000000' }, fat))
    await expectThrow('confirm refuses a rejected (terminal) line', () =>
      confirmImportLine({ lineId: lReject.id, actorId: owner.id }, fat))
    await expectThrow('confirm refuses a petty_cash-routed entitlement (stream mismatch)', () => {
      // a fresh parsed line to attempt the bad confirm on
      return addImportLines({ importId: imp.id, ownerId: owner.id, lines: [{ line_index: 99, parsed_amount: 5, parsed_date: claimDate }] }, fat)
        .then(([badLine]) => confirmImportLine({ lineId: badLine.id, actorId: owner.id, entitlementId: meal.id, linkKind: 'manual' }, fat))
    })

    console.log('\nTEST: list helpers')
    const allImports = await listImports(owner.id, {}, fat)
    check('listImports returns the created import', allImports.some((i) => i.id === imp.id))
    const allLines = await listImportLines(imp.id, {}, fat)
    check('listImportLines returns lines ordered by line_index', allLines.length >= 4 && allLines[0].line_index <= allLines[1].line_index)

  } finally {
    console.log('\nCleanup...')
    for (const id of createdRecordIds) {
      const { error } = await fat.from('payment_records').delete().eq('id', id)
      if (error) console.error(`  cleanup warning (record ${id}): ${error.message}`)
    }
    for (const id of createdImportIds) {
      const { error } = await fat.from('payslip_imports').delete().eq('id', id) // cascade removes lines
      if (error) console.error(`  cleanup warning (import ${id}): ${error.message}`)
    }
    for (const id of createdClaimIds) {
      const { error } = await fat.from('operational_claims').delete().eq('id', id)
      if (error) console.error(`  cleanup warning (claim ${id}): ${error.message}`)
    }
    await fat.from('profiles').update({ rostered_station_id: priorRostered }).eq('id', owner.id)
    console.log(`  deleted ${createdRecordIds.length} record(s), ${createdImportIds.length} import(s), ${createdClaimIds.length} claim(s); restored rostered_station_id=${priorRostered}`)
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
