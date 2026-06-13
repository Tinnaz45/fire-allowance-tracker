// ─── Reconciliation predicates (pure, no Supabase dependency) ────────────────
// Parallel to entitlementHelpers.js. These are the shared predicates the status
// recomputer (server-side RPC mirrors the same logic) and the operator UI both
// rely on, so terminal-state determination is computed one way everywhere.
//
// Spec: RECONCILIATION_STATE_ARCHITECTURE_v1.0.md § 5.5 (terminal predicate),
// § 2.3 (stream coherence), PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md § 4.3 (unit
// branching: dollars-first uses tolerance, hours-first uses link count).
//
// IMPORTANT: the canonical recompute authority lives in the Postgres RPC
// (08_reconciliation_service_layer.sql → fat._reconc_recompute) so the mutation
// and its audit row commit atomically. The functions here MUST stay byte-for-byte
// equivalent in their decision so the derived-status the UI renders never
// disagrees with the status the server persists.

import {
  STREAM_STATUSES,
  STREAM_DERIVED_STATUSES,
  STATUS_ELIGIBLE_LINK_KINDS,
  DEFAULT_TOLERANCE,
  ENTITLEMENT_UNITS,
} from './reconciliationConstants.js'

/**
 * Filter a link set down to the status-eligible links (auto_match / manual).
 * discrepancy_note links never count toward terminal determination (§ 5.3).
 *
 * @param {Array<{ link_kind: string }>} links
 * @returns {Array<{ link_kind: string }>}
 */
export function statusEligibleLinks(links) {
  if (!Array.isArray(links)) return []
  return links.filter((l) => STATUS_ELIGIBLE_LINK_KINDS.includes(l?.link_kind))
}

/**
 * Sum of allocated_amount over the status-eligible links only (§ 5.5).
 * Tolerant of string-typed numerics returned by PostgREST.
 *
 * @param {Array<{ link_kind: string, allocated_amount: number|string }>} links
 * @returns {number}
 */
export function sumAllocated(links) {
  return statusEligibleLinks(links).reduce(
    (acc, l) => acc + (Number(l?.allocated_amount) || 0),
    0,
  )
}

/**
 * The stream's initial (non-terminal) STORED status — 'pending' / 'outstanding'.
 * @param {'payslip'|'petty_cash'} stream
 * @returns {string|null}
 */
export function initialStatusFor(stream) {
  return STREAM_STATUSES[stream]?.initial ?? null
}

/**
 * The stream's terminal STORED status — 'paid' / 'claimed'.
 * @param {'payslip'|'petty_cash'} stream
 * @returns {string|null}
 */
export function terminalStatusFor(stream) {
  return STREAM_STATUSES[stream]?.terminal ?? null
}

/**
 * Effective dollar amount — COALESCE(edited_amount, generated_amount). Null for
 * hours-first rows (mirrors entitlementHelpers.effectiveAmount; duplicated here
 * to keep this module free of cross-imports).
 */
function effectiveAmount(e) {
  return e?.edited_amount ?? e?.generated_amount ?? null
}

/**
 * Decide whether an entitlement has reached its terminal state given its
 * current status-eligible links. Branches on unit (§ 4.3 / § 5.5):
 *   - dollars: sum_allocated ≥ effective_amount − tolerance (effective required)
 *   - hours:   at least one status-eligible link exists
 *   - km:      transitional — never terminal (recomputer refuses)
 *
 * @param {{ unit: string, edited_amount?: number|null, generated_amount?: number|null }} entitlement
 * @param {Array<{ link_kind: string, allocated_amount: number|string }>} links
 * @param {{ tolerance?: number }} [opts]
 * @returns {boolean}
 */
export function isTerminal(entitlement, links, { tolerance = DEFAULT_TOLERANCE } = {}) {
  const eligible = statusEligibleLinks(links)
  switch (entitlement?.unit) {
    case ENTITLEMENT_UNITS.HOURS:
      return eligible.length >= 1
    case ENTITLEMENT_UNITS.DOLLARS: {
      const effective = effectiveAmount(entitlement)
      if (effective == null) return false
      return sumAllocated(eligible) >= Number(effective) - tolerance
    }
    case ENTITLEMENT_UNITS.KM:
    default:
      return false
  }
}

/**
 * The canonical STORED payment_status the recomputer would persist for an
 * entitlement, given its links. Returns null for an unrouted entitlement
 * (payment_method NULL ⇒ status NULL, § 2.3) or an unknown stream.
 *
 * @param {{ payment_method: string|null, unit: string, edited_amount?: number|null, generated_amount?: number|null }} entitlement
 * @param {Array} links
 * @param {{ tolerance?: number }} [opts]
 * @returns {string|null}  'pending' | 'paid' | 'outstanding' | 'claimed' | null
 */
export function recomputeStoredStatus(entitlement, links, opts = {}) {
  const stream = entitlement?.payment_method
  if (!STREAM_STATUSES[stream]) return null
  return isTerminal(entitlement, links, opts)
    ? terminalStatusFor(stream)
    : initialStatusFor(stream)
}

/**
 * The DERIVED (display) status — the six-value operator vocabulary
 * (pending / partially_paid / paid; outstanding / partially_reimbursed /
 * reimbursed). Adds the "partial" rung the stored column can't express:
 *   - terminal                       → terminal label (paid / reimbursed)
 *   - some eligible allocation but
 *     not yet terminal               → partial label
 *   - nothing eligible yet           → initial label (pending / outstanding)
 * Returns null for an unrouted entitlement or unknown stream.
 *
 * @param {{ payment_method: string|null, unit: string, edited_amount?: number|null, generated_amount?: number|null }} entitlement
 * @param {Array<{ link_kind: string, allocated_amount: number|string }>} links
 * @param {{ tolerance?: number }} [opts]
 * @returns {string|null}
 */
export function evaluateDerivedStatus(entitlement, links, opts = {}) {
  const stream = entitlement?.payment_method
  const ladder = STREAM_DERIVED_STATUSES[stream]
  if (!ladder) return null

  if (isTerminal(entitlement, links, opts)) return ladder.terminal

  const eligible = statusEligibleLinks(links)
  // "Partial" = there is eligible evidence on record, but it does not yet
  // satisfy the terminal predicate (dollars: under the tolerance band; hours:
  // hours-first rows are binary so this branch only fires for dollars units).
  const hasPartialEvidence = entitlement?.unit === ENTITLEMENT_UNITS.DOLLARS
    ? sumAllocated(eligible) > 0
    : false
  return hasPartialEvidence ? ladder.partial : ladder.initial
}

/**
 * Stream-coherence guard (§ 2.3): is `status` a legal STORED value for `stream`?
 * Accepts null (unrouted / unset). Used by helpers to refuse illegal writes.
 *
 * @param {string|null} stream
 * @param {string|null} status
 * @returns {boolean}
 */
export function isLegalStatusForStream(stream, status) {
  if (status == null) return true
  const s = STREAM_STATUSES[stream]
  if (!s) return false
  return status === s.initial || status === s.terminal
}
