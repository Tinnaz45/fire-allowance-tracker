// ─── OCR Payslip Import — content fingerprinting (pure, canonical) ────────────
// Deterministic content fingerprints for duplicate detection (blocker #1,
// OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 4.1 / § 11; PAYSLIP_DUPLICATE_DETECTION
// _v1.0.md § 2). Pure JS — no Supabase, no crypto import, no Date/random — so it is
// trivially unit-testable and runs identically in the browser, Node, and the test
// bench.
//
// TWO fingerprint scopes, deliberately split by LANGUAGE so they can never drift:
//   · LINE fingerprint  — computed in SQL (migration 12, fat.payslip_line_content_fp)
//                         and stored on the line. The confirm-bridge guard and this
//                         module both only ever READ it; it is the single source of
//                         truth for "is this the same line of content". JS does NOT
//                         recompute line content here.
//   · IMPORT fingerprint — computed HERE, from the import's batch metadata (source,
//                         pay period, pay date) plus its sorted line fingerprints.
//                         Import-level equality = an exact-duplicate import. Used by
//                         the JS detection service only — never by the RPC — so it
//                         needs no SQL parity.
//
// The two scopes answer different questions: the line fp powers the hard
// double-confirmation guard (don't mint a second payment_record for content already
// settled); the import fp + Jaccard over line fps powers the advisory "this import
// looks like one you already created" warning.

export const IMPORT_FP_VERSION = 'imp1'

// ── cyrb53 — a fast, deterministic, dependency-free 53-bit string hash ──────────
// Stable across engines (integer ops only). Rendered as a fixed 14-char hex tail so
// the stored fingerprint is compact and equality-comparable. Not cryptographic — it
// does not need to be: collisions only ever cause a false "exact duplicate" flag,
// which the operator reviews and can override (operator decision is final).
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0))
}

/** Hex render of cyrb53 (compact, equality-comparable). */
function cyrb53hex(str) {
  return cyrb53(str).toString(16).padStart(14, '0')
}

const SEP = '' // unit separator — same delimiter the SQL line fp uses

/** Canonical projection of an import's batch-level identity (source + period + date). */
function importBatchKey({ source, payDate, payPeriodRef }) {
  return [
    String(source ?? '').trim().toLowerCase(),
    String(payPeriodRef ?? '').trim().toLowerCase(),
    String(payDate ?? '').slice(0, 10),
  ].join(SEP)
}

/**
 * Import-level content fingerprint (§ 2.2). Deterministic in the import's batch
 * identity AND its set of line fingerprints — ORDER-INDEPENDENT (lines are sorted
 * before hashing), so re-typing the same payslip with rows in a different order
 * still collides. A line with no stored fingerprint (e.g. pre-migration) is skipped
 * rather than poisoning the hash with an empty token.
 *
 * @param {object} input
 * @param {string}   input.source              import source ('manual_entry' | …)
 * @param {string|null} input.payDate          ISO 'YYYY-MM-DD'
 * @param {string|null} input.payPeriodRef
 * @param {string[]} input.lineFingerprints    the lines' stored content_fingerprint values
 * @returns {string}                           e.g. 'imp1:0a1b2c…'
 */
export function importContentFingerprint({ source, payDate, payPeriodRef, lineFingerprints = [] }) {
  const fps = [...lineFingerprints].filter(Boolean).sort()
  const canonical = `${importBatchKey({ source, payDate, payPeriodRef })}${SEP}${fps.join(',')}`
  return `${IMPORT_FP_VERSION}:${cyrb53hex(canonical)}`
}

/**
 * Jaccard similarity of two line-fingerprint sets: |A ∩ B| / |A ∪ B| ∈ [0,1].
 * The core near-duplicate signal (§ 3.2) — how much of two imports' line content
 * overlaps, independent of order or count. Two empty sets are treated as 0 (no
 * evidence of duplication rather than a vacuous 1).
 *
 * @returns {{ score: number, shared: number, union: number }}
 */
export function lineSetSimilarity(fpsA = [], fpsB = []) {
  const a = new Set((fpsA ?? []).filter(Boolean))
  const b = new Set((fpsB ?? []).filter(Boolean))
  if (a.size === 0 && b.size === 0) return { score: 0, shared: 0, union: 0 }
  let shared = 0
  for (const fp of a) if (b.has(fp)) shared++
  const union = a.size + b.size - shared
  return { score: union === 0 ? 0 : Math.round((shared / union) * 10000) / 10000, shared, union }
}

// ── Near-duplicate classification thresholds (§ 3.2 — Recommendation defaults) ──
// NEAR_SIMILARITY: line-set Jaccard at/above which two non-identical imports are a
//   near-duplicate regardless of pay period.
// PERIOD_COINCIDENT_MIN_SHARED: when two imports share the SAME pay period (date or
//   ref), even a single shared line is enough to flag — same-period re-entry is the
//   highest-risk duplicate path.
export const DUP_THRESHOLDS = Object.freeze({
  NEAR_SIMILARITY: 0.5,
  PERIOD_COINCIDENT_MIN_SHARED: 1,
})

/** Do two imports describe the same pay period (by date or by ref)? */
export function samePayPeriod(a, b) {
  const refA = String(a?.pay_period_ref ?? '').trim().toLowerCase()
  const refB = String(b?.pay_period_ref ?? '').trim().toLowerCase()
  if (refA && refB) return refA === refB
  const dateA = String(a?.pay_date ?? '').slice(0, 10)
  const dateB = String(b?.pay_date ?? '').slice(0, 10)
  return !!dateA && dateA === dateB
}
