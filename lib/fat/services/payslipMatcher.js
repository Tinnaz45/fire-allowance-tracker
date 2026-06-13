// ─── OCR Payslip Import — candidate matching engine (Step O4) ─────────────────
// Proposes a ranked candidate entitlement + a confidence score for each staged
// payslip line. This is the "candidate recommendation" layer that sits between a
// parsed import and the operator's review: it pre-fills the review queue and
// orders it by likelihood, but it NEVER auto-confirms — operator approval stays
// mandatory (architecture § 5.3, governance "manual override always available").
//
// Spec: OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 5 (confidence model) and the
// companion PAYSLIP_MATCHING_ENGINE_v1.0.md. The matcher is EVIDENCE, not policy:
// it writes only the three suggestion columns the staging line already carries
// (candidate_entitlement_id, match_confidence, match_breakdown) — it touches no
// canonical reconciliation state (principle § 2.1) and never changes a line's
// lifecycle status (the persisted vocabulary has no 'matched' value — the band is
// a display-only concept derived from the score).
//
// The scoring core (scoreCandidate / rankCandidates / signal fns) is PURE — no
// Supabase dependency — so it is unit-testable on plain data. Only the loader and
// scoreImportLines touch the DB.

import { fat as defaultClient } from '../../supabaseClient.js'
import { CLAIM_ENTITLEMENTS_TABLE } from '../models/claimEntitlement.js'
import { OPERATIONAL_CLAIMS_TABLE } from '../models/operationalClaim.js'
import {
  PAYSLIP_IMPORT_LINES_TABLE,
  IMPORT_LINE_STATUS,
} from '../models/payslipImport.js'
import { PAYMENT_STREAMS, PAYMENT_STATUS, ENTITLEMENT_UNITS } from '../models/reconciliationConstants.js'
import { DEFAULT_TOLERANCE } from '../models/reconciliationConstants.js'

// ── Identity of this matcher (stamped into match_breakdown for audit) ──────────
export const MATCHER_NAME = 'payslip-heuristic-v1'

// ── Confidence bands (§ 5.3 — Recommendation defaults, gated by blocker #3) ────
// The band only ORDERS and PRE-FILLS the review queue. Even an 'auto' line is
// operator-confirmed in the MVP; auto-confirm is a later phase (O11).
export const MATCH_THRESHOLDS = Object.freeze({
  AUTO: 0.90,    // ≥ → strong candidate, pre-selected
  REVIEW: 0.50,  // ≥ → candidate shown for confirm/change; < → no pre-fill, manual
})

/** Classify a confidence score into a display band. */
export function confidenceBand(confidence) {
  const c = Number(confidence)
  if (!Number.isFinite(c)) return 'none'
  if (c >= MATCH_THRESHOLDS.AUTO) return 'auto'
  if (c >= MATCH_THRESHOLDS.REVIEW) return 'review'
  return 'none'
}

// ── Signal weights (§ 5.2) ─────────────────────────────────────────────────────
// amount is dollars-first-only: an hours-first entitlement (generated_amount NULL,
// the entire MVP candidate set in DEV) carries no derivable dollar value, so its
// amount signal is NOT APPLICABLE and the confidence is re-normalized over the
// signals that ARE applicable. This is the documented resolution of blocker #8 —
// it keeps hours-first lines fully scoreable (and able to reach the auto band)
// rather than capping them at 0.55 of the weight (which, with 100% hours-first
// candidates in DEV, would make the matcher inert). See PAYSLIP_MATCHING_ENGINE § 4.
export const SIGNAL_WEIGHTS = Object.freeze({
  amount: 0.45,
  pay_cycle: 0.25,
  reference: 0.20,
  type: 0.10,
})

// ── Type-keyword heuristics: payslip line text → entitlement_type (§ 5.2 `type`) ─
// Distinctive tokens per known entitlement_type. Used to INFER the type a line
// describes, independent of the candidate (so a line about "MEAL" scores the
// `type` signal low against a Standby candidate).
const TYPE_KEYWORDS = Object.freeze({
  excess_travel_standby: ['excess', 'travel', 'standby', 'km', 'kms', 'kilometre', 'mileage'],
  excess_travel_md: ['excess', 'travel', 'muster', 'dismiss', 'dismissal', 'km', 'kms', 'mileage'],
  standby_dismi: ['standby', 'dismissal', 'dismiss', 'recall'],
  muster_dismis: ['muster', 'dismiss', 'dismissal'],
  small_meal: ['meal', 'small', 'refreshment'],
  large_meal: ['meal', 'large', 'dinner'],
})

// Type "families" — a near-miss within a family scores partial on the type signal
// (e.g. a generic "EXCESS TRAVEL" line against either excess_travel_* candidate).
const TYPE_FAMILY = Object.freeze({
  excess_travel_standby: 'excess_travel',
  excess_travel_md: 'excess_travel',
  standby_dismi: 'standby',
  muster_dismis: 'muster',
  small_meal: 'meal',
  large_meal: 'meal',
})

// Human label tokens per type — feeds the `reference` token-overlap signal.
const TYPE_LABELS = Object.freeze({
  excess_travel_standby: 'excess travel standby',
  excess_travel_md: 'excess travel muster dismiss',
  standby_dismi: 'standby dismissal',
  muster_dismis: 'muster dismiss',
  small_meal: 'small meal',
  large_meal: 'large meal',
})

// Date-proximity window (days). A payslip pay date normally trails the work/claim
// date by a pay cycle; we score on absolute proximity within this window. Pay-cycle
// INFERENCE (claim date → exact expected FRV cycle) is unresolved (blocker #4) — this
// proximity decay is the documented MVP stand-in. Ranking degrades gracefully, it
// does not break (operator still confirms every line).
export const PAY_CYCLE_WINDOW_DAYS = 35

// ── Pure helpers ───────────────────────────────────────────────────────────────

/** Lowercase, strip punctuation, split into ≥2-char tokens. */
export function tokenize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
}

/** Effective dollar value of a (dollars-first) entitlement, else null. */
function effectiveAmount(e) {
  return e?.edited_amount ?? e?.generated_amount ?? null
}

/** Whole-day difference between two ISO dates; null if either is missing/invalid. */
function dayDiff(isoA, isoB) {
  if (!isoA || !isoB) return null
  const a = new Date(`${String(isoA).slice(0, 10)}T00:00:00Z`)
  const b = new Date(`${String(isoB).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null
  return Math.round(Math.abs(a.getTime() - b.getTime()) / 86_400_000)
}

/** The date a candidate entitlement is anchored to: its claim date, else generated_at. */
function candidateDate(ent) {
  return ent?._claim_date ?? (ent?.generated_at ? String(ent.generated_at).slice(0, 10) : null)
}

/** Infer the entitlement_type a line's text most likely describes (or null). */
export function inferLineType(line) {
  const tokens = new Set(tokenize(`${line?.parsed_reference ?? ''} ${line?.parsed_description ?? ''}`))
  if (tokens.size === 0) return null
  let best = null
  let bestHits = 0
  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    const hits = keywords.reduce((n, kw) => n + (tokens.has(kw) ? 1 : 0), 0)
    if (hits > bestHits) { bestHits = hits; best = type }
  }
  return bestHits > 0 ? best : null
}

// ── Signal scorers — each returns { applicable, score } where score ∈ [0,1] ─────

/** amount: relative closeness of line $ to the entitlement's effective $ (dollars-first only). */
export function scoreAmount(line, ent, { tolerance = DEFAULT_TOLERANCE } = {}) {
  const amt = line?.parsed_amount
  const eff = ent?.unit === ENTITLEMENT_UNITS.DOLLARS ? effectiveAmount(ent) : null
  if (amt == null || eff == null || Number(eff) <= 0) return { applicable: false, score: 0 }
  const diff = Math.abs(Number(amt) - Number(eff))
  if (diff <= tolerance) return { applicable: true, score: 1 }
  return { applicable: true, score: Math.max(0, 1 - diff / Number(eff)) }
}

/** pay_cycle: date proximity between the line date and the candidate's anchor date. */
export function scorePayCycle(line, ent, importPayDate) {
  const lineDate = line?.parsed_date ?? importPayDate ?? null
  const candDate = candidateDate(ent)
  const days = dayDiff(lineDate, candDate)
  if (days == null) return { applicable: false, score: 0, days: null }
  return { applicable: true, score: Math.max(0, 1 - days / PAY_CYCLE_WINDOW_DAYS), days }
}

/** reference: token overlap between line text and the candidate's type-label tokens. */
export function scoreReference(line, ent) {
  const lineTokens = new Set(tokenize(`${line?.parsed_reference ?? ''} ${line?.parsed_description ?? ''}`))
  if (lineTokens.size === 0) return { applicable: false, score: 0, overlap: 0 }
  const labelTokens = tokenize(TYPE_LABELS[ent?.entitlement_type] ?? String(ent?.entitlement_type ?? '').replace(/_/g, ' '))
  if (labelTokens.length === 0) return { applicable: false, score: 0, overlap: 0 }
  const overlap = labelTokens.reduce((n, t) => n + (lineTokens.has(t) ? 1 : 0), 0)
  return { applicable: true, score: Math.min(1, overlap / labelTokens.length), overlap }
}

/** type: does the line's inferred type match the candidate's type (exact / family / conflict)? */
export function scoreType(line, ent) {
  const inferred = inferLineType(line)
  if (!inferred) return { applicable: false, score: 0, inferred: null }
  if (inferred === ent?.entitlement_type) return { applicable: true, score: 1, inferred }
  if (TYPE_FAMILY[inferred] && TYPE_FAMILY[inferred] === TYPE_FAMILY[ent?.entitlement_type]) {
    return { applicable: true, score: 0.5, inferred }
  }
  return { applicable: true, score: 0, inferred } // a confident conflict — penalize
}

/**
 * Score one (line, candidate) pair. Confidence is the weighted mean over the
 * APPLICABLE signals only (re-normalized), so a missing signal neither inflates
 * nor deflates the result — it simply doesn't vote. Returns the full per-signal
 * breakdown for transparency (stored in match_breakdown, shown in the review UI).
 *
 * @returns {{ entitlement_id: string, confidence: number, band: string,
 *             applicable_weight: number, signals: object }}
 */
export function scoreCandidate(line, ent, ctx = {}) {
  const { importPayDate = null, tolerance = DEFAULT_TOLERANCE } = ctx
  const signals = {
    amount: scoreAmount(line, ent, { tolerance }),
    pay_cycle: scorePayCycle(line, ent, importPayDate),
    reference: scoreReference(line, ent),
    type: scoreType(line, ent),
  }

  // Identifying vs corroborating evidence. amount / reference / type IDENTIFY the
  // line as this entitlement; pay_cycle only CORROBORATES timing. Date proximity
  // must never manufacture a match on its own — without at least one positive
  // identifying signal the candidate scores 0 (otherwise a payroll-noise line that
  // happens to fall in the pay window would falsely pre-fill, especially for the
  // hours-first majority where the amount signal is absent — see blocker #8).
  const hasIdentifyingEvidence = ['amount', 'reference', 'type']
    .some((k) => signals[k]?.applicable && signals[k].score > 0)

  let confidence = 0
  let applicableWeight = 0
  if (hasIdentifyingEvidence) {
    let weighted = 0
    for (const [key, weight] of Object.entries(SIGNAL_WEIGHTS)) {
      const sig = signals[key]
      if (sig?.applicable) {
        weighted += weight * sig.score
        applicableWeight += weight
      }
    }
    confidence = applicableWeight > 0
      ? Math.round((weighted / applicableWeight) * 10000) / 10000  // 4dp, matches numeric(5,4)
      : 0
  }

  return {
    entitlement_id: ent.id,
    confidence,
    band: confidenceBand(confidence),
    applicable_weight: Math.round(applicableWeight * 10000) / 10000,
    identifying: hasIdentifyingEvidence,
    signals,
  }
}

/**
 * Rank every eligible candidate for a line, best first. Hard filters (§ 5.1) are
 * assumed already applied to `candidates` (payslip-eligible, owner-coherent) — the
 * loader does that. Ties break by entitlement_type for determinism.
 *
 * @returns {Array<ReturnType<typeof scoreCandidate>>}
 */
export function rankCandidates(line, candidates, ctx = {}) {
  return (candidates ?? [])
    .map((ent) => ({ ...scoreCandidate(line, ent, ctx), entitlement: ent }))
    .sort((a, b) => (b.confidence - a.confidence)
      || String(a.entitlement?.entitlement_type ?? '').localeCompare(String(b.entitlement?.entitlement_type ?? '')))
}

/**
 * Build the persisted match_breakdown jsonb for a line from its ranked candidates.
 * Records the winning signal breakdown plus up to three alternatives, the band,
 * and the matcher identity — enough for the operator (and a later audit) to see
 * WHY a line matched (§ 5.2). Evidence only; never a commitment.
 */
export function buildBreakdown(ranked) {
  const top = ranked[0] ?? null
  return {
    matcher: MATCHER_NAME,
    note: 'evidence only — operator confirmation is mandatory',
    weights: SIGNAL_WEIGHTS,
    band: top ? top.band : 'none',
    confidence: top ? top.confidence : 0,
    applicable_weight: top ? top.applicable_weight : 0,
    signals: top ? top.signals : null,
    candidate_count: ranked.length,
    alternatives: ranked.slice(1, 4).map((r) => ({
      entitlement_id: r.entitlement_id,
      entitlement_type: r.entitlement?.entitlement_type ?? null,
      confidence: r.confidence,
    })),
  }
}

// ── DB layer ───────────────────────────────────────────────────────────────────

const CANDIDATE_COLS =
  'id, claim_id, owner_id, entitlement_type, unit, generated_amount, generated_hours, ' +
  'edited_amount, edited_hours, payment_method, payment_status, generated_at'

/**
 * Load the payslip-eligible candidate entitlements for an owner (§ 5.1 hard
 * filters): payment_method='payslip' AND payment_status='pending' (the
 * operator-selectable set — exactly the confirm picker's set, so every suggestion
 * is actionable). The claim's work date is embedded for the date-proximity signal.
 *
 * NOTE (MVP scope): § 5.1 also admits unrouted (payment_method NULL) and
 * already-terminal candidates at lower rank. MVP excludes both — unrouted needs
 * routeEntitlement (deferred) and is dead because SB/MD arrive pre-routed; re-pay
 * matching against 'paid' rows lands with auto-confirm (O11).
 *
 * @param {string} ownerId
 * @param {object} [client]
 * @returns {Promise<object[]>}  candidates, each carrying `_claim_date`
 */
export async function listPayslipMatchCandidates(ownerId, client = defaultClient) {
  if (!ownerId) throw new Error('listPayslipMatchCandidates: ownerId is required.')
  const { data, error } = await client
    .from(CLAIM_ENTITLEMENTS_TABLE)
    .select(`${CANDIDATE_COLS}, ${OPERATIONAL_CLAIMS_TABLE}(claim_date)`)
    .eq('owner_id', ownerId)
    .eq('payment_method', PAYMENT_STREAMS.PAYSLIP)
    .eq('payment_status', PAYMENT_STATUS.PENDING)
    .order('generated_at', { ascending: true })
  if (error) throw new Error(`listPayslipMatchCandidates failed: ${error.message}`)
  return (data ?? []).map(({ [OPERATIONAL_CLAIMS_TABLE]: claim, ...ent }) => ({
    ...ent,
    _claim_date: claim?.claim_date ?? null,
  }))
}

/**
 * Score an import's open lines against the owner's payslip-eligible candidates and
 * persist the suggestion onto each line: candidate_entitlement_id (the top match
 * when confidence ≥ the review threshold, else null — a low score pre-fills
 * nothing and the operator links manually), match_confidence, and the full
 * match_breakdown. Lifecycle status is left UNTOUCHED — the matcher is evidence,
 * not a transition (§ 5.3). Idempotent: re-running re-scores in place.
 *
 * Only lines in an OPEN, non-terminal state are (re)scored (parsed / needs_review /
 * failed) — a confirmed/rejected/superseded line is never disturbed.
 *
 * @param {object} input
 * @param {string} input.importId
 * @param {string} input.ownerId
 * @param {number} [input.tolerance=0.01]
 * @param {object[]} [input.candidates]   pre-loaded candidates (skip the query)
 * @param {object} [client]
 * @returns {Promise<{ scored: number, lines: object[] }>}
 */
export async function scoreImportLines(input, client = defaultClient) {
  const { importId, ownerId, tolerance = DEFAULT_TOLERANCE } = input
  if (!importId) throw new Error('scoreImportLines: importId is required.')
  if (!ownerId) throw new Error('scoreImportLines: ownerId is required.')

  const { data: imp, error: impErr } = await client
    .from('payslip_imports').select('id, pay_date').eq('id', importId).maybeSingle()
  if (impErr) throw new Error(`scoreImportLines (import) failed: ${impErr.message}`)
  if (!imp) throw new Error(`scoreImportLines: import ${importId} not found.`)

  const { data: lines, error: lineErr } = await client
    .from(PAYSLIP_IMPORT_LINES_TABLE)
    .select('*')
    .eq('import_id', importId)
    .in('status', [IMPORT_LINE_STATUS.PARSED, IMPORT_LINE_STATUS.NEEDS_REVIEW, IMPORT_LINE_STATUS.FAILED])
    .order('line_index', { ascending: true })
  if (lineErr) throw new Error(`scoreImportLines (lines) failed: ${lineErr.message}`)
  if (!lines?.length) return { scored: 0, lines: [] }

  const candidates = input.candidates ?? await listPayslipMatchCandidates(ownerId, client)
  const ctx = { importPayDate: imp.pay_date, tolerance }

  const updated = []
  for (const line of lines) {
    const ranked = rankCandidates(line, candidates, ctx)
    const top = ranked[0] ?? null
    const breakdown = buildBreakdown(ranked)
    // Pre-fill the candidate only when the top score clears the review threshold;
    // a weak best match leaves the line un-prefilled for a manual operator link.
    const candidateId = top && top.confidence >= MATCH_THRESHOLDS.REVIEW ? top.entitlement_id : null

    const { data, error } = await client
      .from(PAYSLIP_IMPORT_LINES_TABLE)
      .update({
        candidate_entitlement_id: candidateId,
        match_confidence: top ? top.confidence : 0,
        match_breakdown: breakdown,
      })
      .eq('id', line.id)
      .select('*')
      .single()
    if (error) throw new Error(`scoreImportLines (update line ${line.id}) failed: ${error.message}`)
    updated.push(data)
  }

  return { scored: updated.length, lines: updated }
}
