// ─── Screenshot ingestion adapter + future-OCR extraction seam (canonical) ────
// The FIRST real ingestion source: payslip screenshots. This adapter conforms to
// the same ParserAdapter contract as ManualEntryAdapter (OCR_PAYSLIP_IMPORT_
// ARCHITECTURE_v1.0.md § 9) but performs NO extraction — it is the file-capture half
// of the future ScreenshotOcrAdapter. It records the upload's metadata and returns
// ZERO lines, so the import legitimately rests at status 'uploaded' ("file stored,
// not yet parsed", § 4.1) until real OCR lands.
//
// EXPLICITLY NOT here (constraints): OCR, AI extraction, PDF parsing, line
// materialization. ManualEntryAdapter is left completely untouched — this is a
// strictly-additive sibling.
//
// Pure JS — no Supabase. The bytes are uploaded by the service layer
// (lib/fat/services/payslipUploads.js); an adapter only SHAPES the parse result.

import { ParserAdapter } from './manualEntryAdapter.js'
import { IMPORT_SOURCE, IMPORT_SOURCE_VALUES } from '../models/payslipImport.js'

// ── Local field discipline (manualEntryAdapter's str/isoDate are module-private; ──
// duplicated minimally here rather than widening that file's surface — objective 9
// keeps ManualEntryAdapter untouched).
function str(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
function isoDate(v) {
  const s = str(v)
  if (!s) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`ScreenshotIngestAdapter: date '${v}' must be ISO 'YYYY-MM-DD'.`)
  }
  return s
}

/**
 * The metadata an ingest produces about the stored object (no pixel content).
 *
 * @typedef {Object} ScreenshotUploadInput
 * @property {string}      file_ref        Storage object path ('<owner>/<sha256>.<ext>')
 * @property {string}      file_hash       'sha256:<hex>' of the image bytes
 * @property {string}      mime            image/png | image/jpeg | image/webp
 * @property {number}      [size_bytes]
 * @property {string}      [uploaded_at]   ISO timestamp
 * @property {string|null} [pay_date]      operator-supplied batch pay date (optional)
 * @property {string|null} [pay_period_ref]
 */

/**
 * ScreenshotIngestAdapter — ingest-only (§ 9). Returns the canonical ParseResult
 * shape with `lines: []`. The empty lines array IS the extraction seam: because no
 * parser ran, the staging service stops at 'uploaded' and never advances to
 * parsed/needs_review. When Phase-3 OCR lands, a ScreenshotOcrAdapter (see the
 * contract below) re-parses the SAME retained file_ref and emits real lines — the
 * staging service, matcher, confirm bridge, and review UI are all unchanged.
 */
export class ScreenshotIngestAdapter extends ParserAdapter {
  name = 'screenshot_ingest'
  version = '1.0.0'
  source = IMPORT_SOURCE.PAYSLIP_SCREENSHOT

  /**
   * @param {ScreenshotUploadInput} input    upload metadata (NOT the pixels)
   * @param {object} [ctx]
   * @returns {Promise<import('./manualEntryAdapter.js').ParseResult>}
   */
  async parse(input, ctx = {}) {
    if (!input || typeof input !== 'object') {
      throw new Error('ScreenshotIngestAdapter: input must be the upload metadata object.')
    }
    if (!input.file_ref) throw new Error('ScreenshotIngestAdapter: file_ref is required (upload the image first).')
    if (!input.file_hash) throw new Error('ScreenshotIngestAdapter: file_hash is required.')

    const pay_date = isoDate(input.pay_date) ?? isoDate(ctx.pay_date) ?? null

    return {
      pay_date,
      pay_period_ref: str(input.pay_period_ref),
      // Full provenance of the capture — what a later re-parse / audit needs to find
      // and OCR the exact stored object. NO pixel content lives here.
      raw_extract: {
        adapter:        this.name,
        version:        this.version,
        file_ref:       input.file_ref,
        file_hash:      input.file_hash,
        mime:           str(input.mime),
        size_bytes:     Number.isFinite(input.size_bytes) ? input.size_bytes : null,
        uploaded_at:    str(input.uploaded_at),
        extraction:     'pending',          // ← the seam marker: awaiting OCR (O10)
      },
      lines: [],                             // ← no extraction yet (by design)
      parser_name:    this.name,
      parser_version: this.version,
    }
  }
}

/** Default instance — the upload service uses this for the MVP screenshot path. */
export const screenshotIngestAdapter = new ScreenshotIngestAdapter()

// Guard: keep the adapter's declared source inside the canonical import-source set
// (mirrors ManualEntryAdapter's guard).
if (!IMPORT_SOURCE_VALUES.includes(screenshotIngestAdapter.source)) {
  throw new Error(`ScreenshotIngestAdapter.source '${screenshotIngestAdapter.source}' is not a canonical import source.`)
}

// ─── Future-OCR extraction seam (contract only — NOT implemented here) ────────
// A real extractor (Phase 3 / roadmap O10) implements the SAME ParserAdapter.parse
// contract but, instead of returning `lines: []`, fetches the bytes at `file_ref`,
// runs OCR + field extraction server-side (per § 9: a Vercel Function / route, keys
// server-side, writes via the service_role path), and returns real ParsedLine[].
// Nothing downstream changes: the staging service, matcher, confirm bridge, and
// review UI already consume the canonical line shape. Sketch of the drop-in:
//
//   export class ScreenshotOcrAdapter extends ParserAdapter {
//     name = 'screenshot_ocr'; source = IMPORT_SOURCE.PAYSLIP_SCREENSHOT
//     async parse({ file_ref, ... }, ctx) {
//       const bytes = await downloadFromStorage(file_ref)   // server-side
//       const { lines, pay_date } = await runOcr(bytes)     // OCR/AI — NOT built
//       return { pay_date, pay_period_ref, raw_extract: { extraction: 'ocr', ... }, lines, ... }
//     }
//   }
//
// Re-ingesting an already-uploaded screenshot through this adapter walks the import
// uploaded → parsing → parsed → needs_review naturally — the file_ref + raw_extract
// this MVP persisted are exactly what it needs.
