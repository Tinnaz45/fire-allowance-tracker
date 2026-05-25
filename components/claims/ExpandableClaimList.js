'use client'

// ─── ExpandableClaimList ───────────────────────────────────────────────────────
// Phase 4 — Expandable multi-component payment UI with normalized filtering.
//
// ARCHITECTURE:
//   - Grouped claims (from fat.claim_groups) render as expandable parent rows.
//   - Each parent expands to reveal its sub-claim payment components.
//   - Ungrouped/legacy claims render as flat cards (unchanged from ClaimList).
//   - QuickPayToggle updates payment_status + payment_date per sub-claim.
//   - Parent stays Pending until all sub-claims are Paid.
//   - Progress indicator per parent: "2/3 paid"
//   - PaymentMethodBadge: Payslip (indigo) / Petty Cash (orange)
//   - PaymentStatusBadge: ✓ Paid (green) / ○ Pending (yellow)
//   - Mobile-first: single-column stacked layout, no horizontal overflow.
//   - Preserves all existing edit workflows.
//   - No duplicate rendering. No hydration warnings. No console errors.
//
// PHASE 4 ADDITIONS:
//   - paymentMethodFilter prop: 'Payslip' | 'Petty Cash' | undefined (= all)
//   - paymentDateFrom/paymentDateTo props: 'YYYY-MM-DD' | undefined
//   - All filters use centralized filterUtils pipeline (canonical truth: payment_status)
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react'
import { useClaims } from '@/lib/claims/ClaimsContext'
import { CLAIM_TYPE_LABELS } from '@/lib/claims/claimTypes'
import {
  resolveEffectiveAmount,
  isAmountAdjusted,
  isClaimOverdue,
  formatDateDDMMYY,
} from '@/lib/calculations/engine'
import {
  groupPassesFilters,
  ungroupedPassesFilters,
  sortGroupedEntries,
  sortUngroupedClaims,
} from '@/lib/reconciliation/filterUtils'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveComponentAmount(claim) {
  if (claim.component_amount != null && !isNaN(Number(claim.component_amount))) {
    return Number(claim.component_amount)
  }
  return resolveEffectiveAmount(claim)
}

function resolveChildLabel(claim) {
  const ai = claim.calculation_inputs || {}
  if (ai.autoChild === 'callback_ops')           return 'OPS Callback'
  if (ai.autoChild === 'excess_travel')           return 'Excess Travel'
  if (ai.autoChild === 'petty_cash_meal')         return 'Meal Allowance'
  if (ai.autoChild === 'petty_cash_travel_night') return 'Night Meal'
  if (ai.autoChild === 'maint_stn_nn')            return 'Maint Stn N/N'
  if (ai.autoChild === 'overnight_cash')          return 'Overnight Cash'
  if (ai.autoChild === 'standby_travel')          return 'Travel Allowance'
  return CLAIM_TYPE_LABELS[claim.claimType] || claim.claimType
}

// ─── StatusBadge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const lower = (status || '').toLowerCase()
  const map = {
    paid:             { background: 'rgba(34,197,94,0.15)',  border: '1px solid rgba(34,197,94,0.4)',  color: '#4ade80' },
    pending:          { background: 'rgba(234,179,8,0.15)',  border: '1px solid rgba(234,179,8,0.4)',  color: '#facc15' },
    disputed:         { background: 'rgba(239,68,68,0.15)',  border: '1px solid rgba(239,68,68,0.4)',  color: '#f87171' },
    'partially paid': { background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.4)', color: '#a5b4fc' },
  }
  const style = map[lower] || { background: 'rgba(107,114,128,0.15)', border: '1px solid rgba(107,114,128,0.4)', color: '#9ca3af' }
  return (
    <span style={{
      ...style,
      display: 'inline-block',
      padding: '2px 9px',
      borderRadius: '999px',
      fontSize: '0.69rem',
      fontWeight: 700,
      textTransform: 'capitalize',
      letterSpacing: '0.03em',
      flexShrink: 0,
    }}>
      {status || '—'}
    </span>
  )
}

// ─── PaymentStatusBadge ────────────────────────────────────────────────────────

function PaymentStatusBadge({ paymentStatus }) {
  if (paymentStatus == null) return null
  const isPaid = (paymentStatus || '').toLowerCase() === 'paid'
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '3px',
      padding: '2px 8px',
      borderRadius: '999px',
      fontSize: '0.67rem',
      fontWeight: 700,
      letterSpacing: '0.03em',
      flexShrink: 0,
      background: isPaid ? 'rgba(34,197,94,0.18)' : 'rgba(234,179,8,0.12)',
      border: isPaid ? '1px solid rgba(34,197,94,0.5)' : '1px solid rgba(234,179,8,0.3)',
      color: isPaid ? '#86efac' : '#fde68a',
    }}>
      {isPaid ? '✓ Paid' : '○ Pending'}
    </span>
  )
}

// ─── PaymentMethodBadge ────────────────────────────────────────────────────────
// Payslip → indigo  |  Petty Cash → orange

function PaymentMethodBadge({ method }) {
  if (!method) return null
  const isPayslip = method === 'Payslip'
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '3px',
      padding: '2px 7px',
      borderRadius: '5px',
      fontSize: '0.63rem',
      fontWeight: 700,
      letterSpacing: '0.03em',
      flexShrink: 0,
      textTransform: 'uppercase',
      background: isPayslip ? 'rgba(99,102,241,0.15)' : 'rgba(251,146,60,0.15)',
      border: isPayslip ? '1px solid rgba(99,102,241,0.4)' : '1px solid rgba(251,146,60,0.4)',
      color: isPayslip ? '#a5b4fc' : '#fdba74',
    }}>
      {isPayslip ? '📋 Payslip' : '💵 Petty Cash'}
    </span>
  )
}

// ─── ProgressPill ─────────────────────────────────────────────────────────────
// Shows "2/3 paid" progress for a parent claim group.

function ProgressPill({ paid, total }) {
  if (total === 0) return null
  const allPaid  = paid === total
  const partial  = paid > 0 && paid < total
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '2px 8px',
      borderRadius: '5px',
      fontSize: '0.66rem',
      fontWeight: 700,
      letterSpacing: '0.02em',
      flexShrink: 0,
      background: allPaid ? 'rgba(34,197,94,0.12)' : partial ? 'rgba(99,102,241,0.1)' : 'rgba(234,179,8,0.08)',
      border:     allPaid ? '1px solid rgba(34,197,94,0.35)' : partial ? '1px solid rgba(99,102,241,0.35)' : '1px solid rgba(234,179,8,0.25)',
      color:      allPaid ? '#86efac' : partial ? '#a5b4fc' : '#fde68a',
    }}>
      {paid}/{total} paid
    </span>
  )
}

// ─── QuickPayToggle ────────────────────────────────────────────────────────────
// One-click "Mark Paid" per unpaid sub-claim. Updates payment_status + payment_date.
// Only visible for unpaid subclaims (payment_status null or 'Pending').
// Treats null payment_status as 'Pending' — shows button for all new claims.
// Rolls back optimistically on error and shows retry state.

function QuickPayToggle({ claim, session, activeFY }) {
  const { updatePaymentStatus } = useClaims()
  const [toggling, setToggling] = useState(false)
  const [hasError, setHasError] = useState(false)

  const isPaid = (claim.payment_status || '').toLowerCase() === 'paid'

  // Only visible for unpaid subclaims
  if (isPaid) return null

  const handleMarkPaid = async (e) => {
    e.stopPropagation()
    if (toggling || !session) return
    setToggling(true)
    setHasError(false)
    try {
      await updatePaymentStatus({
        userId: session.user.id,
        claim,
        paymentStatus: 'Paid',
        financialYearId: activeFY?.id || null,
      })
    } catch (err) {
      console.error('[QuickPayToggle]', err)
      setHasError(true)
    } finally {
      setToggling(false)
    }
  }

  return (
    <button
      onClick={handleMarkPaid}
      disabled={toggling}
      title="Mark as Paid"
      style={{
        padding: '3px 10px',
        borderRadius: '6px',
        border: hasError ? '1px solid rgba(239,68,68,0.5)' : '1px solid rgba(34,197,94,0.4)',
        background: hasError ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
        color: hasError ? '#f87171' : '#86efac',
        fontSize: '0.7rem',
        fontWeight: 700,
        cursor: toggling ? 'wait' : 'pointer',
        opacity: toggling ? 0.6 : 1,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        transition: 'opacity 0.15s',
        whiteSpace: 'nowrap',
      }}
    >
      {toggling ? '…' : hasError ? '✕ Retry' : 'Mark Paid'}
    </button>
  )
}

// ─── SubClaimRow ──────────────────────────────────────────────────────────────
// One row per child claim inside an expanded parent group.
// Shows: tree connector, label, payment method badge, amount, payment status, quick-pay.

// SubClaimRow — CANONICAL TRUTH: payment_status only.
// For legacy rows (payment_status = null), treat as Pending (no fallback to status).
// The status field is preserved on the row but is NOT used for payment display.

function SubClaimRow({ claim, session, activeFY, isLast }) {
  const label  = resolveChildLabel(claim)
  const amt    = resolveComponentAmount(claim)
  // CANONICAL: payment_status is the sole payment truth source
  const displayPaid = (claim.payment_status || 'Pending').toLowerCase() === 'paid'

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      padding: '9px 0',
      borderBottom: isLast ? 'none' : '1px solid #1e1e1e',
      gap: '8px',
    }}>
      {/* Left: tree connector + label + method badge */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0, flex: 1 }}>
        <span style={{
          color: '#374151',
          fontSize: '0.78rem',
          flexShrink: 0,
          marginTop: '3px',
          fontFamily: 'monospace',
        }}>
          {isLast ? '└─' : '├─'}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: '0.84rem',
            color: displayPaid ? '#6b7280' : '#d1d5db',
            fontWeight: 500,
            textDecoration: displayPaid ? 'line-through' : 'none',
            textDecorationColor: '#4b5563',
          }}>
            {label}
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            marginTop: '4px',
            flexWrap: 'wrap',
          }}>
            {claim.payslip_pay_nbr && (
              <span style={{ fontSize: '0.68rem', color: '#6b7280' }}>
                Pay #{claim.payslip_pay_nbr}
              </span>
            )}
            <PaymentMethodBadge method={claim.payment_method} />
            {claim.payment_date && displayPaid && (
              <span style={{ fontSize: '0.67rem', color: '#4b5563' }}>
                {formatDateDDMMYY(claim.payment_date)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Right: amount + payment status badge + quick-pay toggle */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexShrink: 0,
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
      }}>
        <span style={{
          fontSize: '0.87rem',
          fontWeight: 700,
          color: displayPaid ? '#6b7280' : '#f9fafb',
          fontVariantNumeric: 'tabular-nums',
        }}>
          ${amt.toFixed(2)}
        </span>
        {/* CANONICAL: always show PaymentStatusBadge from payment_status */}
        <PaymentStatusBadge paymentStatus={claim.payment_status || 'Pending'} />
        <QuickPayToggle claim={claim} session={session} activeFY={activeFY} />
      </div>
    </div>
  )
}

// ─── ExpandableGroupRow ────────────────────────────────────────────────────────
// Expandable parent row with sub-claim children underneath.
// Header: claim group label + date + total + progress pill + status badge.
// Body (when expanded): one SubClaimRow per child claim.
//
// CANONICAL TRUTH: uses derivedPaymentStatus + paidCount + totalCount from
// groupedView (computed in ClaimsContext from subclaim.payment_status only).
// group.parent_status is shown as a display badge ONLY (cached projection).

function ExpandableGroupRow({ groupEntry, onEdit, session, activeFY }) {
  // Destructure normalized fields from groupedView entry
  const { group, children, derivedPaymentStatus, paidCount, totalCount } = groupEntry
  const [expanded, setExpanded] = useState(false)

  const totalAmt = children.reduce((sum, c) => sum + resolveComponentAmount(c), 0)

  // Overdue check: pending or partially-paid groups can be overdue
  const isOverdue = (() => {
    const lower = (derivedPaymentStatus || '').toLowerCase()
    if (lower !== 'pending' && lower !== 'partially paid') return false
    if (!group.overdue_at) return false
    return new Date() > new Date(group.overdue_at)
  })()

  const headerBg      = isOverdue ? 'rgba(251,191,36,0.04)' : '#161616'
  const containerBg   = isOverdue ? 'rgba(251,191,36,0.025)' : '#111'
  const containerBorder = isOverdue ? '1.5px solid rgba(239,68,68,0.5)' : '1px solid #2a2a2a'

  return (
    <div style={{
      borderRadius: '12px',
      border: containerBorder,
      background: containerBg,
      marginBottom: '10px',
      overflow: 'hidden',
    }}>
      {/* ── Header row (clickable) ── */}
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '13px 16px',
          cursor: 'pointer',
          borderBottom: expanded ? '1px solid #1e1e1e' : 'none',
          gap: '8px',
          background: headerBg,
          userSelect: 'none',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {/* Left: chevron + label + date + total */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
          <span style={{
            color: '#4b5563',
            fontSize: '0.68rem',
            flexShrink: 0,
            transition: 'transform 0.15s',
            display: 'inline-block',
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
          }}>
            ▼
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontSize: '0.92rem',
              fontWeight: 700,
              color: '#f9fafb',
              marginBottom: '3px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {group.label}
            </div>
            <div style={{
              fontSize: '0.71rem',
              color: '#6b7280',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              flexWrap: 'wrap',
            }}>
              {group.incident_date && (
                <span>{formatDateDDMMYY(group.incident_date)}</span>
              )}
              {group.incident_date && <span>·</span>}
              <span>{children.length} item{children.length !== 1 ? 's' : ''}</span>
              <span>·</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                <strong style={{ color: '#e5e7eb' }}>${totalAmt.toFixed(2)}</strong>
              </span>
            </div>
          </div>
        </div>

        {/* Right: overdue flag + progress pill + normalized payment status badge */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          flexShrink: 0,
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
        }}>
          {isOverdue && (
            <span style={{
              fontSize: '0.62rem',
              fontWeight: 700,
              color: '#f87171',
              background: 'rgba(239,68,68,0.12)',
              border: '1px solid rgba(239,68,68,0.35)',
              borderRadius: '4px',
              padding: '2px 6px',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              flexShrink: 0,
            }}>
              🚩 Overdue
            </span>
          )}
          {/* Progress pill: always from payment_status canonical source */}
          {totalCount > 0 && (
            <ProgressPill paid={paidCount} total={totalCount} />
          )}
          {/* Status badge: shows derivedPaymentStatus (canonical), not DB parent_status */}
          <StatusBadge status={derivedPaymentStatus} />
        </div>
      </div>

      {/* ── Expanded sub-claim body ── */}
      {expanded && (
        <div style={{ padding: '4px 16px 12px 16px', background: '#0f0f0f' }}>
          {children.length === 0 ? (
            <p style={{ fontSize: '0.8rem', color: '#4b5563', margin: '10px 0' }}>
              No payment components on this claim.
            </p>
          ) : (
            children.map((child, i) => (
              <SubClaimRow
                key={`${child.claimType}-${child.id}`}
                claim={child}
                session={session}
                activeFY={activeFY}
                isLast={i === children.length - 1}
              />
            ))
          )}

          {/* Edit button in expanded footer */}
          {onEdit && children.length > 0 && (
            <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #1e1e1e' }}>
              <button
                onClick={(e) => { e.stopPropagation(); onEdit(children[0]) }}
                style={{
                  padding: '5px 14px',
                  background: 'transparent',
                  border: '1px solid #374151',
                  borderRadius: '7px',
                  color: '#6b7280',
                  cursor: 'pointer',
                  fontSize: '0.74rem',
                  fontWeight: 600,
                }}
              >
                Edit
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── FlatClaimCard ─────────────────────────────────────────────────────────────
// Flat card for legacy/ungrouped claims (no parent group).
// Preserves existing ClaimList behaviour exactly.

function FlatClaimCard({ claim, onEdit }) {
  const overdue  = isClaimOverdue(claim)
  const adjusted = isAmountAdjusted(claim)
  const amt      = resolveEffectiveAmount(claim)

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      padding: '12px 16px',
      borderRadius: '10px',
      border: overdue ? '1px solid rgba(239,68,68,0.5)' : '1px solid #2a2a2a',
      background: overdue ? 'rgba(251,191,36,0.03)' : '#111',
      marginBottom: '8px',
      gap: '8px',
    }}>
      {/* Left */}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.77rem', color: '#9ca3af', marginBottom: '2px' }}>
          {formatDateDDMMYY(claim.date)}
          {' · '}
          {CLAIM_TYPE_LABELS[claim.claimType] || claim.claimType}
          {overdue && (
            <span style={{ marginLeft: '8px', color: '#f87171', fontWeight: 700 }}>
              🚩 Overdue
            </span>
          )}
        </div>
        <div style={{
          fontSize: '1rem',
          fontWeight: 700,
          color: '#f9fafb',
          fontVariantNumeric: 'tabular-nums',
        }}>
          ${amt.toFixed(2)}
          {adjusted && (
            <span style={{ fontSize: '0.68rem', color: '#fbbf24', marginLeft: '6px', fontWeight: 600 }}>
              Adj
            </span>
          )}
        </div>
        {(claim.payslip_pay_nbr || claim.payment_method) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
            {claim.payslip_pay_nbr && (
              <span style={{ fontSize: '0.69rem', color: '#6b7280' }}>
                Pay #{claim.payslip_pay_nbr}
              </span>
            )}
            <PaymentMethodBadge method={claim.payment_method} />
          </div>
        )}
      </div>

      {/* Right */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: '6px',
        flexShrink: 0,
      }}>
        {/* FlatClaimCard = ungrouped/legacy claims only.
            payment_status badge if set; otherwise status badge (these rows
            predate multi-component architecture and have no payment_status). */}
        {claim.payment_status != null
          ? <PaymentStatusBadge paymentStatus={claim.payment_status} />
          : <StatusBadge status={claim.status} />
        }
        {onEdit && (
          <button
            onClick={() => onEdit(claim)}
            style={{
              padding: '4px 10px',
              background: 'transparent',
              border: '1px solid #374151',
              borderRadius: '6px',
              color: '#9ca3af',
              cursor: 'pointer',
              fontSize: '0.74rem',
              fontWeight: 600,
            }}
          >
            Edit
          </button>
        )}
      </div>
    </div>
  )
}

// ─── ExpandableClaimList ───────────────────────────────────────────────────────
// Main export. Renders All / Pending / Paid / Payslip / Petty Cash tabs.
//
// Props:
//   activeTab           — 'all' | 'pending' | 'paid'
//   filterType          — 'all' | claim type string
//   sortBy              — 'date-desc' | 'date-asc' | 'type'
//   paymentMethodFilter — 'Payslip' | 'Petty Cash' | undefined (all)
//   paymentDateFrom     — 'YYYY-MM-DD' | undefined
//   paymentDateTo       — 'YYYY-MM-DD' | undefined
//   onEdit              — callback(claim) to open EditClaimModal
//   session             — Supabase session (for QuickPayToggle)
//   activeFY            — active financial year object (for QuickPayToggle)

export default function ExpandableClaimList({
  activeTab = 'all',
  filterType = 'all',
  sortBy = 'date-desc',
  paymentMethodFilter,
  paymentDateFrom,
  paymentDateTo,
  onEdit,
  session,
  activeFY,
}) {
  const { groupedView, claims, loading, error } = useClaims()

  // ── Loading / error states ────────────────────────────────────────────────

  if (loading) {
    return (
      <p style={{ color: '#9ca3af', marginTop: '24px', fontSize: '0.9rem' }}>
        Loading claims…
      </p>
    )
  }

  if (error) {
    return (
      <div style={{
        marginTop: '20px',
        background: 'rgba(239,68,68,0.1)',
        border: '1px solid rgba(239,68,68,0.3)',
        color: '#f87171',
        borderRadius: '10px',
        padding: '12px 16px',
        fontSize: '0.875rem',
      }}>
        {error}
      </div>
    )
  }

  if (claims.length === 0) {
    return (
      <p style={{ color: '#9ca3af', marginTop: '24px', fontSize: '0.95rem' }}>
        No claims yet. Use <strong style={{ color: '#e5e7eb' }}>+ New Claim</strong> to add your first one.
      </p>
    )
  }

  // ── Build the displayable grouped + ungrouped lists ───────────────────────

  const { grouped, ungrouped } = groupedView || { grouped: [], ungrouped: [] }

  // ── Build normalized filter spec (Phase 4) ─────────────────────────────────
  // Maps activeTab → paymentStatus filter consumed by filterUtils pipeline.
  // CANONICAL: uses derivedPaymentStatus for grouped, claim.status for ungrouped.

  const paymentStatusFilter = activeTab === 'pending' ? 'pending'
                            : activeTab === 'paid'    ? 'paid'
                            : 'all'

  const filters = {
    paymentStatus:   paymentStatusFilter,
    paymentMethod:   paymentMethodFilter || 'all',
    claimType:       filterType || 'all',
    paymentDateFrom: paymentDateFrom || null,
    paymentDateTo:   paymentDateTo   || null,
    claimDateFrom:   null,
    claimDateTo:     null,
    overdueOnly:     false,
  }

  // Apply centralized filter pipeline
  const visibleGroups    = grouped.filter((g) => groupPassesFilters(g, filters))
  const visibleUngrouped = ungrouped.filter((c) => ungroupedPassesFilters(c, filters))

  // Sort using centralized sort helpers
  const sortedGroups    = sortGroupedEntries(visibleGroups, sortBy)
  const sortedUngrouped = sortUngroupedClaims(visibleUngrouped, sortBy)

  const hasContent = sortedGroups.length > 0 || sortedUngrouped.length > 0

  if (!hasContent) {
    return (
      <p style={{ color: '#9ca3af', marginTop: '24px', fontSize: '0.95rem' }}>
        No claims match the current filters.
      </p>
    )
  }

  // ── Overdue banner count ──────────────────────────────────────────────────
  // NORMALIZED: use derivedPaymentStatus for grouped overdue detection

  const overdueGroupCount = sortedGroups.filter((g) => {
    const lower = (g.derivedPaymentStatus || '').toLowerCase()
    return (lower === 'pending' || lower === 'partially paid') &&
      g.group.overdue_at &&
      new Date() > new Date(g.group.overdue_at)
  }).length

  const overdueUngroupedCount = sortedUngrouped.filter(isClaimOverdue).length
  const totalOverdue = overdueGroupCount + overdueUngroupedCount

  // ── Totals ────────────────────────────────────────────────────────────────

  const groupTotal = sortedGroups.reduce(
    (sum, g) => sum + g.children.reduce((cs, c) => cs + resolveComponentAmount(c), 0),
    0
  )
  const ungroupedTotal = sortedUngrouped.reduce(
    (sum, c) => sum + resolveEffectiveAmount(c),
    0
  )
  const grandTotal = groupTotal + ungroupedTotal
  const itemCount  = sortedGroups.length + sortedUngrouped.length

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ marginTop: '16px' }}>

      {/* Overdue banner */}
      {totalOverdue > 0 && (
        <div style={{
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.3)',
          borderRadius: '8px',
          padding: '8px 14px',
          marginBottom: '14px',
          fontSize: '0.8rem',
          color: '#f87171',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <span style={{ fontSize: '1rem' }}>🚩</span>
          {totalOverdue} pending claim{totalOverdue !== 1 ? 's' : ''} overdue (&gt;4 weeks)
        </div>
      )}

      {/* Grouped expandable rows */}
      {sortedGroups.length > 0 && (
        <div>
          {sortedGroups.map((entry) => (
            <ExpandableGroupRow
              key={entry.group.id}
              groupEntry={entry}
              onEdit={onEdit}
              session={session}
              activeFY={activeFY}
            />
          ))}
        </div>
      )}

      {/* Ungrouped flat cards */}
      {sortedUngrouped.length > 0 && (
        <div style={{ marginTop: sortedGroups.length > 0 ? '16px' : '0' }}>
          {sortedGroups.length > 0 && (
            <div style={{
              fontSize: '0.69rem',
              fontWeight: 700,
              color: '#4b5563',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: '10px',
            }}>
              Other claims
            </div>
          )}
          {sortedUngrouped.map((claim) => (
            <FlatClaimCard
              key={`${claim.claimType}-${claim.id}`}
              claim={claim}
              onEdit={onEdit}
            />
          ))}
        </div>
      )}

      {/* Footer summary */}
      <div style={{
        marginTop: '16px',
        paddingTop: '12px',
        borderTop: '1px solid #1f1f1f',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: '0.78rem',
        color: '#6b7280',
        flexWrap: 'wrap',
        gap: '6px',
      }}>
        <span>{itemCount} claim{itemCount !== 1 ? 's' : ''}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', color: '#9ca3af', fontWeight: 600 }}>
          Total: ${grandTotal.toFixed(2)}
        </span>
      </div>
    </div>
  )
}
