'use client'

// ─── GroupedClaimList ──────────────────────────────────────────────────────────
// Phase 2 — Multi-Component Payment Architecture
// New: PaymentMethodBadge, PaymentStatusBadge, QuickPayToggle per child row.
// Backward compatible: legacy claims (NULL payment_status) render normally.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react'
import { useClaims } from '@/lib/claims/ClaimsContext'
import { CLAIM_TYPE_LABELS } from '@/lib/claims/claimTypes'
import {
  resolveClaimShift,
  resolveClaimPlatoon,
  resolveGroupShift,
  resolveGroupPlatoon,
} from '@/lib/claims/claimMeta'
import {
  resolveEffectiveAmount,
  isClaimOverdue,
} from '@/lib/calculations/engine'
import ShiftPlatoonLine from '@/components/claims/ShiftPlatoonLine'
import MarkPaidPayNumberModal from '@/components/claims/MarkPaidPayNumberModal'
import DeleteConfirmModal from '@/components/claims/DeleteConfirmModal'

// Line 1 of a claim card: "[Claim Type] #[Number]". Falls back to the persisted
// group label (which already embeds the number) when claim number is absent.
function groupHeaderTitle(group) {
  const typeLabel = CLAIM_TYPE_LABELS[group?.claim_type] || group?.claim_type || 'Claim'
  if (group?.claim_number != null) return `${typeLabel} #${group.claim_number}`
  return group?.label || typeLabel
}

function claimHeaderTitle(claim) {
  const typeLabel = CLAIM_TYPE_LABELS[claim?.claimType] || claim?.claimType || 'Claim'
  if (claim?.claim_number != null) return `${typeLabel} #${claim.claim_number}`
  return typeLabel
}

function resolveChildLabel(claim) {
  const ai = claim.calculation_inputs || {}
  if (ai.autoChild === 'callback_ops')             return 'Callback-Ops'
  if (ai.autoChild === 'excess_travel')             return 'Excess Travel'
  if (ai.autoChild === 'petty_cash_meal')           return 'Petty cash meal'
  if (ai.autoChild === 'petty_cash_travel_night')   return 'Small Meal Allowance' // legacy slug
  if (ai.autoChild === 'standby_small_meal')        return 'Small Meal Allowance'
  if (ai.autoChild === 'retain_meal')               return (ai.largeMealCount ?? 0) > 0 ? ((ai.smallMealCount ?? 0) > 0 ? 'Large + Small Meal Allowance' : 'Large Meal Allowance') : 'Small Meal Allowance'
  if (ai.autoChild === 'maint_stn_nn')              return 'Maint stn N/N'
  if (ai.autoChild === 'overnight_cash')            return 'Overnight cash'
  if (ai.autoChild === 'standby_travel')            return 'Excess Travel' // legacy slug
  if (ai.autoChild === 'standby_excess_travel')     return 'Excess Travel'
  if (ai.autoChild === 'standby_and_dismi')         return 'Standby&Dismi'
  if (ai.autoChild === 'md_event')                  return 'M&D'
  return CLAIM_TYPE_LABELS[claim.claimType] || claim.claimType
}

function resolveComponentAmount(claim) {
  if (claim.component_amount != null && !isNaN(Number(claim.component_amount))) {
    return Number(claim.component_amount)
  }
  return resolveEffectiveAmount(claim)
}

// ─── Retain container hiding ───────────────────────────────────────────────────
// Once retain entitlement children exist (Maint Stn N/N, meals), the retain
// parent row is a pure grouping container — its dollars are already zeroed in
// groupedView. Hide it so the card shows only meaningful entitlement rows.
// This is display-only: groupedView (reconciliation, exports, persistence) keeps
// the parent row intact.

function isRetainContainerRow(claim, siblings) {
  if (claim.claimType !== 'retain' || claim.calculation_inputs?.autoChild != null) return false
  return siblings.some((c) => c.claimType === 'retain' && c.calculation_inputs?.autoChild != null)
}

function toDisplayEntry(entry) {
  const visible = entry.children.filter((c) => !isRetainContainerRow(c, entry.children))
  if (visible.length === entry.children.length) return entry
  const totalCount = visible.length
  const paidCount  = visible.filter((c) => (c.payment_status || 'Pending').toLowerCase() === 'paid').length
  const derivedPaymentStatus =
    totalCount > 0 && paidCount === totalCount ? 'Paid'
    : paidCount > 0 ? 'Partially Paid'
    : 'Pending'
  return { ...entry, children: visible, totalCount, paidCount, derivedPaymentStatus }
}

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
    <span style={{ ...style, display: 'inline-block', padding: '2px 8px', borderRadius: '999px', fontSize: '0.69rem', fontWeight: 700, textTransform: 'capitalize', letterSpacing: '0.03em', flexShrink: 0 }}>
      {status || '—'}
    </span>
  )
}

function PaymentStatusBadge({ paymentStatus }) {
  if (paymentStatus == null) return null
  const isPaid = (paymentStatus || '').toLowerCase() === 'paid'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', padding: '2px 7px', borderRadius: '999px', fontSize: '0.67rem', fontWeight: 700, letterSpacing: '0.03em', flexShrink: 0, background: isPaid ? 'rgba(34,197,94,0.18)' : 'rgba(234,179,8,0.12)', border: isPaid ? '1px solid rgba(34,197,94,0.5)' : '1px solid rgba(234,179,8,0.3)', color: isPaid ? '#86efac' : '#fde68a' }}>
      {isPaid ? '✓ Paid' : '○ Pending'}
    </span>
  )
}

function PaymentMethodBadge({ method }) {
  if (!method) return null
  const isPayslip = method === 'Payslip'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', padding: '2px 7px', borderRadius: '5px', fontSize: '0.64rem', fontWeight: 700, letterSpacing: '0.03em', flexShrink: 0, textTransform: 'uppercase', background: isPayslip ? 'rgba(99,102,241,0.15)' : 'rgba(251,146,60,0.15)', border: isPayslip ? '1px solid rgba(99,102,241,0.4)' : '1px solid rgba(251,146,60,0.4)', color: isPayslip ? '#a5b4fc' : '#fdba74' }}>
      {isPayslip ? '📋 Payslip' : '💵 Petty Cash'}
    </span>
  )
}

// QuickPayToggle — inline "Mark Paid" for unpaid subclaims.
// Only visible for unpaid subclaims (null or 'Pending' payment_status).
// Treats null payment_status as Pending — shows button for all new claims.
// Rolls back and shows retry state if Supabase update fails.

function QuickPayToggle({ claim, session, activeFY }) {
  const { updatePaymentStatus } = useClaims()
  const [toggling, setToggling] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [showPayNbrModal, setShowPayNbrModal] = useState(false)

  const isPaid = (claim.payment_status || '').toLowerCase() === 'paid'

  // Only visible for unpaid subclaims
  if (isPaid) return null

  // Payslip-method rows require a Pay Number at mark-as-paid time.
  const needsPayNumber =
    claim.payment_method === 'Payslip' && !claim.payslip_pay_nbr

  const handleClick = async () => {
    if (toggling || !session) return
    if (needsPayNumber) {
      setShowPayNbrModal(true)
      return
    }
    setToggling(true)
    setHasError(false)
    try {
      await updatePaymentStatus({ userId: session.user.id, claim, paymentStatus: 'Paid', financialYearId: activeFY?.id || null })
    } catch (err) {
      console.error('[QuickPayToggle]', err)
      setHasError(true)
    } finally {
      setToggling(false)
    }
  }
  return (
    <>
      <button onClick={handleClick} disabled={toggling} title={needsPayNumber ? 'Mark as Paid (Pay Number required)' : 'Mark as Paid'} style={{ padding: '3px 9px', borderRadius: '6px', border: hasError ? '1px solid rgba(239,68,68,0.5)' : '1px solid rgba(34,197,94,0.4)', background: hasError ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)', color: hasError ? '#f87171' : '#86efac', fontSize: '0.7rem', fontWeight: 700, cursor: toggling ? 'wait' : 'pointer', opacity: toggling ? 0.6 : 1, flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '3px', transition: 'opacity 0.15s', whiteSpace: 'nowrap' }}>
        {toggling ? '…' : hasError ? '✕ Retry' : 'Mark Paid'}
      </button>
      {showPayNbrModal && (
        <MarkPaidPayNumberModal
          claim={claim}
          session={session}
          activeFY={activeFY}
          onClose={() => setShowPayNbrModal(false)}
          onSuccess={() => setShowPayNbrModal(false)}
        />
      )}
    </>
  )
}

// ChildClaimRow — CANONICAL TRUTH: payment_status.
// QuickPayToggle updates payment_status (canonical) per sub-claim.
// cycleStatus updates the legacy status field for backward compat on old rows.
// PaymentStatusBadge is the primary payment indicator (uses payment_status).
// Legacy StatusBadge (status field) preserved as secondary — may be removed
// in a future cleanup once all rows have payment_status set.

function ChildClaimRow({ claim, session, activeFY, isLast }) {
  const { updateChildStatus, deleteSubClaim } = useClaims()
  const [updating, setUpdating] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const label  = resolveChildLabel(claim)
  const amt    = resolveComponentAmount(claim)
  // LEGACY: status field kept for backward compat (old rows without payment_status)
  const status = claim.status || 'Pending'
  const cycleStatus = async () => {
    if (updating || !session) return
    const next = status === 'Pending' ? 'Paid' : status === 'Paid' ? 'Disputed' : 'Pending'
    setUpdating(true)
    try { await updateChildStatus({ userId: session.user.id, claim, status: next, financialYearId: activeFY?.id || null }) }
    finally { setUpdating(false) }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '10px 0', borderBottom: isLast ? 'none' : '1px solid #1e1e1e', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0, flex: 1 }}>
        <span style={{ color: '#374151', fontSize: '0.8rem', flexShrink: 0, marginTop: '2px' }}>{isLast ? '└─' : '├─'}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '0.85rem', color: '#d1d5db', fontWeight: 500 }}>{label}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
            {claim.payslip_pay_nbr && <span style={{ fontSize: '0.7rem', color: '#6b7280' }}>Pay #{claim.payslip_pay_nbr}</span>}
            <PaymentMethodBadge method={claim.payment_method} />
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <span style={{ fontSize: '0.88rem', fontWeight: 700, color: '#f9fafb', fontVariantNumeric: 'tabular-nums' }}>${amt.toFixed(2)}</span>
        {/* CANONICAL: PaymentStatusBadge from payment_status. Normalize NULL → Pending. */}
        <PaymentStatusBadge paymentStatus={claim.payment_status || 'Pending'} />
        <QuickPayToggle claim={claim} session={session} activeFY={activeFY} />
        {/* LEGACY compat: clickable status badge for old rows — secondary display only */}
        <button onClick={cycleStatus} disabled={updating} title="Legacy status (secondary)" style={{ background: 'none', border: 'none', padding: 0, cursor: updating ? 'wait' : 'pointer', opacity: updating ? 0.5 : 1 }}>
          <StatusBadge status={status} />
        </button>
        <button onClick={() => setShowDelete(true)} title="Delete this sub-claim" aria-label="Delete sub-claim" style={{ padding: '3px 7px', borderRadius: '6px', border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.08)', color: '#f87171', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}>
          🗑
        </button>
      </div>
      {showDelete && (
        <DeleteConfirmModal
          title="Delete sub-claim"
          message={`Permanently delete the “${label}” entitlement ($${amt.toFixed(2)})? The rest of this claim and its other entitlements will be kept.`}
          confirmLabel="Delete sub-claim"
          onClose={() => setShowDelete(false)}
          onConfirm={async () => {
            await deleteSubClaim({ userId: session.user.id, claim, financialYearId: activeFY?.id || null })
            setShowDelete(false)
          }}
        />
      )}
    </div>
  )
}

// GroupCard — CANONICAL TRUTH: derivedPaymentStatus, paidCount, totalCount.
// All payment display and totals derive from payment_status only — no status fallback.

function GroupCard({ groupEntry, session, activeFY }) {
  const { deleteClaimGroup } = useClaims()
  // Destructure normalized fields from groupedView (computed in ClaimsContext)
  const { group, children, derivedPaymentStatus, paidCount, totalCount } = groupEntry
  const [collapsed, setCollapsed] = useState(false)
  const [showDelete, setShowDelete] = useState(false)

  // NORMALIZED: pending or partially-paid groups can be overdue
  const isOverdue = (() => {
    const lower = (derivedPaymentStatus || '').toLowerCase()
    if (lower !== 'pending' && lower !== 'partially paid') return false
    if (!group.overdue_at) return false
    return new Date() > new Date(group.overdue_at)
  })()

  const totalAmt = children.reduce((sum, c) => sum + resolveComponentAmount(c), 0)

  // CANONICAL: paid amount from payment_status only
  const paidAmt = children
    .filter((c) => (c.payment_status || 'Pending').toLowerCase() === 'paid')
    .reduce((sum, c) => sum + resolveComponentAmount(c), 0)

  // CANONICAL: pending count from paidCount + totalCount (from ClaimsContext)
  const pendingCount = totalCount - paidCount

  // Payment badge always derived from derivedPaymentStatus (canonical truth)
  const paymentBadge = (() => {
    if (totalCount === 0) return null
    if (derivedPaymentStatus === 'Paid')           return { text: '✓ All Paid',                    color: '#86efac', bg: 'rgba(34,197,94,0.12)',    border: 'rgba(34,197,94,0.4)'    }
    if (derivedPaymentStatus === 'Partially Paid') return { text: `${paidCount}/${totalCount} Paid`, color: '#a5b4fc', bg: 'rgba(99,102,241,0.1)',   border: 'rgba(99,102,241,0.35)'  }
    return { text: `0/${totalCount} Paid`, color: '#fde68a', bg: 'rgba(234,179,8,0.08)', border: 'rgba(234,179,8,0.25)' }
  })()
  return (
    <div style={{ borderRadius: '12px', border: isOverdue ? '1.5px solid rgba(239,68,68,0.5)' : '1px solid #2a2a2a', background: isOverdue ? 'rgba(251,191,36,0.03)' : '#111', marginBottom: '12px', overflow: 'hidden' }}>
      <div onClick={() => setCollapsed((v) => !v)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', cursor: 'pointer', borderBottom: collapsed ? 'none' : '1px solid #1e1e1e', gap: '8px', background: '#161616' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <span style={{ color: '#4b5563', fontSize: '0.7rem', flexShrink: 0 }}>{collapsed ? '▶' : '▼'}</span>
          <div style={{ minWidth: 0 }}>
            {/* Line 1 — "[Claim Type] #[Number]" */}
            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f9fafb', marginBottom: '3px' }}>{groupHeaderTitle(group)}</div>
            {/* Line 2 — "[Shift] · Platoon [X] · [Date]" */}
            <ShiftPlatoonLine
              shift={resolveGroupShift(groupEntry)}
              platoon={resolveGroupPlatoon(groupEntry)}
              date={group.incident_date}
              style={{ marginBottom: '2px' }}
            />
            {/* Line 3 — existing summary metadata */}
            <div style={{ fontSize: '0.72rem', color: '#6b7280', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <span>{children.length} item{children.length !== 1 ? 's' : ''}</span>
              <span>·</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>Total: <strong style={{ color: '#f9fafb' }}>${totalAmt.toFixed(2)}</strong></span>
              {paidAmt > 0 && paidAmt < totalAmt && <span style={{ color: '#4ade80', fontVariantNumeric: 'tabular-nums' }}>· Paid: ${paidAmt.toFixed(2)}</span>}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {isOverdue && <span style={{ fontSize: '0.64rem', fontWeight: 700, color: '#f87171', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: '4px', padding: '2px 6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>🚩 Overdue</span>}
          {paymentBadge && <span style={{ fontSize: '0.65rem', fontWeight: 700, color: paymentBadge.color, background: paymentBadge.bg, border: '1px solid ' + paymentBadge.border, borderRadius: '5px', padding: '2px 7px', letterSpacing: '0.03em' }}>{paymentBadge.text}</span>}
          {/* CANONICAL: show derivedPaymentStatus badge, not DB parent_status */}
          <StatusBadge status={derivedPaymentStatus} />
        </div>
      </div>
      {!collapsed && children.length > 0 && (
        <div style={{ padding: '2px 16px 12px 16px', background: '#0f0f0f' }}>
          {children.map((child, i) => (
            <ChildClaimRow key={child.claimType + '-' + child.id} claim={child} session={session} activeFY={activeFY} isLast={i === children.length - 1} />
          ))}
        </div>
      )}
      {!collapsed && children.length === 0 && (
        <div style={{ padding: '12px 16px', fontSize: '0.8rem', color: '#4b5563', background: '#0f0f0f' }}>No payment components yet.</div>
      )}
      {!collapsed && (
        <div style={{ padding: '10px 16px 12px', background: '#0f0f0f', borderTop: '1px solid #1e1e1e' }}>
          <button onClick={(e) => { e.stopPropagation(); setShowDelete(true) }} style={{ padding: '5px 14px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: '7px', color: '#f87171', cursor: 'pointer', fontSize: '0.74rem', fontWeight: 600 }}>
            Delete Claim
          </button>
        </div>
      )}
      {showDelete && (
        <DeleteConfirmModal
          title="Delete Claim"
          message={`Permanently delete “${group.label}” and all ${children.length} sub-claim${children.length !== 1 ? 's' : ''}? This removes the claim, every generated entitlement and any linked payment records. This cannot be undone.`}
          confirmLabel="Delete Claim"
          onClose={() => setShowDelete(false)}
          onConfirm={async () => {
            await deleteClaimGroup({ userId: session.user.id, group, financialYearId: activeFY?.id || null })
            setShowDelete(false)
          }}
        />
      )}
    </div>
  )
}

function UngroupedCard({ claim, onEdit, session, activeFY }) {
  const { deleteSubClaim } = useClaims()
  const [showDelete, setShowDelete] = useState(false)
  const overdue = isClaimOverdue(claim)
  const amt     = resolveComponentAmount(claim)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '12px 16px', borderRadius: '10px', border: overdue ? '1px solid rgba(239,68,68,0.5)' : '1px solid #2a2a2a', background: overdue ? 'rgba(251,191,36,0.03)' : '#111', marginBottom: '8px', gap: '8px' }}>
      <div style={{ minWidth: 0 }}>
        {/* Line 1 — "[Claim Type] #[Number]" */}
        <div style={{ fontSize: '0.84rem', fontWeight: 700, color: '#f9fafb', marginBottom: '2px' }}>
          {claimHeaderTitle(claim)}
          {overdue && <span style={{ marginLeft: '8px', color: '#f87171', fontWeight: 700, fontSize: '0.72rem' }}>🚩 Overdue</span>}
        </div>
        {/* Line 2 — "[Shift] · Platoon [X] · [Date]" */}
        <ShiftPlatoonLine
          shift={resolveClaimShift(claim)}
          platoon={resolveClaimPlatoon(claim)}
          date={claim.date}
          style={{ marginBottom: '3px' }}
        />
        {/* Line 3 — amount */}
        <div style={{ fontSize: '1rem', fontWeight: 700, color: '#f9fafb', fontVariantNumeric: 'tabular-nums' }}>${amt.toFixed(2)}</div>
        {(claim.payslip_pay_nbr || claim.payment_method) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
            {claim.payslip_pay_nbr && <span style={{ fontSize: '0.7rem', color: '#6b7280' }}>Pay #{claim.payslip_pay_nbr}</span>}
            <PaymentMethodBadge method={claim.payment_method} />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', flexShrink: 0 }}>
        {claim.payment_status != null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <PaymentStatusBadge paymentStatus={claim.payment_status} />
            <QuickPayToggle claim={claim} session={session} activeFY={activeFY} />
          </div>
        )}
        <StatusBadge status={claim.status} />
        <div style={{ display: 'flex', gap: '6px' }}>
          {onEdit && (
            <button onClick={() => onEdit(claim)} style={{ padding: '3px 10px', background: 'transparent', border: '1px solid #374151', borderRadius: '6px', color: '#9ca3af', cursor: 'pointer', fontSize: '0.74rem', fontWeight: 600 }}>
              Edit
            </button>
          )}
          <button onClick={() => setShowDelete(true)} style={{ padding: '3px 10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: '6px', color: '#f87171', cursor: 'pointer', fontSize: '0.74rem', fontWeight: 600 }}>
            Delete
          </button>
        </div>
      </div>
      {showDelete && (
        <DeleteConfirmModal
          title="Delete Claim"
          message={`Permanently delete this ${CLAIM_TYPE_LABELS[claim.claimType] || claim.claimType} claim ($${amt.toFixed(2)})? This cannot be undone.`}
          confirmLabel="Delete Claim"
          onClose={() => setShowDelete(false)}
          onConfirm={async () => {
            await deleteSubClaim({ userId: session.user.id, claim, financialYearId: activeFY?.id || null })
            setShowDelete(false)
          }}
        />
      )}
    </div>
  )
}

export default function GroupedClaimList({ session, activeFY, onEdit }) {
  const { groupedView, loading, error } = useClaims()

  if (loading) return <p style={{ color: '#9ca3af', marginTop: '24px', fontSize: '0.9rem' }}>Loading claims…</p>

  if (error) return (
    <div style={{ marginTop: '20px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', borderRadius: '10px', padding: '12px 16px', fontSize: '0.875rem' }}>
      {error}
    </div>
  )

  const { grouped: rawGrouped, ungrouped } = groupedView || { grouped: [], ungrouped: [] }

  // Hide the retain grouping-container row from each group's display rows.
  const grouped = rawGrouped.map(toDisplayEntry)

  // NORMALIZED: filter by derivedPaymentStatus (canonical), not group.parent_status
  const pendingGroups = grouped.filter((g) => (g.derivedPaymentStatus || '').toLowerCase() !== 'paid')
  const paidGroups    = grouped.filter((g) => (g.derivedPaymentStatus || '').toLowerCase() === 'paid')

  // NORMALIZED: overdue detection — pending or partially-paid groups can be overdue
  const overdueCount = pendingGroups.filter((g) => {
    const lower = (g.derivedPaymentStatus || '').toLowerCase()
    return (lower === 'pending' || lower === 'partially paid') &&
      g.group.overdue_at &&
      new Date() > new Date(g.group.overdue_at)
  }).length

  const hasContent    = pendingGroups.length > 0 || ungrouped.length > 0

  return (
    <div style={{ marginTop: '20px' }}>
      {overdueCount > 0 && (
        <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', padding: '8px 14px', marginBottom: '14px', fontSize: '0.8rem', color: '#f87171', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '1rem' }}>🚩</span>
          {overdueCount} claim group{overdueCount !== 1 ? 's' : ''} overdue ({'>'} 4 weeks)
        </div>
      )}

      {!hasContent && (
        <p style={{ color: '#9ca3af', marginTop: '24px', fontSize: '0.95rem' }}>
          No pending payslip claims. New claims will appear here grouped by parent event.
        </p>
      )}

      {pendingGroups.length > 0 && (
        <div>
          <div style={{ fontSize: '0.71rem', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>
            Pending ({pendingGroups.length})
          </div>
          {pendingGroups.map((entry) => (
            <GroupCard key={entry.group.id} groupEntry={entry} session={session} activeFY={activeFY} />
          ))}
        </div>
      )}

      {ungrouped.length > 0 && (
        <div style={{ marginTop: pendingGroups.length > 0 ? '20px' : '0' }}>
          <div style={{ fontSize: '0.71rem', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>
            Other Claims ({ungrouped.length})
          </div>
          {ungrouped.map((claim) => (
            <UngroupedCard key={claim.claimType + '-' + claim.id} claim={claim} onEdit={onEdit} session={session} activeFY={activeFY} />
          ))}
        </div>
      )}

      {paidGroups.length > 0 && (
        <div style={{ marginTop: '20px' }}>
          <div style={{ fontSize: '0.71rem', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>
            Paid ({paidGroups.length})
          </div>
          {paidGroups.map((entry) => (
            <GroupCard key={entry.group.id} groupEntry={entry} session={session} activeFY={activeFY} />
          ))}
        </div>
      )}
    </div>
  )
}
