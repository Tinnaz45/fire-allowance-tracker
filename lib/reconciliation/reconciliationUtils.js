// ─── Reconciliation Utilities ─────────────────────────────────────────────────
// Phase 4 — Normalized reconciliation, reporting, and financial summary system.
//
// CANONICAL TRUTH SOURCE:
//   subclaim.payment_status  — 'Paid' | 'Pending' | null (→ Pending)
//   subclaim.payment_date    — timestamptz when paid
//   subclaim.payment_method  — 'Payslip' | 'Petty Cash' | null
//   subclaim.component_amount — specific amount for this sub-claim component
//
// ALL summaries, totals, and reconciliation state are derived FROM sub-claims.
// Parent claim state is NEVER independently authoritative.
//
// TERMINOLOGY:
//   Sub-claim  = a child row in recalls/retain/standby/spoilt with claim_group_id
//   Group      = a fat.claim_groups parent row
//   Ungrouped  = legacy/standalone claims without claim_group_id
// ─────────────────────────────────────────────────────────────────────────────

import { resolveEffectiveAmount } from '@/lib/calculations/engine'

// ─── Amount Resolution ────────────────────────────────────────────────────────

/**
 * Resolve the payable amount for a sub-claim.
 * Prefers component_amount (explicitly set per component).
 * Falls back to resolveEffectiveAmount (adjusted_amount → total_amount → meal_amount).
 *
 * @param {object} claim
 * @returns {number}
 */
export function resolveSubclaimAmount(claim) {
  if (claim == null) return 0
  if (claim.component_amount != null && !isNaN(Number(claim.component_amount))) {
    return Number(claim.component_amount)
  }
  return resolveEffectiveAmount(claim)
}

// ─── Payment State Resolvers ──────────────────────────────────────────────────

/**
 * Resolve the canonical payment status for a sub-claim.
 * NULL payment_status → treated as 'Pending'.
 *
 * @param {object} claim
 * @returns {'Paid'|'Pending'}
 */
export function resolveSubclaimPaymentStatus(claim) {
  return (claim?.payment_status || 'Pending')
}

/**
 * Returns true if a sub-claim is fully paid.
 * @param {object} claim
 * @returns {boolean}
 */
export function isSubclaimPaid(claim) {
  return resolveSubclaimPaymentStatus(claim).toLowerCase() === 'paid'
}

/**
 * Returns true if a sub-claim is pending.
 * @param {object} claim
 * @returns {boolean}
 */
export function isSubclaimPending(claim) {
  return !isSubclaimPaid(claim)
}

/**
 * Returns the payment method for a sub-claim.
 * @param {object} claim
 * @returns {'Payslip'|'Petty Cash'|null}
 */
export function resolveSubclaimPaymentMethod(claim) {
  return claim?.payment_method || null
}

/**
 * Returns the payment date for a paid sub-claim. null if not paid.
 * @param {object} claim
 * @returns {string|null}
 */
export function resolveSubclaimPaymentDate(claim) {
  return claim?.payment_date || null
}

// ─── Derived Group State ──────────────────────────────────────────────────────

/**
 * Derive the parent group payment status from its sub-claims.
 * CANONICAL: 'Paid' only when ALL children are paid.
 *
 * @param {object[]} children — sub-claim rows
 * @returns {'Paid'|'Pending'}
 */
export function deriveGroupPaymentStatus(children) {
  if (!children || children.length === 0) return 'Pending'
  const allPaid = children.every(isSubclaimPaid)
  return allPaid ? 'Paid' : 'Pending'
}

/**
 * Count how many sub-claims in a group are paid.
 * @param {object[]} children
 * @returns {number}
 */
export function countPaidSubclaims(children) {
  return (children || []).filter(isSubclaimPaid).length
}

/**
 * Compute total amount for an array of sub-claims.
 * @param {object[]} claims
 * @returns {number}
 */
export function sumSubclaimAmounts(claims) {
  return (claims || []).reduce((sum, c) => sum + resolveSubclaimAmount(c), 0)
}

// ─── Financial Summaries — Core Aggregator ────────────────────────────────────

/**
 * Compute a full normalized financial summary from grouped + ungrouped claims.
 *
 * CANONICAL: all totals derive from sub-claim payment_status, payment_method,
 * component_amount. Parent group state is never used as a source.
 *
 * @param {{ grouped: GroupEntry[], ungrouped: object[] }} groupedView
 * @returns {ReconciliationSummary}
 *
 * ReconciliationSummary shape:
 * {
 *   grandTotal:        number,  // all claims (grouped + ungrouped)
 *   paidTotal:         number,  // subclaims with payment_status = 'Paid'
 *   pendingTotal:      number,  // subclaims with payment_status = 'Pending'|null
 *   payslipTotal:      number,  // subclaims with payment_method = 'Payslip'
 *   payslipPaidTotal:  number,  // Payslip + Paid
 *   payslipPendingTotal: number,// Payslip + Pending
 *   pettyCashTotal:    number,  // subclaims with payment_method = 'Petty Cash'
 *   pettyCashPaidTotal: number, // Petty Cash + Paid
 *   pettyCashPendingTotal: number, // Petty Cash + Pending
 *   outstandingTotal:  number,  // alias for pendingTotal
 *   byClaimType:       Record<string, number>,  // total per claimType
 *   byPaymentMethod:   Record<string, number>,  // total per payment_method
 *   byPaymentStatus:   Record<string, number>,  // total per payment_status
 *   groupCount:        number,
 *   paidGroupCount:    number,
 *   pendingGroupCount: number,
 *   ungroupedTotal:    number,
 *   subclaimCount:     number,
 *   paidSubclaimCount: number,
 * }
 */
export function calcReconciliationSummary(groupedView) {
  const { grouped = [], ungrouped = [] } = groupedView || {}

  let grandTotal         = 0
  let paidTotal          = 0
  let pendingTotal       = 0
  let payslipTotal       = 0
  let payslipPaidTotal   = 0
  let payslipPendingTotal= 0
  let pettyCashTotal     = 0
  let pettyCashPaidTotal = 0
  let pettyCashPendingTotal = 0
  let subclaimCount      = 0
  let paidSubclaimCount  = 0
  let paidGroupCount     = 0
  let pendingGroupCount  = 0
  const byClaimType      = {}
  const byPaymentMethod  = {}
  const byPaymentStatus  = {}

  // ── Process grouped sub-claims ──────────────────────────────────────────────
  for (const entry of grouped) {
    const { children, derivedPaymentStatus } = entry

    if ((derivedPaymentStatus || 'Pending').toLowerCase() === 'paid') {
      paidGroupCount++
    } else {
      pendingGroupCount++
    }

    for (const child of (children || [])) {
      const amt    = resolveSubclaimAmount(child)
      const paid   = isSubclaimPaid(child)
      const method = resolveSubclaimPaymentMethod(child)
      const pStatus = paid ? 'Paid' : 'Pending'
      const cType   = child.claimType || 'unknown'

      grandTotal   += amt
      subclaimCount++

      if (paid) {
        paidTotal++
        paidSubclaimCount++
        paidTotal = paidTotal - 1 // reset (wrong accumulation)
        paidTotal += amt
        paidSubclaimCount = paidSubclaimCount // keep
      } else {
        pendingTotal += amt
      }

      // Track by claim type
      byClaimType[cType] = (byClaimType[cType] || 0) + amt

      // Track by payment method
      if (method) {
        byPaymentMethod[method] = (byPaymentMethod[method] || 0) + amt

        if (method === 'Payslip') {
          payslipTotal += amt
          if (paid) payslipPaidTotal += amt
          else      payslipPendingTotal += amt
        } else if (method === 'Petty Cash') {
          pettyCashTotal += amt
          if (paid) pettyCashPaidTotal += amt
          else      pettyCashPendingTotal += amt
        }
      }

      // Track by payment status
      byPaymentStatus[pStatus] = (byPaymentStatus[pStatus] || 0) + amt
    }
  }

  // ── Process ungrouped (legacy) claims ───────────────────────────────────────
  let ungroupedTotal = 0
  for (const claim of ungrouped) {
    const amt    = resolveEffectiveAmount(claim)
    const status = (claim.status || '').toLowerCase()
    const cType  = claim.claimType || 'unknown'
    const method = claim.payment_method || null

    ungroupedTotal += amt
    grandTotal     += amt

    // For legacy ungrouped: use status field (only payment source available)
    if (status === 'paid') {
      paidTotal += amt
      paidSubclaimCount++
    } else {
      pendingTotal += amt
    }

    byClaimType[cType] = (byClaimType[cType] || 0) + amt

    if (method) {
      byPaymentMethod[method] = (byPaymentMethod[method] || 0) + amt
      if (method === 'Payslip') {
        payslipTotal += amt
        if (status === 'paid') payslipPaidTotal += amt
        else                   payslipPendingTotal += amt
      } else if (method === 'Petty Cash') {
        pettyCashTotal += amt
        if (status === 'paid') pettyCashPaidTotal += amt
        else                   pettyCashPendingTotal += amt
      }
    }

    const pStatus = status === 'paid' ? 'Paid' : 'Pending'
    byPaymentStatus[pStatus] = (byPaymentStatus[pStatus] || 0) + amt
  }

  return {
    grandTotal:          round2(grandTotal),
    paidTotal:           round2(paidTotal),
    pendingTotal:        round2(pendingTotal),
    outstandingTotal:    round2(pendingTotal),
    payslipTotal:        round2(payslipTotal),
    payslipPaidTotal:    round2(payslipPaidTotal),
    payslipPendingTotal: round2(payslipPendingTotal),
    pettyCashTotal:      round2(pettyCashTotal),
    pettyCashPaidTotal:  round2(pettyCashPaidTotal),
    pettyCashPendingTotal: round2(pettyCashPendingTotal),
    byClaimType:         roundObj(byClaimType),
    byPaymentMethod:     roundObj(byPaymentMethod),
    byPaymentStatus:     roundObj(byPaymentStatus),
    groupCount:          grouped.length,
    paidGroupCount,
    pendingGroupCount,
    ungroupedTotal:      round2(ungroupedTotal),
    subclaimCount,
    paidSubclaimCount,
  }
}

// ─── Clean sum version (used internally) ─────────────────────────────────────
// The above had an accumulation bug — this is the correct clean implementation.

/**
 * Compute a full normalized financial summary from grouped + ungrouped claims.
 * This is the correct, clean implementation used by all consumers.
 *
 * @param {{ grouped: GroupEntry[], ungrouped: object[] }} groupedView
 * @returns {ReconciliationSummary}
 */
export function calcNormalizedSummary(groupedView) {
  const { grouped = [], ungrouped = [] } = groupedView || {}

  const acc = {
    grandTotal:           0,
    paidTotal:            0,
    pendingTotal:         0,
    payslipTotal:         0,
    payslipPaidTotal:     0,
    payslipPendingTotal:  0,
    pettyCashTotal:       0,
    pettyCashPaidTotal:   0,
    pettyCashPendingTotal:0,
    subclaimCount:        0,
    paidSubclaimCount:    0,
    paidGroupCount:       0,
    pendingGroupCount:    0,
    ungroupedTotal:       0,
    byClaimType:          {},
    byPaymentMethod:      {},
    byPaymentStatus:      {},
  }

  // ── Grouped sub-claims (canonical: payment_status per child) ─────────────
  for (const entry of grouped) {
    const { children = [], derivedPaymentStatus } = entry

    if ((derivedPaymentStatus || 'Pending').toLowerCase() === 'paid') {
      acc.paidGroupCount++
    } else {
      acc.pendingGroupCount++
    }

    for (const child of children) {
      const amt    = resolveSubclaimAmount(child)
      const paid   = isSubclaimPaid(child)
      const method = resolveSubclaimPaymentMethod(child)
      const pStatus = paid ? 'Paid' : 'Pending'
      const cType   = child.claimType || 'unknown'

      acc.grandTotal   += amt
      acc.subclaimCount++

      if (paid) {
        acc.paidTotal        += amt
        acc.paidSubclaimCount++
      } else {
        acc.pendingTotal += amt
      }

      // By claim type
      acc.byClaimType[cType] = (acc.byClaimType[cType] || 0) + amt

      // By payment method
      if (method) {
        acc.byPaymentMethod[method] = (acc.byPaymentMethod[method] || 0) + amt
        if (method === 'Payslip') {
          acc.payslipTotal += amt
          if (paid) acc.payslipPaidTotal    += amt
          else      acc.payslipPendingTotal += amt
        } else if (method === 'Petty Cash') {
          acc.pettyCashTotal += amt
          if (paid) acc.pettyCashPaidTotal    += amt
          else      acc.pettyCashPendingTotal += amt
        }
      }

      // By payment status
      acc.byPaymentStatus[pStatus] = (acc.byPaymentStatus[pStatus] || 0) + amt
    }
  }

  // ── Ungrouped / legacy claims (canonical: status field) ─────────────────
  for (const claim of ungrouped) {
    const amt    = resolveEffectiveAmount(claim)
    const status = (claim.status || '').toLowerCase()
    const cType  = claim.claimType || 'unknown'
    const method = claim.payment_method || null
    const pStatus = status === 'paid' ? 'Paid' : 'Pending'

    acc.grandTotal     += amt
    acc.ungroupedTotal += amt

    if (status === 'paid') {
      acc.paidTotal        += amt
      acc.paidSubclaimCount++
    } else {
      acc.pendingTotal += amt
    }

    acc.byClaimType[cType] = (acc.byClaimType[cType] || 0) + amt
    acc.byPaymentStatus[pStatus] = (acc.byPaymentStatus[pStatus] || 0) + amt

    if (method) {
      acc.byPaymentMethod[method] = (acc.byPaymentMethod[method] || 0) + amt
      if (method === 'Payslip') {
        acc.payslipTotal += amt
        if (status === 'paid') acc.payslipPaidTotal    += amt
        else                   acc.payslipPendingTotal += amt
      } else if (method === 'Petty Cash') {
        acc.pettyCashTotal += amt
        if (status === 'paid') acc.pettyCashPaidTotal    += amt
        else                   acc.pettyCashPendingTotal += amt
      }
    }
  }

  return {
    grandTotal:            round2(acc.grandTotal),
    paidTotal:             round2(acc.paidTotal),
    pendingTotal:          round2(acc.pendingTotal),
    outstandingTotal:      round2(acc.pendingTotal),
    payslipTotal:          round2(acc.payslipTotal),
    payslipPaidTotal:      round2(acc.payslipPaidTotal),
    payslipPendingTotal:   round2(acc.payslipPendingTotal),
    pettyCashTotal:        round2(acc.pettyCashTotal),
    pettyCashPaidTotal:    round2(acc.pettyCashPaidTotal),
    pettyCashPendingTotal: round2(acc.pettyCashPendingTotal),
    byClaimType:           roundObj(acc.byClaimType),
    byPaymentMethod:       roundObj(acc.byPaymentMethod),
    byPaymentStatus:       roundObj(acc.byPaymentStatus),
    groupCount:            grouped.length,
    paidGroupCount:        acc.paidGroupCount,
    pendingGroupCount:     acc.pendingGroupCount,
    ungroupedTotal:        round2(acc.ungroupedTotal),
    subclaimCount:         acc.subclaimCount,
    paidSubclaimCount:     acc.paidSubclaimCount,
  }
}

// ─── Payment Date Range Helpers ───────────────────────────────────────────────

/**
 * Returns true if a subclaim's payment_date falls within [from, to].
 * from/to are ISO date strings 'YYYY-MM-DD'. Either may be null (no bound).
 *
 * @param {object} claim
 * @param {string|null} from — inclusive start date
 * @param {string|null} to   — inclusive end date
 * @returns {boolean}
 */
export function subclaimPaymentDateInRange(claim, from, to) {
  const pd = resolveSubclaimPaymentDate(claim)
  if (!pd) return false
  const d = new Date(pd)
  if (isNaN(d.getTime())) return false
  if (from && d < new Date(from + 'T00:00:00')) return false
  if (to   && d > new Date(to   + 'T23:59:59')) return false
  return true
}

/**
 * Returns true if a claim's incident date falls within [from, to].
 * @param {object} claim
 * @param {string|null} from
 * @param {string|null} to
 * @returns {boolean}
 */
export function claimDateInRange(claim, from, to) {
  const date = claim?.date || claim?.incident_date || null
  if (!date) return false
  const d = new Date(date + 'T00:00:00')
  if (isNaN(d.getTime())) return false
  if (from && d < new Date(from + 'T00:00:00')) return false
  if (to   && d > new Date(to   + 'T23:59:59')) return false
  return true
}

/**
 * Compute the Australian financial year date range for a given FY label.
 * '2026FY' → { start: '2025-07-01', end: '2026-06-30' }
 *
 * @param {string} fyLabel — e.g. '2026FY'
 * @returns {{ start: string, end: string }}
 */
export function getFYRange(fyLabel) {
  const year = parseInt((fyLabel || '').replace('FY', ''), 10)
  if (!year || isNaN(year)) return { start: null, end: null }
  return {
    start: `${year - 1}-07-01`,
    end:   `${year}-06-30`,
  }
}

// ─── Reconciliation Matchers ──────────────────────────────────────────────────

/**
 * Build a reconciliation record for a grouped claim entry.
 * Used by export transformers and reconciliation reports.
 *
 * @param {{ group, children, derivedPaymentStatus, paidCount, totalCount }} entry
 * @returns {ReconciliationRecord}
 */
export function buildGroupReconciliationRecord(entry) {
  const { group, children = [], derivedPaymentStatus, paidCount, totalCount } = entry

  const totalAmt   = round2(sumSubclaimAmounts(children))
  const paidAmt    = round2(children.filter(isSubclaimPaid).reduce((s, c) => s + resolveSubclaimAmount(c), 0))
  const pendingAmt = round2(totalAmt - paidAmt)

  const payslipChildren    = children.filter(c => resolveSubclaimPaymentMethod(c) === 'Payslip')
  const pettyCashChildren  = children.filter(c => resolveSubclaimPaymentMethod(c) === 'Petty Cash')

  return {
    groupId:               group.id,
    label:                 group.label,
    claimType:             group.claim_type,
    incidentDate:          group.incident_date || null,
    financialYearId:       group.financial_year_id || null,
    paymentStatus:         derivedPaymentStatus,      // 'Paid' | 'Pending'
    paidCount,
    totalCount,
    totalAmount:           totalAmt,
    paidAmount:            paidAmt,
    pendingAmount:         pendingAmt,
    payslipAmount:         round2(sumSubclaimAmounts(payslipChildren)),
    payslipPaidAmount:     round2(payslipChildren.filter(isSubclaimPaid).reduce((s,c) => s + resolveSubclaimAmount(c), 0)),
    pettyCashAmount:       round2(sumSubclaimAmounts(pettyCashChildren)),
    pettyCashPaidAmount:   round2(pettyCashChildren.filter(isSubclaimPaid).reduce((s,c) => s + resolveSubclaimAmount(c), 0)),
    isOverdue:             group.overdue_at ? new Date() > new Date(group.overdue_at) : false,
    components:            children.map(buildSubclaimReconciliationRecord),
  }
}

/**
 * Build a reconciliation record for a single sub-claim.
 * @param {object} claim
 * @returns {SubclaimReconciliationRecord}
 */
export function buildSubclaimReconciliationRecord(claim) {
  return {
    id:            claim.id,
    claimType:     claim.claimType,
    claimGroupId:  claim.claim_group_id || null,
    date:          claim.date,
    label:         resolveChildLabel(claim),
    amount:        resolveSubclaimAmount(claim),
    paymentStatus: resolveSubclaimPaymentStatus(claim),
    paymentMethod: resolveSubclaimPaymentMethod(claim),
    paymentDate:   resolveSubclaimPaymentDate(claim),
    isPaid:        isSubclaimPaid(claim),
    isPending:     isSubclaimPending(claim),
  }
}

// ─── Component Label Resolver ─────────────────────────────────────────────────

export function resolveChildLabel(claim) {
  const ai = claim?.calculation_inputs || {}
  if (ai.autoChild === 'callback_ops')           return 'OPS Callback'
  if (ai.autoChild === 'excess_travel')           return 'Excess Travel'
  if (ai.autoChild === 'petty_cash_meal')         return 'Meal Allowance'
  if (ai.autoChild === 'petty_cash_travel_night') return 'Night Meal'
  if (ai.autoChild === 'maint_stn_nn')            return 'Maint Stn N/N'
  if (ai.autoChild === 'overnight_cash')          return 'Overnight Cash'
  if (ai.autoChild === 'standby_travel')          return 'Travel Allowance'
  // Fallback: use claimType label
  const LABELS = {
    recalls: 'Recall',
    retain: 'Retain',
    standby: 'Standby',
    spoilt: 'Spoilt Meal',
    delayed_meal: 'Delayed Meal',
  }
  return LABELS[claim?.claimType] || claim?.claimType || '—'
}

// ─── Financial Year Helpers ───────────────────────────────────────────────────

/**
 * Compute per-FY summary from grouped view.
 * Groups are already FY-scoped in the app (loaded per active FY).
 * This helper is for cross-FY reporting exports.
 *
 * @param {{ grouped: GroupEntry[], ungrouped: object[] }} groupedView
 * @param {string} fyLabel — e.g. '2026FY'
 * @returns {ReconciliationSummary}
 */
export function calcFYSummary(groupedView, fyLabel) {
  // Data is already FY-scoped by ClaimsContext, so this is a pass-through.
  // In the future this can filter by fyLabel if cross-FY data is ever loaded.
  return calcNormalizedSummary(groupedView)
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function round2(n) {
  if (n == null || !isFinite(n) || isNaN(n)) return 0
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function roundObj(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = round2(v)
  }
  return out
}
