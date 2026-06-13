// ─── OCR Payslip Import — staging models, lifecycle & constants (canonical) ───
// Pure constant + typedef + lifecycle exports — no Supabase dependency. The
// SINGLE source of truth for the OCR staging vocabulary: the migration-10 CHECK
// constraints, the service layer, the parser adapters, the (future) review UI,
// and any future real OCR provider all share THESE names. No synonyms — there is
// exactly one token per state (no 'draft', no 'reviewing'); temporary UI states
// map onto the canonical lifecycle, they never persist a parallel value.
//
// Spec: OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 3 (schema), § 4.1 (import
// lifecycle), § 4.2 (line lifecycle), § 6.2 (source mapping).

import { PAYMENT_RECORD_SOURCES } from './reconciliationConstants.js'

// ── Table names (fat-scoped client) ──────────────────────────────────────────
export const PAYSLIP_IMPORTS_TABLE = 'payslip_imports'
export const PAYSLIP_IMPORT_LINES_TABLE = 'payslip_import_lines'

// ── Import-level provenance (payslip_imports.source, § 3.1) ───────────────────
// How the BATCH was created. Distinct from payment_records.source (what kind of
// evidence a LINE is) — the two are mapped at confirm time (§ 6.2). MVP uses
// 'manual_entry' only; the file-backed sources land with O9 (post-MVP).
/** @typedef {'manual_entry'|'payslip_screenshot'|'payslip_pdf'} PayslipImportSource */
export const IMPORT_SOURCE = Object.freeze({
  MANUAL_ENTRY: 'manual_entry',
  PAYSLIP_SCREENSHOT: 'payslip_screenshot',
  PAYSLIP_PDF: 'payslip_pdf',
})
export const IMPORT_SOURCE_VALUES = Object.freeze([
  'manual_entry', 'payslip_screenshot', 'payslip_pdf',
])

// Import source → payment_records.source the confirm bridge writes (§ 6.2).
// 'manual_entry' → 'manual' so the canonical provenance reads "operator typed it"
// (spec § 4.4). The other two pass straight through. The bridge reads THIS map.
export const IMPORT_SOURCE_TO_RECORD_SOURCE = Object.freeze({
  manual_entry:       PAYMENT_RECORD_SOURCES.MANUAL,             // 'manual'
  payslip_screenshot: PAYMENT_RECORD_SOURCES.PAYSLIP_SCREENSHOT, // 'payslip_screenshot'
  payslip_pdf:        PAYMENT_RECORD_SOURCES.PAYSLIP_PDF,        // 'payslip_pdf'
})

// ── Import lifecycle (payslip_imports.status, § 4.1) — canonical vocabulary ────
/** @typedef {'uploaded'|'parsing'|'parsed'|'needs_review'|'confirmed'|'rejected'|'superseded'|'failed'} PayslipImportStatus */
export const IMPORT_STATUS = Object.freeze({
  UPLOADED: 'uploaded',
  PARSING: 'parsing',
  PARSED: 'parsed',
  NEEDS_REVIEW: 'needs_review',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  SUPERSEDED: 'superseded',
  FAILED: 'failed',
})
export const IMPORT_STATUS_VALUES = Object.freeze([
  'uploaded', 'parsing', 'parsed', 'needs_review',
  'confirmed', 'rejected', 'superseded', 'failed',
])
// Terminal import states — no outgoing transition (§ 4.1).
export const IMPORT_TERMINAL_STATUSES = Object.freeze(['confirmed', 'rejected', 'superseded'])
// Pre-confirm states: the ONLY states a 'superseded' re-upload may replace (§ 4.1
// — a confirmed/partially-confirmed import has already produced immutable records).
export const IMPORT_PRECONFIRM_STATUSES = Object.freeze([
  'uploaded', 'parsing', 'parsed', 'needs_review', 'failed',
])

// Legal import transitions (§ 4.1). superseded is reachable from any pre-confirm
// state (folded in below); failed may re-parse (failed → parsing).
export const IMPORT_TRANSITIONS = Object.freeze({
  uploaded:     Object.freeze(['parsing', 'superseded']),
  parsing:      Object.freeze(['parsed', 'failed', 'superseded']),
  parsed:       Object.freeze(['needs_review', 'superseded']),
  needs_review: Object.freeze(['confirmed', 'rejected', 'superseded']),
  failed:       Object.freeze(['parsing', 'superseded']),
  confirmed:    Object.freeze([]),
  rejected:     Object.freeze([]),
  superseded:   Object.freeze([]),
})

// ── Line lifecycle (payslip_import_lines.status, § 4.2) — canonical vocabulary ─
/** @typedef {'parsed'|'needs_review'|'confirmed'|'rejected'|'superseded'|'failed'} PayslipImportLineStatus */
export const IMPORT_LINE_STATUS = Object.freeze({
  PARSED: 'parsed',
  NEEDS_REVIEW: 'needs_review',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  SUPERSEDED: 'superseded',
  FAILED: 'failed',
})
export const IMPORT_LINE_STATUS_VALUES = Object.freeze([
  'parsed', 'needs_review', 'confirmed', 'rejected', 'superseded', 'failed',
])
// Terminal line states — produce no further mutation (§ 4.2). A confirmed line is
// idempotent (re-confirm is a no-op, § 6.3); rejected/superseded produce no record.
export const IMPORT_LINE_TERMINAL_STATUSES = Object.freeze(['confirmed', 'rejected', 'superseded'])
// A line in any of these blocks its import from reaching 'confirmed' (§ 4.1 —
// "confirmable when no line is still in parsed / needs_review").
export const IMPORT_LINE_OPEN_STATUSES = Object.freeze(['parsed', 'needs_review', 'failed'])

export const IMPORT_LINE_TRANSITIONS = Object.freeze({
  parsed:       Object.freeze(['needs_review', 'confirmed', 'rejected', 'superseded', 'failed']),
  needs_review: Object.freeze(['confirmed', 'rejected', 'superseded']),
  failed:       Object.freeze(['parsed', 'superseded']),
  confirmed:    Object.freeze([]),
  rejected:     Object.freeze([]),
  superseded:   Object.freeze([]),
})

// ── Extraction confidence (NEW — OCR_EXTRACTION_MVP_v1.0.md § 8) ───────────────
// The OCR analogue of, but strictly SEPARATE from, match confidence. It answers
// "did OCR read this line correctly?" (the parser adapter), NOT "which entitlement
// does it settle?" (the matcher). Persisted on payslip_import_lines.extract_confidence
// / extract_meta (migration 14). The matcher NEVER reads these columns — keeping the
// two confidences from bleeding (§ 8). Bands route operator attention only; they NEVER
// auto-confirm — human review stays mandatory on every line.
export const EXTRACT_CONFIDENCE = Object.freeze({
  HIGH: 0.85,   // ≥ → trustworthy read; line rests 'parsed' for normal review
  LOW: 0.50,    // < → suspect read; line is bumped to 'needs_review' + flagged
})

/** Classify an extraction confidence into a display/attention band. */
export function extractConfidenceBand(confidence) {
  const c = Number(confidence)
  if (!Number.isFinite(c)) return 'unknown'
  if (c >= EXTRACT_CONFIDENCE.HIGH) return 'high'
  if (c >= EXTRACT_CONFIDENCE.LOW) return 'medium'
  return 'low'
}

// ── Lifecycle predicates ──────────────────────────────────────────────────────
/** Is `to` a legal next import status from `from`? */
export function canTransitionImport(from, to) {
  return (IMPORT_TRANSITIONS[from] ?? []).includes(to)
}
/** Is `to` a legal next line status from `from`? */
export function canTransitionLine(from, to) {
  return (IMPORT_LINE_TRANSITIONS[from] ?? []).includes(to)
}
export function isImportTerminal(status) {
  return IMPORT_TERMINAL_STATUSES.includes(status)
}
export function isLineTerminal(status) {
  return IMPORT_LINE_TERMINAL_STATUSES.includes(status)
}
/** A line still requiring an operator decision (blocks import confirmation, § 4.1). */
export function isLineOpen(status) {
  return IMPORT_LINE_OPEN_STATUSES.includes(status)
}

// ── Typedefs (mirror the migration-10 columns) ────────────────────────────────
/**
 * @typedef {Object} PayslipImport
 * @property {string}              id
 * @property {string}              owner_id          // → fat.profiles.id
 * @property {PayslipImportSource} source
 * @property {PayslipImportStatus} status
 * @property {string|null}         file_ref
 * @property {string|null}         file_hash
 * @property {string|null}         pay_date          // ISO date
 * @property {string|null}         pay_period_ref
 * @property {string|null}         parser_name
 * @property {string|null}         parser_version
 * @property {number}              line_count
 * @property {object|null}         raw_extract
 * @property {string|null}         error
 * @property {string}              created_at
 * @property {string}              updated_at
 * @property {string|null}         confirmed_at
 */

/**
 * @typedef {Object} PayslipImportLine
 * @property {string}                  id
 * @property {string}                  import_id              // → payslip_imports.id
 * @property {string}                  owner_id               // → fat.profiles.id (denormalized)
 * @property {number}                  line_index
 * @property {string|null}             raw_text
 * @property {string|null}             parsed_reference
 * @property {string|null}             parsed_description
 * @property {number|null}             parsed_amount
 * @property {string|null}             parsed_date            // ISO date
 * @property {string|null}             candidate_entitlement_id
 * @property {number|null}             match_confidence
 * @property {object|null}             match_breakdown
 * @property {number|null}             extract_confidence     // OCR read confidence (§ 8; migration 14)
 * @property {object|null}             extract_meta           // OCR per-field meta (migration 14)
 * @property {PayslipImportLineStatus} status
 * @property {string|null}             payment_record_id      // bridge output
 * @property {string|null}             link_id                // bridge output
 * @property {string|null}             resolution_note
 * @property {string|null}             error
 * @property {string}                  created_at
 * @property {string}                  updated_at
 * @property {string|null}             confirmed_at
 */
