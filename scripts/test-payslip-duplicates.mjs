#!/usr/bin/env node
// ─── Payslip Import — Duplicate Detection (blocker #1) — DEV integration test ──
// Proves the content-based duplicate-detection layer end-to-end against DEV:
//
//   · pure fingerprint model: determinism, order-independence, Jaccard, period match
//   · SQL line trigger stamps payslip_import_lines.content_fingerprint (migration 12)
//   · detectImportDuplicates: clear / exact / near verdicts + duplicate_check metadata
//   · the confirm-bridge double-confirmation GUARD blocks a second confirm of
//     identical content, and the explicit operator OVERRIDE proceeds (objectives 7+8)
//   · listConfirmedLineFingerprints surfaces the confirmed fingerprint
//
// SAFETY: DEV-ONLY. Refuses unless NEXT_PUBLIC_SUPABASE_URL targets DEV. Every row it
// creates is deleted on exit.
//
// Run:  node scripts/test-payslip-duplicates.mjs
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

const {
  importContentFingerprint, lineSetSimilarity, samePayPeriod, DUP_THRESHOLDS,
} = await import('../lib/fat/models/payslipFingerprint.js')
const {
  createManualEntryImport, confirmImportLine, getImport, listImportLines,
} = await import('../lib/fat/services/payslipImports.js')
const {
  detectImportDuplicates, listConfirmedLineFingerprints,
} = await import('../lib/fat/services/payslipDuplicates.js')

const fat = createClient(URL, KEY, { db: { schema: 'fat' } })

// ── tiny assert harness ─────────────────────────────────────────────────────
let passed = 0, failed = 0
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
async function expectThrow(label, fn, predicate = () => true) {
  try { await fn(); check(label, false, 'expected throw, got success') }
  catch (err) { check(label, predicate(err), `threw but predicate failed: ${err.message}`) }
}

// Unique per-run tag so this import's content can never collide with prior test data.
const TAG = `DUP-${Date.now().toString(36)}`
const PAY = '2026-07-03'
const PERIOD = `PP-${TAG}`

// The canonical 3-line payslip A re-uses (B is identical, C shares 2 of 3).
const lineA = (n) => ({ reference: `${TAG}-REF-${n}`, description: `line ${n} ${TAG}`, amount: `${10 + n}.00` })

async function main() {
  console.log('Payslip Import — Duplicate Detection (blocker #1) — DEV integration test\n')

  // ── UNIT: pure fingerprint model (no DB) ────────────────────────────────────
  console.log('UNIT: fingerprint model (payslipFingerprint.js)')
  const fpBase = { source: 'manual_entry', payDate: PAY, payPeriodRef: PERIOD, lineFingerprints: ['aa', 'bb', 'cc'] }
  const fp1 = importContentFingerprint(fpBase)
  const fp2 = importContentFingerprint({ ...fpBase, lineFingerprints: ['cc', 'aa', 'bb'] })
  check('import fingerprint is deterministic + order-independent', fp1 === fp2, `${fp1} vs ${fp2}`)
  check('import fingerprint is versioned (imp1:)', fp1.startsWith('imp1:'))
  const fpDiff = importContentFingerprint({ ...fpBase, lineFingerprints: ['aa', 'bb'] })
  check('a different line set yields a different fingerprint', fp1 !== fpDiff)
  const fpPeriod = importContentFingerprint({ ...fpBase, payPeriodRef: 'OTHER' })
  check('a different pay period yields a different fingerprint', fp1 !== fpPeriod)

  const sim = lineSetSimilarity(['a', 'b', 'c'], ['b', 'c', 'd'])
  check('Jaccard: 2 shared of 4 union → 0.5', sim.score === 0.5 && sim.shared === 2 && sim.union === 4, JSON.stringify(sim))
  check('Jaccard: empty sets → 0 (not vacuous 1)', lineSetSimilarity([], []).score === 0)
  check('Jaccard: identical sets → 1', lineSetSimilarity(['x', 'y'], ['y', 'x']).score === 1)
  check('samePayPeriod by ref', samePayPeriod({ pay_period_ref: 'pp-1' }, { pay_period_ref: 'PP-1' }))
  check('samePayPeriod by date when no ref', samePayPeriod({ pay_date: PAY }, { pay_date: PAY }))
  check('different period not same', !samePayPeriod({ pay_period_ref: 'a' }, { pay_period_ref: 'b' }))
  check('thresholds present', DUP_THRESHOLDS.NEAR_SIMILARITY === 0.5 && DUP_THRESHOLDS.PERIOD_COINCIDENT_MIN_SHARED === 1)

  const { data: profiles } = await fat.from('profiles').select('id').limit(1)
  if (!profiles?.length) throw new Error('No fat.profiles rows in DEV.')
  const owner = profiles[0]

  const createdImportIds = []
  const createdRecordIds = []
  try {
    // ════════════════════════════════════════════════════════════════════════
    // Import A — three unique lines. First of its kind ⇒ verdict 'clear'.
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: import A (unique) → detection verdict clear; line fingerprints stamped')
    const { import: impA, lines: linesA } = await createManualEntryImport({
      ownerId: owner.id,
      form: { pay_date: PAY, pay_period_ref: PERIOD, lines: [lineA(1), lineA(2), lineA(3)] },
    }, fat)
    createdImportIds.push(impA.id)
    check('A: 3 lines materialized', linesA.length === 3)
    check('A: every line has a content_fingerprint (SQL trigger)', linesA.every((l) => !!l.content_fingerprint), JSON.stringify(linesA.map((l) => l.content_fingerprint)))
    check('A: duplicate_check verdict = clear', impA.duplicate_check?.verdict === 'clear', JSON.stringify(impA.duplicate_check))
    check('A: import content_fingerprint persisted', !!impA.content_fingerprint)

    // ════════════════════════════════════════════════════════════════════════
    // Import B — byte-identical to A ⇒ verdict 'exact', names A.
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: import B (identical to A) → detection verdict exact, names A')
    const { import: impB, lines: linesB } = await createManualEntryImport({
      ownerId: owner.id,
      form: { pay_date: PAY, pay_period_ref: PERIOD, lines: [lineA(1), lineA(2), lineA(3)] },
    }, fat)
    createdImportIds.push(impB.id)
    check('B: verdict = exact', impB.duplicate_check?.verdict === 'exact', JSON.stringify(impB.duplicate_check))
    check('B: exact list names import A', (impB.duplicate_check?.exact ?? []).some((e) => e.import_id === impA.id))
    check('B: shares A\'s import fingerprint', impB.content_fingerprint === impA.content_fingerprint)

    // ════════════════════════════════════════════════════════════════════════
    // Import C — 2 of A's lines + 1 new, same pay period ⇒ verdict 'near'.
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: import C (2 of 3 shared, same period) → detection verdict near')
    const { import: impC } = await createManualEntryImport({
      ownerId: owner.id,
      form: { pay_date: PAY, pay_period_ref: PERIOD, lines: [lineA(1), lineA(2), { reference: `${TAG}-REF-NEW`, description: 'fresh', amount: '99.00' }] },
    }, fat)
    createdImportIds.push(impC.id)
    check('C: verdict = near', impC.duplicate_check?.verdict === 'near', JSON.stringify(impC.duplicate_check))
    const cNear = impC.duplicate_check?.near ?? []
    check('C: near list includes A and/or B with shared lines', cNear.some((n) => n.shared_lines >= 2 && [impA.id, impB.id].includes(n.import_id)), JSON.stringify(cNear))
    check('C: near match flagged same_pay_period', cNear.some((n) => n.same_pay_period === true))

    // re-run detection explicitly (idempotent) — verdict stable
    const reC = await detectImportDuplicates({ importId: impC.id, ownerId: owner.id }, fat)
    check('C: re-running detection is stable (still near)', reC.verdict === 'near')

    // ════════════════════════════════════════════════════════════════════════
    // GUARD — confirm A.line[0] (record-only), then the identical B.line[0].
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: double-confirmation guard blocks identical content; override proceeds (§ 4)')
    const a0 = linesA.find((l) => l.line_index === 0)
    const b0 = linesB.find((l) => l.line_index === 0)
    check('A.line0 and B.line0 share a content_fingerprint', a0.content_fingerprint === b0.content_fingerprint)

    const confA = await confirmImportLine({ lineId: a0.id, actorId: owner.id }, fat)  // record-only
    check('A.line0 confirmed → payment record created', !!confA.payment_record_id, JSON.stringify(confA))
    createdRecordIds.push(confA.payment_record_id)

    await expectThrow(
      'confirming identical B.line0 is BLOCKED (DUPLICATE_CONFIRMED)',
      () => confirmImportLine({ lineId: b0.id, actorId: owner.id }, fat),
      (err) => err.code === 'DUPLICATE_CONFIRMED'
        && err.duplicate?.duplicate_record_id === confA.payment_record_id,
    )

    // line B.line0 must remain unconfirmed (no record minted by the blocked attempt)
    const { data: b0After } = await fat.from('payslip_import_lines').select('status, payment_record_id').eq('id', b0.id).maybeSingle()
    check('blocked attempt left B.line0 un-confirmed (no record)', b0After.status !== 'confirmed' && !b0After.payment_record_id, JSON.stringify(b0After))

    // explicit operator override → proceeds and mints a SECOND record
    const confB = await confirmImportLine({ lineId: b0.id, actorId: owner.id, allowDuplicate: true }, fat)
    check('override confirm proceeds (allowDuplicate)', !!confB.payment_record_id && confB.payment_record_id !== confA.payment_record_id, JSON.stringify(confB))
    check('override reports duplicate_overridden = true', confB.duplicate_overridden === true)
    createdRecordIds.push(confB.payment_record_id)

    // two distinct records now carry the same line fingerprint
    const { data: dupeRecs } = await fat.from('payment_records')
      .select('id, raw_payload').eq('owner_id', owner.id)
      .contains('raw_payload', { content_fingerprint: a0.content_fingerprint })
    check('exactly two payment records share the line fingerprint after override', (dupeRecs ?? []).length === 2, String((dupeRecs ?? []).length))

    // ════════════════════════════════════════════════════════════════════════
    // listConfirmedLineFingerprints
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: listConfirmedLineFingerprints surfaces confirmed fingerprints')
    const confirmedFps = await listConfirmedLineFingerprints(owner.id, fat)
    check('confirmed-fingerprint list includes the confirmed line content', confirmedFps.some((c) => c.content_fingerprint === a0.content_fingerprint))

    // sanity: import B reached needs_review (only 1 of 3 lines confirmed)
    const impBFinal = await getImport(impB.id, fat)
    check('B still open (only one line confirmed)', impBFinal.status === 'needs_review', impBFinal.status)
    const bLines = await listImportLines(impB.id, {}, fat)
    check('B has one confirmed line', bLines.filter((l) => l.status === 'confirmed').length === 1)

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
    console.log(`  deleted ${createdRecordIds.length} record(s), ${createdImportIds.length} import(s)`)
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
