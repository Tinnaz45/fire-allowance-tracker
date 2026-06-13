// ─── Stub screenshot OCR adapter (DETERMINISTIC — framework validation only) ──
// The OCR Extraction Framework MVP (OCR_EXTRACTION_MVP_v1.0.md, roadmap O10) needs
// to be validated END-TO-END *before* any real OCR provider is chosen. This adapter
// is that validation seam: it implements the EXACT same ParserAdapter contract a
// real ScreenshotOcrAdapter will (§ 5), but instead of reading pixels it returns a
// DETERMINISTIC set of realistic FRV-style payslip lines.
//
// HARD CONSTRAINTS (by design — do NOT relax):
//   · NO external API calls.   · NO OCR provider.   · NO AI/LLM calls.
//   · NO image parsing.        · NO network.        · Pure + deterministic.
// The image bytes are NEVER decoded. The only thing read from the upload is the
// file_hash, used purely as a deterministic SEED so that:
//   · the SAME image always extracts to the SAME lines (idempotent re-extraction),
//   · DIFFERENT images extract to DIFFERENT (but still fixed) amounts — so two
//     distinct uploads are not all falsely flagged as duplicates of each other.
// This is the file-capture half's natural successor: the real adapter swaps
// `buildStubLines()` for a provider call and changes nothing else downstream.
//
// Pure JS — no Supabase. Persistence (addImportLines), matching (scoreImportLines),
// and duplicate detection are the orchestration service's job
// (lib/fat/services/payslipExtraction.js); this adapter only SHAPES lines.

import { ParserAdapter, normalizeLine } from './manualEntryAdapter.js'
import { IMPORT_SOURCE, IMPORT_SOURCE_VALUES } from '../models/payslipImport.js'

// ── Deterministic seed from the file hash (no randomness — Math.random is banned ──
// in this codebase's deterministic paths and would break idempotent re-extraction).
// A simple, stable rolling hash over the hex string → a non-negative integer.
function seedFromHash(fileHash) {
  const s = String(fileHash ?? '')
  let h = 2166136261 >>> 0          // FNV-1a basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

// A small deterministic "jitter" in cents derived from the seed and the line index,
// so different images yield different (but fixed) amounts. Bounded to ±$3.00.
function amountJitter(seed, index) {
  const v = (Math.imul(seed ^ (index + 1), 2654435761) >>> 0) % 601   // 0..600 cents
  return (v - 300) / 100                                              // -3.00 .. +3.00
}

// ── The canonical FRV-style sample payslip (the deterministic template) ───────────
// Realistic Fire Rescue Victoria allowance lines spanning both payment streams and
// all three extraction-confidence bands (§ 8.2), so a single extracted import
// exercises high / medium / low handling deterministically:
//
//   · base_amount   — the template dollar value, before per-image jitter.
//   · payment_stream— 'payslip' | 'petty_cash' (the FRV split). NOT a canonical
//                     line column — carried in extract_meta for realism/audit; the
//                     confirm bridge derives the record stream from import.source.
//   · extract_confidence — FIXED per line so the band mix is stable for tests; the
//                     real adapter would derive this from the provider + sanity floor.
//   · field_conf    — per-field confidences, persisted into extract_meta.
const STUB_TEMPLATE = Object.freeze([
  {
    reference: 'EXCESS TRAVEL STANDBY',
    description: 'Excess travel — standby recall (km)',
    base_amount: 24.80,
    payment_stream: 'petty_cash',
    extract_confidence: 0.97,
    field_conf: { reference: 0.99, description: 0.96, amount: 0.98, date: 0.95 },
  },
  {
    reference: 'STANDBY DISMISSAL',
    description: 'Standby dismissal allowance',
    base_amount: 61.50,
    payment_stream: 'payslip',
    extract_confidence: 0.91,
    field_conf: { reference: 0.95, description: 0.9, amount: 0.93, date: 0.88 },
  },
  {
    reference: 'MEAL ALLOWANCE - SMALL',
    description: 'Small meal allowance',
    base_amount: 12.50,
    payment_stream: 'petty_cash',
    extract_confidence: 0.78,                 // medium — flagged "verify OCR"
    field_conf: { reference: 0.82, description: 0.8, amount: 0.74, date: 0.7 },
  },
  {
    reference: 'EXCESS TRAVEL M&D',
    description: 'Excess travel — muster & dismissal',
    base_amount: 18.20,
    payment_stream: 'payslip',
    extract_confidence: 0.42,                 // low — bumped to needs_review
    field_conf: { reference: 0.55, description: 0.4, amount: 0.38, date: 0.45 },
  },
])

/**
 * Build the deterministic FRV-style lines for a given file hash. Pure: same hash →
 * identical output, every time. Each line carries the canonical ParsedLine fields
 * PLUS the non-canonical `extract_confidence` + `extract_meta` the orchestration
 * service peels off into the migration-14 columns (§ 8.1).
 *
 * @param {string} fileHash   'sha256:<hex>' — seed only; bytes are never read
 * @param {string|null} payDate  inherited line date (lines have no own date here)
 * @returns {Array<object>}   ParsedLine + { extract_confidence, extract_meta }
 */
export function buildStubLines(fileHash, payDate = null) {
  const seed = seedFromHash(fileHash)
  return STUB_TEMPLATE.map((t, index) => {
    const amount = Math.round((t.base_amount + amountJitter(seed, index)) * 100) / 100
    // Canonical line (normalized exactly like a manual line so the bridge is happy).
    const base = normalizeLine({
      reference: t.reference,
      description: t.description,
      amount,
      date: null,                 // line-level date inherits import.pay_date
      raw_text: `${t.reference}  ${amount.toFixed(2)}`,
    }, index)
    return {
      ...base,
      // Non-canonical extraction signals (peeled off by the service → migration 14).
      extract_confidence: t.extract_confidence,
      extract_meta: {
        adapter: 'stub_screenshot_ocr',
        version: '1.0.0',
        payment_stream: t.payment_stream,     // FRV stream hint (no canonical column)
        field_confidence: t.field_conf,
        verbatim_text: base.raw_text,
        seed,
        synthetic: true,                       // unmistakably NOT a real read
      },
    }
  })
}

/**
 * StubScreenshotOcrAdapter — implements the ParserAdapter contract (§ 5) with a
 * deterministic stub instead of a provider. Same `source` as the ingest adapter
 * (payslip_screenshot) so the import's provenance and the confirm-bridge source
 * mapping are unchanged. The real adapter is a drop-in that replaces `buildStubLines`
 * with a server-side OCR/AI call and is otherwise identical.
 */
export class StubScreenshotOcrAdapter extends ParserAdapter {
  name = 'stub_screenshot_ocr'
  version = '1.0.0'
  source = IMPORT_SOURCE.PAYSLIP_SCREENSHOT

  /**
   * @param {object} input
   * @param {string} input.file_ref    Storage object path (carried for provenance)
   * @param {string} input.file_hash   'sha256:<hex>' — deterministic seed ONLY
   * @param {string} [input.mime]
   * @param {object} [ctx]
   * @param {string|null} [ctx.pay_date]   fallback batch pay date
   * @returns {Promise<import('./manualEntryAdapter.js').ParseResult & { lines: object[] }>}
   */
  async parse(input, ctx = {}) {
    if (!input || typeof input !== 'object') {
      throw new Error('StubScreenshotOcrAdapter: input must be the upload metadata object.')
    }
    if (!input.file_hash) {
      throw new Error('StubScreenshotOcrAdapter: file_hash is required (it is the deterministic seed).')
    }

    const pay_date = ctx.pay_date ?? input.pay_date ?? null
    const lines = buildStubLines(input.file_hash, pay_date)

    return {
      pay_date,
      pay_period_ref: input.pay_period_ref ?? null,
      raw_extract: {
        adapter: this.name,
        version: this.version,
        extraction: 'stub',                  // ← NOT 'pending' (ingest) and NOT 'ocr' (real)
        synthetic: true,
        file_ref: input.file_ref ?? null,
        file_hash: input.file_hash,
        line_count: lines.length,
      },
      lines,
      parser_name: this.name,
      parser_version: this.version,
    }
  }
}

/** Default instance — the extraction service uses this for the framework MVP. */
export const stubScreenshotOcrAdapter = new StubScreenshotOcrAdapter()

// Guard: keep the adapter's declared source inside the canonical import-source set.
if (!IMPORT_SOURCE_VALUES.includes(stubScreenshotOcrAdapter.source)) {
  throw new Error(`StubScreenshotOcrAdapter.source '${stubScreenshotOcrAdapter.source}' is not a canonical import source.`)
}
