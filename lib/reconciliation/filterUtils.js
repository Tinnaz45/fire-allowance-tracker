// ─── Filter Utilities ─────────────────────────────────────────────────────────
// Phase 4 — Centralized filtering pipeline for claims.
//
// All filters operate on the normalized groupedView structure from ClaimsContext.
// CANONICAL TRUTH: payment_status per sub-claim (never parent-level status).
//
// SUPPORTED FILTERS:
//   paymentStatus    — 'all' | 'pending' | 'paid'
//   paymentMethod    — 'all' | 'Payslip' | 'Petty Cash'
//   claimType        — 'all' | 'recalls' | 'retain' | 'standby' | 'spoilt' | 'delayed_meal'
//   paymentDateFrom  — 'YYYY-MM-DD' | null
//   paymentDateTo    — 'YYYY-MM-DD' | null
//   claimDateFrom    — 'YYYY-MM-DD' | null
//   claimDateTo      — 'YYYY-MM-DD' | null
//   overdueOnly      — boolean
//
// ARCHITECTURE:
//   - applyGroupFilters()    — filters grouped claim entries
//   - applyUngroupedFilters() — filters legacy/ungrouped claims
//   - applyAllFilters()      — applies all filters to full groupedView
//   - Filters are composable — each is a pure predicate function
// ─────────────────────────────────────────────────────────────────────────────

import {
  isSubclaimPaid,
  isSubclaimPending,
  resolveSubclaimPaymentMethod,
  resolveSubclaimPaymentDate,
  subclaimPaymentDateInRange,
  claimDateInRange,
} from './reconciliationUtils'
import { resolveEffectiveAmount } from '@/lib/calculations/engine'

// ─── Filter Spec ──────────────────────────────────────────────────────────────

/**
 * Default filter spec. Pass to applyAllFilters() to show everything.
 * @type {FilterSpec}
 */
export const DEFAULT_FILTERS = {
  paymentStatus:   'all',    // 'all' | 'pending' | 'paid'
  paymentMethod:   'all',    // 'all' | 'Payslip' | 'Petty Cash'
  claimType:       'all',    // 'all' | specific claim type
  paymentDateFrom: null,
  paymentDateTo:   null,
  claimDateFrom:   null,
  claimDateTo:     null,
  overdueOnly:     false,
}

// ─── Group-Level Filters ──────────────────────────────────────────────────────

/**
 * Returns true if a grouped entry passes the payment status filter.
 * CANONICAL: uses derivedPaymentStatus (computed from child payment_status).
 *
 * @param {{ derivedPaymentStatus: string }} entry
 * @param {'all'|'pending'|'paid'} paymentStatus
 * @returns {boolean}
 */
export function filterGroupByPaymentStatus(entry, paymentStatus) {
  if (paymentStatus === 'all') return true
  const ds = (entry.derivedPaymentStatus || 'Pending').toLowerCase()
  if (paymentStatus === 'paid')    return ds === 'paid'
  if (paymentStatus === 'pending') return ds !== 'paid'
  return true
}

/**
 * Returns true if a grouped entry has at least one child matching payment method.
 * CANONICAL: checks each child's payment_method.
 *
 * @param {{ children: object[] }} entry
 * @param {'all'|'Payslip'|'Petty Cash'} paymentMethod
 * @returns {boolean}
 */
export function filterGroupByPaymentMethod(entry, paymentMethod) {
  if (paymentMethod === 'all') return true
  return (entry.children || []).some(
    (c) => resolveSubclaimPaymentMethod(c) === paymentMethod
  )
}

/**
 * Returns true if a grouped entry matches the claim type filter.
 * Matches on group.claim_type or any child's claimType.
 *
 * @param {{ group: object, children: object[] }} entry
 * @param {string} claimType
 * @returns {boolean}
 */
export function filterGroupByClaimType(entry, claimType) {
  if (claimType === 'all') return true
  return (
    entry.group?.claim_type === claimType ||
    (entry.children || []).some((c) => c.claimType === claimType)
  )
}

/**
 * Returns true if any child was paid within the date range.
 * CANONICAL: uses child.payment_date.
 *
 * @param {{ children: object[] }} entry
 * @param {string|null} from
 * @param {string|null} to
 * @returns {boolean}
 */
export function filterGroupByPaymentDateRange(entry, from, to) {
  if (!from && !to) return true
  return (entry.children || []).some(
    (c) => subclaimPaymentDateInRange(c, from, to)
  )
}

/**
 * Returns true if the group's incident date falls within the range.
 *
 * @param {{ group: object }} entry
 * @param {string|null} from
 * @param {string|null} to
 * @returns {boolean}
 */
export function filterGroupByClaimDateRange(entry, from, to) {
  if (!from && !to) return true
  return claimDateInRange(entry.group, from, to)
}

/**
 * Returns true if the group is overdue (pending and past overdue_at).
 * CANONICAL: uses derivedPaymentStatus, not parent_status.
 *
 * @param {{ group: object, derivedPaymentStatus: string }} entry
 * @param {boolean} overdueOnly
 * @returns {boolean}
 */
export function filterGroupByOverdue(entry, overdueOnly) {
  if (!overdueOnly) return true
  const ds = (entry.derivedPaymentStatus || 'Pending').toLowerCase()
  if (ds !== 'pending' && ds !== 'partially paid') return false
  if (!entry.group?.overdue_at) return false
  return new Date() > new Date(entry.group.overdue_at)
}

// ─── Ungrouped-Level Filters ──────────────────────────────────────────────────

/**
 * Returns true if an ungrouped (legacy) claim passes the payment status filter.
 * Uses claim.status for legacy claims (only source available).
 *
 * @param {object} claim
 * @param {'all'|'pending'|'paid'} paymentStatus
 * @returns {boolean}
 */
export function filterUngroupedByPaymentStatus(claim, paymentStatus) {
  if (paymentStatus === 'all') return true
  const s = (claim.status || '').toLowerCase()
  if (paymentStatus === 'paid')    return s === 'paid'
  if (paymentStatus === 'pending') return s !== 'paid'
  return true
}

/**
 * Returns true if an ungrouped claim matches the payment method filter.
 * @param {object} claim
 * @param {'all'|'Payslip'|'Petty Cash'} paymentMethod
 * @returns {boolean}
 */
export function filterUngroupedByPaymentMethod(claim, paymentMethod) {
  if (paymentMethod === 'all') return true
  return claim.payment_method === paymentMethod
}

/**
 * Returns true if an ungrouped claim matches the claim type filter.
 * @param {object} claim
 * @param {string} claimType
 * @returns {boolean}
 */
export function filterUngroupedByClaimType(claim, claimType) {
  if (claimType === 'all') return true
  return claim.claimType === claimType
}

/**
 * Returns true if an ungrouped claim's payment date falls within range.
 * @param {object} claim
 * @param {string|null} from
 * @param {string|null} to
 * @returns {boolean}
 */
export function filterUngroupedByPaymentDateRange(claim, from, to) {
  if (!from && !to) return true
  return subclaimPaymentDateInRange(claim, from, to)
}

/**
 * Returns true if an ungrouped claim's date falls within range.
 * @param {object} claim
 * @param {string|null} from
 * @param {string|null} to
 * @returns {boolean}
 */
export function filterUngroupedByClaimDateRange(claim, from, to) {
  if (!from && !to) return true
  return claimDateInRange(claim, from, to)
}

// ─── Composable Pipeline ──────────────────────────────────────────────────────

/**
 * Apply all filters to a grouped entry.
 * Returns true if the entry passes all active filters.
 *
 * @param {object} entry — grouped view entry
 * @param {FilterSpec} filters
 * @returns {boolean}
 */
export function groupPassesFilters(entry, filters) {
  const f = { ...DEFAULT_FILTERS, ...filters }
  return (
    filterGroupByPaymentStatus(entry, f.paymentStatus) &&
    filterGroupByPaymentMethod(entry, f.paymentMethod) &&
    filterGroupByClaimType(entry, f.claimType) &&
    filterGroupByPaymentDateRange(entry, f.paymentDateFrom, f.paymentDateTo) &&
    filterGroupByClaimDateRange(entry, f.claimDateFrom, f.claimDateTo) &&
    filterGroupByOverdue(entry, f.overdueOnly)
  )
}

/**
 * Apply all filters to an ungrouped (legacy) claim.
 *
 * @param {object} claim
 * @param {FilterSpec} filters
 * @returns {boolean}
 */
export function ungroupedPassesFilters(claim, filters) {
  const f = { ...DEFAULT_FILTERS, ...filters }
  return (
    filterUngroupedByPaymentStatus(claim, f.paymentStatus) &&
    filterUngroupedByPaymentMethod(claim, f.paymentMethod) &&
    filterUngroupedByClaimType(claim, f.claimType) &&
    filterUngroupedByPaymentDateRange(claim, f.paymentDateFrom, f.paymentDateTo) &&
    filterUngroupedByClaimDateRange(claim, f.claimDateFrom, f.claimDateTo)
  )
}

/**
 * Apply all filters to a full groupedView, returning filtered grouped + ungrouped arrays.
 *
 * @param {{ grouped: object[], ungrouped: object[] }} groupedView
 * @param {FilterSpec} filters
 * @returns {{ grouped: object[], ungrouped: object[] }}
 */
export function applyAllFilters(groupedView, filters) {
  const { grouped = [], ungrouped = [] } = groupedView || {}
  return {
    grouped:   grouped.filter((e) => groupPassesFilters(e, filters)),
    ungrouped: ungrouped.filter((c) => ungroupedPassesFilters(c, filters)),
  }
}

// ─── Sort Helpers ─────────────────────────────────────────────────────────────

/**
 * Sort grouped entries.
 * @param {object[]} entries
 * @param {'date-desc'|'date-asc'|'type'|'amount-desc'|'amount-asc'} sortBy
 * @returns {object[]}
 */
export function sortGroupedEntries(entries, sortBy) {
  return [...entries].sort((a, b) => {
    const dateA = a.group?.incident_date || a.group?.created_at || ''
    const dateB = b.group?.incident_date || b.group?.created_at || ''

    if (sortBy === 'date-asc')  return new Date(dateA) - new Date(dateB)
    if (sortBy === 'type')      return (a.group?.claim_type || '').localeCompare(b.group?.claim_type || '')
    if (sortBy === 'amount-desc') {
      const amtA = a.children?.reduce((s, c) => s + (Number(c.component_amount ?? c.total_amount ?? 0)), 0) || 0
      const amtB = b.children?.reduce((s, c) => s + (Number(c.component_amount ?? c.total_amount ?? 0)), 0) || 0
      return amtB - amtA
    }
    if (sortBy === 'amount-asc') {
      const amtA = a.children?.reduce((s, c) => s + (Number(c.component_amount ?? c.total_amount ?? 0)), 0) || 0
      const amtB = b.children?.reduce((s, c) => s + (Number(c.component_amount ?? c.total_amount ?? 0)), 0) || 0
      return amtA - amtB
    }
    // date-desc (default)
    return new Date(dateB) - new Date(dateA)
  })
}

/**
 * Sort ungrouped claims.
 * @param {object[]} claims
 * @param {'date-desc'|'date-asc'|'type'} sortBy
 * @returns {object[]}
 */
export function sortUngroupedClaims(claims, sortBy) {
  return [...claims].sort((a, b) => {
    if (sortBy === 'date-asc') return new Date(a.date) - new Date(b.date)
    if (sortBy === 'type')     return (a.claimType || '').localeCompare(b.claimType || '')
    return new Date(b.date) - new Date(a.date)
  })
}
