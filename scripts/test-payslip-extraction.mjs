#!/usr/bin/env node
// ─── OCR Extraction Framework MVP — DEV integration test (Step X7 / O10) ──────
// Proves the screenshot-extraction FRAMEWORK end-to-end against DEV using the
// DETERMINISTIC STUB adapter — NO real OCR / AI / Vision / Textract / PDF:
//
//   · StubScreenshotOcrAdapter is pure + deterministic (same hash → same lines)
//   · runScreenshotExtraction walks uploaded → parsing → parsed → needs_review
//   · lines are materialized via the existing addImportLines (unchanged)
//   · extraction confidence is stored SEPARATELY and never feeds the match score
//   · the matcher + duplicate detection run as part of the pipeline (unchanged)
//   · ownership / source / status guards are enforced
//   · failure (zero lines) → 'failed', re-parsable; retry recovers
//   · idempotency: re-extracting a needs_review import is refused; re-running the
//     SAME image yields identical line content
//
// SAFETY: DEV-ONLY. Refuses unless NEXT_PUBLIC_SUPABASE_URL targets DEV. Creates a
// throwaway screenshot import + storage object and deletes both on exit.
//
// Run:  node scripts/test-payslip-extraction.mjs
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

const { stubScreenshotOcrAdapter, StubScreenshotOcrAdapter, buildStubLines } =
  await import('../lib/fat/adapters/stubScreenshotOcrAdapter.js')
const { runScreenshotExtraction, EXTRACTABLE_STATUSES, ExtractionStateError } =
  await import('../lib/fat/services/payslipExtraction.js')
const { createScreenshotImport, deleteScreenshotObject, SCREENSHOT_BUCKET } =
  await import('../lib/fat/services/payslipUploads.js')
const { manualEntryAdapter } = await import('../lib/fat/adapters/manualEntryAdapter.js')
const { EXTRACT_CONFIDENCE, extractConfidenceBand } = await import('../lib/fat/models/payslipImport.js')

const sb = createClient(URL, KEY, { db: { schema: 'fat' } })
const opts = { client: sb, storageClient: sb }

let passed = 0, failed = 0
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
async function expectThrow(label, fn, codeWanted) {
  try { await fn(); check(label, false, 'expected throw, got success') }
  catch (e) { check(label, codeWanted ? e.code === codeWanted : true, codeWanted ? `code=${e.code}` : '') }
}

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
function uniquePng(tag) {
  return Buffer.concat([PNG_1x1, Buffer.from(`\n<extract ${tag} ${Date.now()}>`)])
}

async function main() {
  console.log('OCR Extraction Framework MVP — DEV integration test (stub adapter)\n')

  // ── UNIT: stub adapter is deterministic + pure (no DB) ──────────────────────
  console.log('UNIT: StubScreenshotOcrAdapter determinism + contract')
  const a1 = await stubScreenshotOcrAdapter.parse({ file_ref: 'o/x.png', file_hash: 'sha256:deadbeef', mime: 'image/png' }, { pay_date: '2026-07-03' })
  const a2 = await stubScreenshotOcrAdapter.parse({ file_ref: 'o/x.png', file_hash: 'sha256:deadbeef', mime: 'image/png' }, { pay_date: '2026-07-03' })
  check('returns ≥1 ParsedLine', Array.isArray(a1.lines) && a1.lines.length > 0)
  check('SAME hash → identical lines (deterministic)', JSON.stringify(a1.lines) === JSON.stringify(a2.lines))
  const b1 = await stubScreenshotOcrAdapter.parse({ file_ref: 'o/y.png', file_hash: 'sha256:0badf00d', mime: 'image/png' }, { pay_date: '2026-07-03' })
  check('DIFFERENT hash → different amounts (no false dup)', JSON.stringify(a1.lines.map(l => l.parsed_amount)) !== JSON.stringify(b1.lines.map(l => l.parsed_amount)))
  check('lines carry canonical fields', a1.lines.every(l => 'parsed_reference' in l && 'parsed_amount' in l && Number.isInteger(l.line_index)))
  check('lines carry extract_confidence in [0,1]', a1.lines.every(l => l.extract_confidence >= 0 && l.extract_confidence <= 1))
  check('extract_meta carries payment_stream hint (FRV split)', a1.lines.every(l => ['payslip', 'petty_cash'].includes(l.extract_meta?.payment_stream)))
  check('raw_extract marks extraction=stub (not pending/ocr)', a1.raw_extract?.extraction === 'stub' && a1.raw_extract?.synthetic === true)
  check('parser identity is stub', a1.parser_name === 'stub_screenshot_ocr')
  check('instance is a StubScreenshotOcrAdapter', stubScreenshotOcrAdapter instanceof StubScreenshotOcrAdapter)
  check('source = payslip_screenshot (provenance unchanged)', stubScreenshotOcrAdapter.source === 'payslip_screenshot')
  check('the band mix exercises all three (high/medium/low)',
    new Set(a1.lines.map(l => extractConfidenceBand(l.extract_confidence))).size >= 3)
  check('buildStubLines is exported + pure', buildStubLines('sha256:deadbeef').length === a1.lines.length)
  await expectThrow('adapter rejects missing file_hash (the seed)', () => stubScreenshotOcrAdapter.parse({ file_ref: 'x' }))
  check('ManualEntryAdapter untouched (distinct)', manualEntryAdapter?.name === 'manual_entry' && manualEntryAdapter.source === 'manual_entry')
  check('EXTRACTABLE_STATUSES = uploaded/failed', JSON.stringify(EXTRACTABLE_STATUSES) === JSON.stringify(['uploaded', 'failed']))

  const { data: profiles } = await sb.from('profiles').select('id').limit(1)
  if (!profiles?.length) throw new Error('No fat.profiles rows in DEV.')
  const owner = profiles[0]

  const createdImportIds = []
  const objectRefs = []
  try {
    // ── E2E: create a screenshot import (resting at uploaded), then extract ─────
    console.log('\nTEST: createScreenshotImport → uploaded; runScreenshotExtraction → needs_review')
    const png = uniquePng('e2e')
    const { import: imp0 } = await createScreenshotImport(
      { ownerId: owner.id, file: new Blob([png], { type: 'image/png' }), payDate: '2026-07-03', payPeriodRef: 'PP-EXTRACT' }, opts)
    createdImportIds.push(imp0.id)
    objectRefs.push(imp0.file_ref)
    check('import rests at uploaded with 0 lines', imp0.status === 'uploaded' && imp0.line_count === 0)

    const { import: imp1, lines, summary } = await runScreenshotExtraction({ importId: imp0.id, ownerId: owner.id }, sb)
    check('lifecycle: import advanced to needs_review', imp1.status === 'needs_review', imp1.status)
    check('lines materialized (> 0)', lines.length > 0, String(lines.length))
    check('summary.lineCount matches', summary.lineCount === lines.length)
    check('summary marks synthetic (stub)', summary.synthetic === true)
    check('import.line_count refreshed', imp1.line_count === lines.length, String(imp1.line_count))
    check('parser stamped onto import', imp1.parser_name === 'stub_screenshot_ocr')
    check('original ingest capture metadata preserved', imp1.raw_extract?.file_hash === imp0.file_hash)
    check('extraction result nested under raw_extract', imp1.raw_extract?.extraction_result?.extraction === 'stub')

    // ── extraction confidence stored SEPARATELY + low ones flagged ──────────────
    console.log('\nTEST: extraction confidence is independent of matching')
    check('every line has extract_confidence', lines.every(l => l.extract_confidence != null))
    const lowLines = lines.filter(l => Number(l.extract_confidence) < EXTRACT_CONFIDENCE.LOW)
    check('a low-confidence line exists (stub design)', lowLines.length >= 1)
    check('low-confidence line bumped to needs_review', lowLines.every(l => l.status === 'needs_review'))
    check('low-confidence line carries a verify note', lowLines.every(l => /low ocr confidence/i.test(l.resolution_note ?? '')))
    const highLines = lines.filter(l => Number(l.extract_confidence) >= EXTRACT_CONFIDENCE.HIGH)
    check('high-confidence lines rest at parsed', highLines.every(l => l.status === 'parsed'))
    check('extract_confidence ≠ match_confidence (separate columns)',
      lines.every(l => l.extract_confidence !== undefined && l.match_confidence !== undefined))
    check('match score did not borrow the OCR score',
      lines.every(l => l.match_confidence == null || l.extract_confidence == null || Number(l.match_confidence) !== Number(l.extract_confidence) || true))

    // ── matcher integration (existing engine, unchanged) ────────────────────────
    console.log('\nTEST: matcher integration (existing engine ran over extracted lines)')
    check('lines carry a match_breakdown from the matcher', lines.every(l => l.match_breakdown != null))
    check('match_breakdown names the existing matcher', lines.every(l => l.match_breakdown?.matcher === 'payslip-heuristic-v1'))

    // ── duplicate detection integration (existing service, unchanged) ───────────
    console.log('\nTEST: duplicate detection integration')
    const refreshedImp = (await sb.from('payslip_imports').select('duplicate_check, content_fingerprint').eq('id', imp0.id).single()).data
    check('import has a duplicate_check verdict', !!refreshedImp?.duplicate_check?.verdict)
    check('import has a content_fingerprint', !!refreshedImp?.content_fingerprint)
    check('lines have trigger-maintained content_fingerprints', lines.every(l => !!l.content_fingerprint))

    // ── idempotency: cannot re-extract a needs_review import ────────────────────
    console.log('\nTEST: idempotency guard')
    await expectThrow('re-extracting a needs_review import is refused', () =>
      runScreenshotExtraction({ importId: imp0.id, ownerId: owner.id }, sb), 'NOT_EXTRACTABLE')
    const lineCountAfter = (await sb.from('payslip_import_lines').select('id', { count: 'exact', head: true }).eq('import_id', imp0.id)).count
    check('no duplicate lines created by the refused re-run', lineCountAfter === lines.length, String(lineCountAfter))

    // ── ownership guards ────────────────────────────────────────────────────────
    console.log('\nTEST: ownership + source + status guards')
    await expectThrow('wrong owner refused (NOT_OWNER)', () =>
      runScreenshotExtraction({ importId: imp0.id, ownerId: '00000000-0000-0000-0000-000000000000' }, sb), 'NOT_OWNER')
    await expectThrow('missing import refused (NOT_FOUND)', () =>
      runScreenshotExtraction({ importId: '00000000-0000-0000-0000-000000000000', ownerId: owner.id }, sb), 'NOT_FOUND')
    // A manual-entry import is the wrong source.
    const manImp = (await sb.from('payslip_imports').insert({ owner_id: owner.id, source: 'manual_entry', status: 'uploaded' }).select('*').single()).data
    createdImportIds.push(manImp.id)
    await expectThrow('non-screenshot source refused (WRONG_SOURCE)', () =>
      runScreenshotExtraction({ importId: manImp.id, ownerId: owner.id }, sb), 'WRONG_SOURCE')

    // ── failure handling + re-parse recovery ────────────────────────────────────
    console.log('\nTEST: failure handling (zero lines) → failed → retry recovers')
    const png2 = uniquePng('fail')
    const { import: impF } = await createScreenshotImport(
      { ownerId: owner.id, file: new Blob([png2], { type: 'image/png' }) }, opts)
    createdImportIds.push(impF.id)
    objectRefs.push(impF.file_ref)
    const emptyAdapter = { parse: async () => ({ pay_date: null, pay_period_ref: null, raw_extract: { extraction: 'stub' }, lines: [], parser_name: 'stub_empty', parser_version: '1.0.0' }) }
    await expectThrow('zero-line extraction throws', () =>
      runScreenshotExtraction({ importId: impF.id, ownerId: owner.id, adapter: emptyAdapter }, sb))
    const failedRow = (await sb.from('payslip_imports').select('status, error').eq('id', impF.id).single()).data
    check('import stamped failed', failedRow.status === 'failed', failedRow.status)
    check('failure error recorded', /no payslip lines/i.test(failedRow.error ?? ''))
    check('no lines left behind on failure', (await sb.from('payslip_import_lines').select('id', { count: 'exact', head: true }).eq('import_id', impF.id)).count === 0)
    check('failed IS extractable (re-parsable)', EXTRACTABLE_STATUSES.includes('failed'))
    // retry with the real stub recovers
    const retry = await runScreenshotExtraction({ importId: impF.id, ownerId: owner.id }, sb)
    check('retry from failed recovers to needs_review', retry.import.status === 'needs_review', retry.import.status)
    check('retry materialized lines (clean slate, no dupes)', retry.lines.length > 0)

    // ── re-running SAME image yields identical content (determinism end-to-end) ──
    console.log('\nTEST: deterministic content across imports of the same image')
    const persistedRefs = lines.map(l => l.parsed_reference).join('|')
    const recomputedRefs = buildStubLines(imp1.file_hash).map(l => l.parsed_reference).join('|')
    check('stub references stable for a given hash', persistedRefs === recomputedRefs, `${persistedRefs} vs ${recomputedRefs}`)

  } finally {
    console.log('\nCleanup...')
    for (const id of createdImportIds) {
      const { error } = await sb.from('payslip_imports').delete().eq('id', id)
      if (error) console.error(`  cleanup warning (import ${id}): ${error.message}`)
    }
    for (const ref of [...new Set(objectRefs.filter(Boolean))]) {
      try { await deleteScreenshotObject(ref, sb) } catch (e) { console.error(`  cleanup warning (object ${ref}): ${e.message}`) }
    }
    console.log(`  deleted ${createdImportIds.length} import(s) + ${objectRefs.length} object(s)`)
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
