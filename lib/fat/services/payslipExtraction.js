// ─── OCR Payslip Import — screenshot extraction orchestration (Step X3 / O10) ──
// The missing pipeline step: turn an uploaded screenshot import (lines:[], resting
// at 'uploaded') into materialized ParsedLine[] and walk it into the EXISTING review
// pipeline — WITHOUT any real OCR provider. This is the deterministic-stub framework:
//
//   Screenshot Import (uploaded|failed)
//        ↓  StubScreenshotOcrAdapter.parse()        ← deterministic, no network
//        ↓  addImportLines()                         ← existing service, UNCHANGED
//        ↓  persist extract_confidence/extract_meta  ← migration 14 (separate pass,
//        ↓                                              so addImportLines is untouched)
//        ↓  scoreImportLines()                       ← existing matcher, UNCHANGED
//        ↓  detectImportDuplicates()                 ← existing service, UNCHANGED
//        ↓  status → needs_review                    ← the MVP resting state
//
// CONSTRAINTS honoured: no real OCR / AI / Vision / Textract / PDF, no production,
// no auto-confirm (every line still operator-confirmed via the existing bridge), the
// matching engine and reconciliation logic are NOT changed. Extraction confidence is
// stored SEPARATELY and never feeds the match score (§ 8).
//
// Spec: OCR_EXTRACTION_MVP_v1.0.md § 3.2 (orchestration), § 4 (lifecycle), § 8
// (confidence), § 9 (failure handling).

import { fat as defaultClient } from '../../supabaseClient.js'
import {
  PAYSLIP_IMPORTS_TABLE,
  PAYSLIP_IMPORT_LINES_TABLE,
  IMPORT_SOURCE,
  IMPORT_STATUS,
  IMPORT_LINE_STATUS,
  EXTRACT_CONFIDENCE,
  extractConfidenceBand,
} from '../models/payslipImport.js'
import {
  getImport,
  updateImportStatus,
  addImportLines,
} from './payslipImports.js'
import { scoreImportLines } from './payslipMatcher.js'
import { detectImportDuplicates } from './payslipDuplicates.js'
import { stubScreenshotOcrAdapter } from '../adapters/stubScreenshotOcrAdapter.js'
import { screenshotOcrAdapter, isOcrConfigured } from '../adapters/screenshotOcrAdapter.js'

/**
 * Is a REAL OCR provider configured? Single source of truth for whether automatic
 * extraction is AVAILABLE to users. Wraps the adapter-level provider-key check so
 * callers (route, UI capability probe) never reach into the adapter directly.
 */
export function isRealOcrAvailable() {
  return isOcrConfigured()
}

/**
 * May the DETERMINISTIC STUB run as a fallback when no real provider is configured?
 * The stub FABRICATES payslip lines (invented references + amounts), so it must
 * NEVER reach a real user. Allowed only when BOTH: (a) not production, and (b) an
 * explicit opt-in `PAYSLIP_OCR_ALLOW_STUB` is set — strictly for local/dev framework
 * testing. Default: NO. (Tests that exercise the stub inject it directly into
 * runScreenshotExtraction; they do not rely on this.)
 */
export function isStubFallbackAllowed() {
  if (process.env.NODE_ENV === 'production') return false
  const v = String(process.env.PAYSLIP_OCR_ALLOW_STUB || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

/**
 * Pick the extraction adapter for a route/production invocation:
 *   · the REAL provider adapter when configured (isRealOcrAvailable), else
 *   · the deterministic stub ONLY when explicitly allowed (isStubFallbackAllowed), else
 *   · NULL — extraction is unavailable and the caller MUST refuse (the route returns
 *     503). This guarantees the stub never runs in production or an unconfigured
 *     environment, so fabricated lines can never reach a user.
 * The real adapter needs the image bytes — callers using it MUST also pass
 * `loadBytes` (the route does).
 */
export function resolveExtractionAdapter() {
  if (isRealOcrAvailable()) return screenshotOcrAdapter
  if (isStubFallbackAllowed()) return stubScreenshotOcrAdapter
  return null
}

// The import states from which extraction may (re)run. 'uploaded' = first pass;
// 'failed' = a re-parse after a prior failure (§ 9.2). Any other state is rejected —
// this is the idempotency guard: a 'needs_review'/'confirmed' import is never
// silently re-extracted into duplicate lines.
export const EXTRACTABLE_STATUSES = Object.freeze([IMPORT_STATUS.UPLOADED, IMPORT_STATUS.FAILED])

/** A typed guard error so the route can map it to a 409 (vs a 500). */
export class ExtractionStateError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ExtractionStateError'
    this.code = code
  }
}

/**
 * Delete any lines already attached to an import — used to start a re-extraction
 * (failed → parsing) from a clean slate so a retry never duplicates lines. A fresh
 * 'uploaded' import has zero lines, so this is a no-op on the first pass. Keeps the
 * whole extraction atomic-per-import (§ 9.2: "write all lines or none").
 */
async function clearImportLines(importId, client) {
  const { error } = await client
    .from(PAYSLIP_IMPORT_LINES_TABLE)
    .delete()
    .eq('import_id', importId)
  if (error) throw new Error(`clearImportLines failed: ${error.message}`)
}

/**
 * Persist the per-line extraction confidence (§ 8.1) onto the migration-14 columns,
 * and — for a LOW-confidence read — bump that line to 'needs_review' so the operator
 * is steered to verify it against the image (§ 8.2). High/medium lines rest at
 * 'parsed' exactly like a manual line. This is the ONLY place line status is set
 * from extraction confidence; it is a legal parsed→needs_review transition and never
 * confirms anything (human review stays mandatory).
 *
 * The inserted rows from addImportLines are matched to the adapter lines by
 * line_index (stable, 0-based).
 *
 * @returns {Promise<{ lowCount: number, lines: object[] }>}
 */
async function persistExtractionConfidence(insertedLines, adapterLines, client) {
  const byIndex = new Map(adapterLines.map((l) => [l.line_index, l]))
  let lowCount = 0
  const updated = []

  for (const row of insertedLines) {
    const src = byIndex.get(row.line_index)
    const conf = src?.extract_confidence ?? null
    const band = extractConfidenceBand(conf)
    const patch = {
      extract_confidence: conf,
      extract_meta: src?.extract_meta ?? null,
    }
    // Low extraction confidence → steer the operator to verify (parsed → needs_review).
    if (conf != null && conf < EXTRACT_CONFIDENCE.LOW) {
      patch.status = IMPORT_LINE_STATUS.NEEDS_REVIEW
      patch.resolution_note = `Low OCR confidence (${Math.round(conf * 100)}%) — verify against the image.`
      lowCount++
    }
    const { data, error } = await client
      .from(PAYSLIP_IMPORT_LINES_TABLE)
      .update(patch)
      .eq('id', row.id)
      .select('*')
      .single()
    if (error) throw new Error(`persistExtractionConfidence (line ${row.id}) failed: ${error.message}`)
    updated.push({ ...data, _band: band })
  }
  return { lowCount, lines: updated }
}

/**
 * Run the full screenshot-extraction pipeline for one import, driving the canonical
 * lifecycle uploaded|failed → parsing → parsed → needs_review (§ 4). Reuses the
 * built staging / matcher / duplicate services verbatim. On ANY failure the import
 * is stamped 'failed' with the error (re-parsable, § 9.2) and the lines are left
 * clean.
 *
 * Ownership is validated defensively here (the route also enforces it via auth +
 * RLS) so the service is safe to call directly from the DEV test with a service-role
 * client (which bypasses RLS): owner / source / status are all asserted.
 *
 * @param {object} input
 * @param {string} input.importId
 * @param {string} input.ownerId                     MUST equal the import's owner_id
 * @param {object} [input.adapter]                   injectable adapter (default: stub)
 * @param {(imp:object)=>Promise<Uint8Array>} [input.loadBytes]
 *        ADDITIVE: lazily fetch the image bytes for a real OCR adapter (the route
 *        supplies this — it downloads the Storage object owner-scoped). The stub
 *        ignores bytes, so omitting loadBytes preserves the original behaviour.
 * @param {object} [client]                          fat-schema client
 * @returns {Promise<{ import: object, lines: object[], summary: object }>}
 */
export async function runScreenshotExtraction(input, client = defaultClient) {
  const { importId, ownerId, adapter = stubScreenshotOcrAdapter, loadBytes = null } = input
  if (!importId) throw new Error('runScreenshotExtraction: importId is required.')
  if (!ownerId) throw new Error('runScreenshotExtraction: ownerId is required.')

  // ── 0. Load + validate (owner / source / status) ─────────────────────────────
  const imp = await getImport(importId, client)
  if (!imp) throw new ExtractionStateError(`Import ${importId} not found.`, 'NOT_FOUND')
  if (imp.owner_id !== ownerId) {
    throw new ExtractionStateError('Import is not owned by the requesting user.', 'NOT_OWNER')
  }
  if (imp.source !== IMPORT_SOURCE.PAYSLIP_SCREENSHOT) {
    throw new ExtractionStateError(
      `Extraction is only for screenshot imports (got source '${imp.source}').`, 'WRONG_SOURCE')
  }
  if (!EXTRACTABLE_STATUSES.includes(imp.status)) {
    throw new ExtractionStateError(
      `Import status '${imp.status}' is not extractable (expected one of ${EXTRACTABLE_STATUSES.join('/')}). ` +
      'Already-extracted imports are not re-run (idempotency guard).', 'NOT_EXTRACTABLE')
  }

  let current = imp
  try {
    // ── 1. → parsing (force when re-parsing from 'failed') ──────────────────────
    const fromFailed = current.status === IMPORT_STATUS.FAILED
    current = await updateImportStatus(
      { importId, status: IMPORT_STATUS.PARSING, force: fromFailed }, client)

    // Clean slate so a re-parse from 'failed' never duplicates lines (§ 9.2).
    await clearImportLines(importId, client)

    // ── 2. Extract. The stub needs no bytes; a real OCR adapter does — fetch them
    //       lazily via loadBytes (additive) so this service stays Storage-agnostic. ─
    let bytes = null
    if (loadBytes) bytes = await loadBytes(imp)
    const result = await adapter.parse(
      { file_ref: imp.file_ref, file_hash: imp.file_hash, mime: imp.raw_extract?.mime ?? null, bytes },
      { pay_date: imp.pay_date },
    )
    const adapterLines = Array.isArray(result.lines) ? result.lines : []
    if (adapterLines.length === 0) {
      // Blank / illegible image — a real failure mode (§ 9.1), not a silent success.
      throw new Error('Extraction produced no payslip lines.')
    }

    // ── 3. Persist batch-level parse provenance onto the import ─────────────────
    const { error: metaErr } = await client
      .from(PAYSLIP_IMPORTS_TABLE)
      .update({
        pay_date: result.pay_date ?? imp.pay_date,
        pay_period_ref: result.pay_period_ref ?? imp.pay_period_ref,
        parser_name: result.parser_name,
        parser_version: result.parser_version,
        // Preserve the original ingest capture metadata alongside the extraction payload.
        raw_extract: { ...(imp.raw_extract ?? {}), extraction_result: result.raw_extract },
      })
      .eq('id', importId)
    if (metaErr) throw new Error(`runScreenshotExtraction (meta) failed: ${metaErr.message}`)

    // ── 4. Materialize lines via the EXISTING service (unchanged) ───────────────
    const inserted = await addImportLines({ importId, ownerId, lines: adapterLines }, client)

    // ── 5. Persist extraction confidence SEPARATELY (migration 14) + flag lows ──
    const { lowCount } = await persistExtractionConfidence(inserted, adapterLines, client)

    // ── 6. Matcher (existing, UNCHANGED) — additive + non-fatal ─────────────────
    // Mirrors createManualEntryImport: a matcher failure must never block the import
    // landing for review. It reads ONLY parsed_* fields — never extract_confidence.
    try {
      await scoreImportLines({ importId, ownerId }, client)
    } catch (matchErr) {
      console.warn(`runScreenshotExtraction: matcher skipped (${matchErr.message})`)
    }

    // ── 7. Duplicate detection (existing, UNCHANGED) — additive + non-fatal ─────
    try {
      await detectImportDuplicates({ importId, ownerId }, client)
    } catch (dupErr) {
      console.warn(`runScreenshotExtraction: duplicate detection skipped (${dupErr.message})`)
    }

    // ── 8. parsing → parsed → needs_review (the resting state) ──────────────────
    current = await updateImportStatus({ importId, status: IMPORT_STATUS.PARSED }, client)
    current = await updateImportStatus({ importId, status: IMPORT_STATUS.NEEDS_REVIEW }, client)

    const lines = await client
      .from(PAYSLIP_IMPORT_LINES_TABLE)
      .select('*')
      .eq('import_id', importId)
      .order('line_index', { ascending: true })
    const finalLines = lines.data ?? []

    return {
      import: current,
      lines: finalLines,
      summary: {
        importId,
        status: current.status,
        lineCount: finalLines.length,
        lowConfidenceCount: lowCount,
        parser: result.parser_name,
        // Honest provenance: true only for the deterministic stub, false for a real
        // OCR read (raw_extract.extraction === 'ocr').
        synthetic: result.raw_extract?.extraction !== 'ocr',
      },
    }
  } catch (err) {
    // ── 9. Failure → 'failed' + error, re-parsable. Leave a clean slate (§ 9.2). ─
    try { await clearImportLines(importId, client) } catch { /* best-effort */ }
    try {
      await updateImportStatus(
        { importId, status: IMPORT_STATUS.FAILED, error: String(err?.message ?? err), force: true },
        client)
    } catch { /* best-effort status stamp */ }
    throw err
  }
}
