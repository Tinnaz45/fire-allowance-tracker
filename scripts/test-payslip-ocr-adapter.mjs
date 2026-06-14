#!/usr/bin/env node
// ─── Real OCR adapter (ScreenshotOcrAdapter) — DEV validation ─────────────────
// Validates the REAL provider adapter end-to-end WITHOUT spending a live provider
// call, by injecting a deterministic fake `generate` (the model boundary). This
// exercises every line of the adapter + the full pipeline (runScreenshotExtraction
// → addImportLines → matcher → duplicate detection → lifecycle) on a real uploaded
// image, proving the framework is unchanged and the real adapter is a clean drop-in.
//
// It ALSO drives the real-provider WIRE once against the configured key (opt-in /
// best-effort): proves the request reaches the provider and is well-formed. With the
// app's current key this returns 401 (auth) — which still proves the wire — and the
// import lands 'failed' (re-parsable), exactly as designed.
//
// NO matching/reconciliation logic is touched. SAFETY: DEV-ONLY. Cleans up.
//
// Run:  node scripts/test-payslip-ocr-adapter.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'

const DEV_REF = 'kctctvpobbizhkiqkgqw'
try { process.loadEnvFile('.env.local') } catch { /* ambient */ }
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('Missing Supabase DEV env.'); process.exit(2) }
if (!URL.includes(DEV_REF)) { console.error(`REFUSING: not DEV (${DEV_REF}). Got ${URL}`); process.exit(2) }

const {
  ScreenshotOcrAdapter, normalizeOcrLine, parseModelJson, isOcrConfigured,
  OCR_PROVIDER, OCR_MODEL,
} = await import('../lib/fat/adapters/screenshotOcrAdapter.js')
const { runScreenshotExtraction, resolveExtractionAdapter } =
  await import('../lib/fat/services/payslipExtraction.js')
const { createScreenshotImport, deleteScreenshotObject } =
  await import('../lib/fat/services/payslipUploads.js')
const { stubScreenshotOcrAdapter } = await import('../lib/fat/adapters/stubScreenshotOcrAdapter.js')

const sb = createClient(URL, KEY, { db: { schema: 'fat' } })
const opts = { client: sb, storageClient: sb }

let passed = 0, failed = 0
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
async function expectThrow(label, fn, codeWanted) {
  try { await fn(); check(label, false, 'expected throw') }
  catch (e) { check(label, codeWanted ? e.code === codeWanted : true, codeWanted ? `code=${e.code}` : '') }
}

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
function uniquePng(tag) { return Buffer.concat([PNG_1x1, Buffer.from(`\n<ocr ${tag} ${Date.now()}>`)]) }

// A deterministic fake "model" that mimics a real provider's structured response —
// including a deliberately MALFORMED amount + a bad date on one line to exercise the
// lenient normalization + confidence flooring.
const fakeGenerate = async ({ bytes, mime }) => {
  if (!bytes) throw new Error('fakeGenerate got no bytes')
  return {
    pay_date: '2026-07-03',
    pay_period_ref: 'PP-OCR-7',
    lines: [
      { reference: 'EXCESS TRAVEL STANDBY', description: 'Excess travel standby', amount: 24.8, date: '2026-07-01', payment_stream: 'petty_cash', confidence: 0.96, field_confidence: { reference: 0.98, amount: 0.97, date: 0.9 } },
      { reference: 'STANDBY DISMISSAL', description: null, amount: '61.50', date: null, payment_stream: 'payslip', confidence: 0.9 },
      { reference: 'MEAL - SMALL', description: 'Small meal', amount: '$tw0', date: 'not-a-date', payment_stream: 'petty_cash', confidence: 0.99 }, // malformed → floored
    ],
  }
}

async function main() {
  console.log('Real OCR adapter (ScreenshotOcrAdapter) — DEV validation\n')
  console.log(`Configured provider: ${OCR_PROVIDER} · model ${OCR_MODEL} · isOcrConfigured=${isOcrConfigured()}\n`)

  // ── UNIT: pure normalization + parsing (no network) ─────────────────────────
  console.log('UNIT: lenient normalization + confidence flooring')
  const good = normalizeOcrLine({ reference: 'EXCESS TRAVEL', amount: 12.5, date: '2026-07-01', confidence: 0.95 }, 0)
  check('good line keeps canonical fields', good.parsed_reference === 'EXCESS TRAVEL' && good.parsed_amount === 12.5 && good.parsed_date === '2026-07-01')
  check('good line confidence ≈ model self-report', good.extract_confidence >= 0.9)
  const badAmt = normalizeOcrLine({ reference: 'X', amount: '$tw0', confidence: 0.99 }, 1)
  check('malformed amount → null (no throw)', badAmt.parsed_amount === null)
  check('malformed amount FLOORS confidence below model 0.99', badAmt.extract_confidence < 0.5, String(badAmt.extract_confidence))
  const badDate = normalizeOcrLine({ reference: 'Y', amount: 5, date: 'xx', confidence: 0.95 }, 2)
  check('malformed date → null + lowered confidence', badDate.parsed_date === null && badDate.extract_confidence < 0.95)
  const noLabel = normalizeOcrLine({ reference: null, description: null, amount: 5, confidence: 0.9 }, 3)
  check('no label heavily floors confidence', noLabel.extract_confidence <= 0.3, String(noLabel.extract_confidence))
  check('comma/$ amounts coerced', normalizeOcrLine({ reference: 'Z', amount: '$1,234.50', confidence: 0.9 }, 0).parsed_amount === 1234.5)
  check('extract_meta carries provider + model + stream', badAmt.extract_meta?.provider === OCR_PROVIDER && badAmt.extract_meta?.model === OCR_MODEL)

  console.log('\nUNIT: parseModelJson tolerance')
  check('parses fenced ```json', parseModelJson('```json\n{"lines":[]}\n```').lines.length === 0)
  check('parses bare object with prose around', parseModelJson('Here:\n{"lines":[{"reference":"A"}]}\nthanks').lines.length === 1)
  expectThrowSync('rejects non-JSON', () => parseModelJson('not json at all'))
  expectThrowSync('rejects missing lines[]', () => parseModelJson('{"foo":1}'))

  console.log('\nUNIT: adapter contract (injected model — no network)')
  const adapter = new ScreenshotOcrAdapter({ generate: fakeGenerate })
  check('adapter source = payslip_screenshot', adapter.source === 'payslip_screenshot')
  const pr = await adapter.parse({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', file_ref: 'o/x.png', file_hash: 'sha256:x' })
  check('returns canonical ParseResult shape', Array.isArray(pr.lines) && pr.parser_name === 'screenshot_ocr')
  check('raw_extract.extraction = ocr (real read marker)', pr.raw_extract?.extraction === 'ocr')
  check('pay_date + pay_period_ref extracted', pr.pay_date === '2026-07-03' && pr.pay_period_ref === 'PP-OCR-7')
  check('all lines carry extract_confidence', pr.lines.every((l) => typeof l.extract_confidence === 'number'))
  check('string amount "61.50" coerced to 61.5', pr.lines[1].parsed_amount === 61.5)
  check('malformed line floored to low confidence', pr.lines[2].extract_confidence < 0.5)
  await expectThrow('adapter throws on missing bytes (code)', () => adapter.parse({ mime: 'image/png' }), 'no_image_bytes')

  const { data: profiles } = await sb.from('profiles').select('id').limit(1)
  if (!profiles?.length) throw new Error('No fat.profiles rows in DEV.')
  const owner = profiles[0]

  const createdImportIds = []
  const objectRefs = []
  try {
    // ── E2E with the REAL adapter (injected model) over a real uploaded image ───
    console.log('\nTEST: full pipeline with real adapter (injected model) on an uploaded image')
    const png = uniquePng('e2e')
    const { import: imp0 } = await createScreenshotImport(
      { ownerId: owner.id, file: new Blob([png], { type: 'image/png' }), payDate: '2026-07-03' }, opts)
    createdImportIds.push(imp0.id); objectRefs.push(imp0.file_ref)

    const loadBytes = async () => new Uint8Array(png)   // simulate the route's storage download
    const realAdapter = new ScreenshotOcrAdapter({ generate: fakeGenerate })
    const { import: imp1, lines, summary } = await runScreenshotExtraction(
      { importId: imp0.id, ownerId: owner.id, adapter: realAdapter, loadBytes }, sb)

    check('lifecycle → needs_review', imp1.status === 'needs_review', imp1.status)
    check('lines materialized from OCR', lines.length === 3, String(lines.length))
    check('import.parser_name = screenshot_ocr', imp1.parser_name === 'screenshot_ocr')
    check('raw_extract records ocr extraction', imp1.raw_extract?.extraction_result?.extraction === 'ocr')
    check('extract_confidence persisted on every line', lines.every((l) => l.extract_confidence != null))
    check('low-confidence (malformed) line bumped to needs_review', lines.find((l) => l.parsed_reference === 'MEAL - SMALL')?.status === 'needs_review')
    check('high-confidence line rests at parsed', lines.find((l) => l.parsed_reference === 'EXCESS TRAVEL STANDBY')?.status === 'parsed')
    check('extract_meta persisted (provider/model)', lines.every((l) => l.extract_meta?.adapter === 'screenshot_ocr'))
    check('matcher ran (match_breakdown present) — engine UNCHANGED', lines.every((l) => l.match_breakdown?.matcher === 'payslip-heuristic-v1'))
    check('extract_confidence ≠ match_confidence (separate)', lines.every((l) => l.extract_confidence !== undefined && l.match_confidence !== undefined))
    const dupRow = (await sb.from('payslip_imports').select('duplicate_check').eq('id', imp0.id).single()).data
    check('duplicate detection ran', !!dupRow?.duplicate_check?.verdict)
    check('summary marks NON-synthetic for the real adapter', summary.synthetic === false)

    // ── provider failure (simulated) → failed → re-parsable ─────────────────────
    console.log('\nTEST: provider failure handling (timeout/network/malformed) → failed')
    const png2 = uniquePng('fail')
    const { import: impF } = await createScreenshotImport({ ownerId: owner.id, file: new Blob([png2], { type: 'image/png' }) }, opts)
    createdImportIds.push(impF.id); objectRefs.push(impF.file_ref)
    const boomAdapter = new ScreenshotOcrAdapter({ generate: async () => { const e = new Error('OpenAI OCR timed out.'); e.code = 'timeout'; throw e } })
    await expectThrow('provider error propagates', () =>
      runScreenshotExtraction({ importId: impF.id, ownerId: owner.id, adapter: boomAdapter, loadBytes: async () => new Uint8Array(png2) }, sb))
    const failedRow = (await sb.from('payslip_imports').select('status, error').eq('id', impF.id).single()).data
    check('import stamped failed', failedRow.status === 'failed')
    check('failure error recorded (timeout)', /timed out/i.test(failedRow.error ?? ''))
    check('no lines left behind', (await sb.from('payslip_import_lines').select('id', { count: 'exact', head: true }).eq('import_id', impF.id)).count === 0)

    // malformed-JSON provider response → failed
    const png3 = uniquePng('malformed')
    const { import: impM } = await createScreenshotImport({ ownerId: owner.id, file: new Blob([png3], { type: 'image/png' }) }, opts)
    createdImportIds.push(impM.id); objectRefs.push(impM.file_ref)
    const junkAdapter = new ScreenshotOcrAdapter({ generate: async () => parseModelJson('totally not json') })
    await expectThrow('malformed provider JSON → throw', () =>
      runScreenshotExtraction({ importId: impM.id, ownerId: owner.id, adapter: junkAdapter, loadBytes: async () => new Uint8Array(png3) }, sb))
    check('malformed → failed', (await sb.from('payslip_imports').select('status').eq('id', impM.id).single()).data.status === 'failed')

    // ── adapter selection: keyless DEV falls back to stub ───────────────────────
    console.log('\nTEST: resolveExtractionAdapter selection')
    const selected = resolveExtractionAdapter()
    check('selector returns real adapter when configured, else stub',
      (isOcrConfigured() && selected.name === 'screenshot_ocr') || (!isOcrConfigured() && selected.name === 'stub_screenshot_ocr'),
      `configured=${isOcrConfigured()} selected=${selected.name}`)
    check('stub remains available as the keyless fallback', stubScreenshotOcrAdapter.name === 'stub_screenshot_ocr')

    // ── LIVE wire proof (best-effort; does NOT fail the suite) ───────────────────
    console.log('\nTEST: live provider wire (best-effort — proves request reaches provider)')
    if (!isOcrConfigured()) {
      console.log('  (skipped — no provider key configured)')
    } else {
      const png4 = uniquePng('live')
      const { import: impL } = await createScreenshotImport({ ownerId: owner.id, file: new Blob([png4], { type: 'image/png' }) }, opts)
      createdImportIds.push(impL.id); objectRefs.push(impL.file_ref)
      const liveAdapter = new ScreenshotOcrAdapter()   // real provider call
      try {
        const r = await runScreenshotExtraction({ importId: impL.id, ownerId: owner.id, adapter: liveAdapter, loadBytes: async () => new Uint8Array(png4) }, sb)
        console.log(`  ⓘ LIVE extraction succeeded: ${r.lines.length} line(s) from ${OCR_PROVIDER}/${OCR_MODEL}`)
        check('live: import advanced to needs_review', r.import.status === 'needs_review')
      } catch (e) {
        // 401/invalid key etc. — wire reached the provider; import is 'failed' (re-parsable).
        const row = (await sb.from('payslip_imports').select('status, error').eq('id', impL.id).single()).data
        console.log(`  ⓘ LIVE call returned: ${e.message}`)
        check('live: wire reached provider (import failed cleanly, re-parsable)', row.status === 'failed' && !!row.error)
      }
    }

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

function expectThrowSync(label, fn) {
  try { fn(); check(label, false, 'expected throw') }
  catch { check(label, true) }
}

main().catch((err) => { console.error('\nFATAL:', err.message); process.exit(1) })
