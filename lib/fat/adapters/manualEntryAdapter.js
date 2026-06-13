// ─── Parser adapter interface + ManualEntryAdapter (canonical) ────────────────
// The single abstraction that lets the OCR MVP ship WITHOUT any OCR: every
// adapter — manual entry today, PDF/screenshot/AI later — returns the SAME
// canonical line shape, so the matcher, the confirm bridge, and the review UI are
// written once (OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 9). This mirrors the
// architectural move that made payment_records source-agnostic — the OCR layer is
// adapter-agnostic the same way.
//
// MVP scope (this file): ManualEntryAdapter ONLY. No OCR, no PDF parsing, no
// screenshot, no AI extraction — those are O9/O10 drop-in adapters that implement
// the same parse() contract and are deliberately NOT built here.
//
// Pure JS — no Supabase dependency. Persistence is the staging service's job
// (lib/fat/services/payslipImports.js); an adapter only SHAPES input into lines.

import { IMPORT_SOURCE, IMPORT_SOURCE_VALUES } from '../models/payslipImport.js'

/**
 * The canonical parse result every adapter returns (§ 9).
 *
 * @typedef {Object} ParsedLine
 * @property {number}      line_index            // order within the payslip (0-based)
 * @property {string|null} [raw_text]            // source text the parser saw for this line
 * @property {string|null} [parsed_reference]    // payslip line code
 * @property {string|null} [parsed_description]  // line description / narrative
 * @property {number|null} [parsed_amount]       // gross dollar amount on the line
 * @property {string|null} [parsed_date]         // ISO 'YYYY-MM-DD'; null ⇒ inherit import.pay_date
 *
 * @typedef {Object} ParseResult
 * @property {string|null}    pay_date           // ISO date for the batch
 * @property {string|null}    pay_period_ref     // payroll period identifier, if present
 * @property {object}         raw_extract        // full pre-split payload (audit + re-parse)
 * @property {ParsedLine[]}   lines
 * @property {string}         parser_name        // stamped onto payslip_imports.parser_name
 * @property {string}         parser_version
 */

/**
 * ParserAdapter — the contract (§ 9). Concrete adapters implement parse().
 * Documented as an abstract base rather than a TS interface (this codebase is
 * plain JS); the shape is enforced by `normalizeLines` + the migration-10 CHECKs.
 *
 *   ParserAdapter.parse(input, ctx) ──▶ ParseResult
 *
 * - `input` is adapter-specific (a form payload here; a File/Buffer for real
 *   parsers later).
 * - `ctx` carries cross-cutting hints (e.g. a fallback pay_date) and is optional.
 */
export class ParserAdapter {
  /** @type {string} */
  name = 'abstract'
  /** @type {string} */
  version = '0.0.0'
  /** @type {PayslipImportSource} */
  source = IMPORT_SOURCE.MANUAL_ENTRY

  // eslint-disable-next-line no-unused-vars
  async parse(input, ctx = {}) {
    throw new Error('ParserAdapter.parse is abstract — use a concrete adapter (e.g. ManualEntryAdapter).')
  }
}

/** Coerce a value to a trimmed string or null. */
function str(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** Coerce a value to a non-negative 2dp number or null (never throws on blank). */
function money(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`ManualEntryAdapter: amount '${v}' is not a number.`)
  if (n < 0) throw new Error(`ManualEntryAdapter: amount '${v}' must be >= 0.`)
  return Math.round(n * 100) / 100
}

/** Coerce an ISO-ish date to 'YYYY-MM-DD' or null. */
function isoDate(v) {
  const s = str(v)
  if (!s) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`ManualEntryAdapter: date '${v}' must be ISO 'YYYY-MM-DD'.`)
  }
  return s
}

/**
 * Normalize a raw operator-typed row into a canonical ParsedLine. Shared so a
 * future adapter can reuse the exact field discipline the bridge expects.
 *
 * @param {object} row
 * @param {number} index
 * @returns {ParsedLine}
 */
export function normalizeLine(row, index) {
  return {
    line_index:         index,
    raw_text:           str(row.raw_text ?? row.rawText),
    parsed_reference:   str(row.reference ?? row.parsed_reference),
    parsed_description: str(row.description ?? row.parsed_description),
    parsed_amount:      money(row.amount ?? row.parsed_amount),
    parsed_date:        isoDate(row.date ?? row.parsed_date),
  }
}

/**
 * ManualEntryAdapter — the MVP parser (§ 9). `lines` come straight from the
 * operator form; `raw_extract` is the form payload itself (full provenance, so a
 * later re-parse / audit sees exactly what was typed). Produces NO OCR — it is a
 * structuring pass over already-structured operator input.
 *
 * Input shape (the operator form payload):
 *   {
 *     pay_date?:       'YYYY-MM-DD',
 *     pay_period_ref?: string,
 *     lines: [{ reference?, description?, amount?, date?, raw_text? }, ...]
 *   }
 */
export class ManualEntryAdapter extends ParserAdapter {
  name = 'manual_entry'
  version = '1.0.0'
  source = IMPORT_SOURCE.MANUAL_ENTRY

  /**
   * @param {object} input          operator form payload
   * @param {object} [ctx]
   * @param {string|null} [ctx.pay_date]   fallback pay_date when the form omits one
   * @returns {Promise<ParseResult>}
   */
  async parse(input, ctx = {}) {
    if (!input || typeof input !== 'object') {
      throw new Error('ManualEntryAdapter: input must be the operator form payload object.')
    }
    const rows = Array.isArray(input.lines) ? input.lines : []
    if (rows.length === 0) {
      throw new Error('ManualEntryAdapter: at least one line is required.')
    }

    const pay_date = isoDate(input.pay_date) ?? isoDate(ctx.pay_date) ?? null
    const lines = rows.map((row, i) => normalizeLine(row, i))

    return {
      pay_date,
      pay_period_ref: str(input.pay_period_ref),
      raw_extract:    { adapter: this.name, version: this.version, form: input },
      lines,
      parser_name:    this.name,
      parser_version: this.version,
    }
  }
}

/** Default instance — the staging service uses this for the MVP path. */
export const manualEntryAdapter = new ManualEntryAdapter()

// Guard: keep the adapter's declared source inside the canonical import-source set.
if (!IMPORT_SOURCE_VALUES.includes(manualEntryAdapter.source)) {
  throw new Error(`ManualEntryAdapter.source '${manualEntryAdapter.source}' is not a canonical import source.`)
}
