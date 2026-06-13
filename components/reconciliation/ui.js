// ─── Reconciliation UI primitives ─────────────────────────────────────────────
// Shared presentational helpers for the Payment Records (Phase 3) operator
// surface. Pure rendering + formatting only — no Supabase, no service calls.
// The vocabulary here (status labels/colours, entitlement-type labels) mirrors
// lib/fat/models/reconciliationConstants.js so the UI never disagrees with the
// canonical predicate (reconciliationHelpers.evaluateDerivedStatus).
//
// Visual language matches the rest of the app: dark surface (#0f0f0f), card
// (#1a1a1a / #2a2a2a), red accent (#dc2626). See app/settings/page.js.
// ─────────────────────────────────────────────────────────────────────────────

import {
  DERIVED_STATUS,
  PAYMENT_STATUS,
  PAYMENT_STREAMS,
} from '@/lib/fat/models/reconciliationConstants'

// ─── Formatting ───────────────────────────────────────────────────────────────

/** `$1,234.50` — tolerant of string-typed numerics from PostgREST. */
export function fmtMoney(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return `$${v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** `2.50 h` for hours-first rows. */
export function fmtHours(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return `${v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} h`
}

/** Effective payable dollar amount = COALESCE(edited_amount, generated_amount). */
export function effectiveAmount(e) {
  return e?.edited_amount ?? e?.generated_amount ?? null
}

/** Effective hours = COALESCE(edited_hours, generated_hours). */
export function effectiveHours(e) {
  return e?.edited_hours ?? e?.generated_hours ?? null
}

/** Human label for the entitlement's headline quantity (hours-first vs dollars-first). */
export function entitlementValueLabel(e) {
  if (e?.unit === 'hours') {
    const h = effectiveHours(e)
    return h == null ? '—' : fmtHours(h)
  }
  if (e?.unit === 'dollars') {
    const a = effectiveAmount(e)
    return a == null ? '—' : fmtMoney(a)
  }
  return '—'
}

/** Short ISO date `2026-06-18` → `18 Jun 2026`. Safe on null. */
export function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Full timestamp for audit rows. */
export function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// ─── Vocabulary maps ──────────────────────────────────────────────────────────

export const ENTITLEMENT_TYPE_LABELS = Object.freeze({
  excess_travel_standby: 'Excess Travel (Standby)',
  excess_travel_md: 'Excess Travel (M&D)',
  standby_dismi: 'Standby Dismissal',
  muster_dismis: 'Muster & Dismiss',
  small_meal: 'Small Meal',
  large_meal: 'Large Meal',
})

export function entitlementTypeLabel(type) {
  if (!type) return 'Entitlement'
  return ENTITLEMENT_TYPE_LABELS[type]
    ?? String(type).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export const STREAM_LABELS = Object.freeze({
  [PAYMENT_STREAMS.PAYSLIP]: '📋 Payslip',
  [PAYMENT_STREAMS.PETTY_CASH]: '💵 Petty Cash',
})

export const LINK_KIND_LABELS = Object.freeze({
  auto_match: 'Auto-match',
  manual: 'Manual link',
  discrepancy_note: 'Discrepancy note',
})

export const ACTION_LABELS = Object.freeze({
  set_payment_method: 'Routed',
  route_change: 'Re-routed',
  link_payment: 'Payment linked',
  unlink_payment: 'Payment unlinked',
  mark_paid: 'Marked paid',
  mark_claimed: 'Marked claimed',
  regress_status: 'Status regressed',
  note_discrepancy: 'Discrepancy noted',
})

export function actionLabel(action) {
  return ACTION_LABELS[action] ?? action ?? '—'
}

// ─── Status badge metadata ────────────────────────────────────────────────────
// Keyed by both the DERIVED (six-value) display vocabulary and the STORED
// (four-value) column values, so a badge renders correctly whether it is fed a
// derived status (drawer) or a stored status (queue row).

const AMBER = { color: '#fde68a', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.3)' }
const BLUE = { color: '#93c5fd', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.3)' }
const GREEN = { color: '#4ade80', bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.3)' }
const GREY = { color: '#9ca3af', bg: 'rgba(156,163,175,0.1)', border: 'rgba(156,163,175,0.25)' }

export const STATUS_META = Object.freeze({
  // Derived (six-value)
  [DERIVED_STATUS.PENDING]: { label: 'Pending', ...AMBER },
  [DERIVED_STATUS.PARTIALLY_PAID]: { label: 'Partially paid', ...BLUE },
  [DERIVED_STATUS.PAID]: { label: 'Paid', ...GREEN },
  [DERIVED_STATUS.OUTSTANDING]: { label: 'Outstanding', ...AMBER },
  [DERIVED_STATUS.PARTIALLY_REIMBURSED]: { label: 'Partially reimbursed', ...BLUE },
  [DERIVED_STATUS.REIMBURSED]: { label: 'Reimbursed', ...GREEN },
  // Stored-only value that has no distinct derived label
  [PAYMENT_STATUS.CLAIMED]: { label: 'Reimbursed', ...GREEN },
})

export function statusMeta(status) {
  return STATUS_META[status] ?? { label: status ?? 'Unrouted', ...GREY }
}

// ─── Shared style tokens ──────────────────────────────────────────────────────

export const CARD_STYLE = {
  background: '#1a1a1a',
  border: '1px solid #2a2a2a',
  borderRadius: '16px',
  padding: '20px 22px',
}

export const INPUT_STYLE = {
  width: '100%',
  padding: '10px 12px',
  background: '#111',
  border: '1px solid #333',
  borderRadius: '8px',
  color: '#e5e7eb',
  fontSize: '0.9rem',
  outline: 'none',
  boxSizing: 'border-box',
}

export const LABEL_STYLE = {
  display: 'block',
  fontSize: '0.74rem',
  fontWeight: 600,
  color: '#9ca3af',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '6px',
}

export const PRIMARY_BTN = {
  padding: '10px 16px',
  background: '#dc2626',
  border: 'none',
  borderRadius: '8px',
  color: 'white',
  fontSize: '0.88rem',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'background 0.15s',
}

export const GHOST_BTN = {
  padding: '8px 14px',
  background: 'transparent',
  border: '1px solid #333',
  borderRadius: '8px',
  color: '#9ca3af',
  fontSize: '0.85rem',
  fontWeight: 600,
  cursor: 'pointer',
}

export function disabledBtn(base) {
  return { ...base, background: base.background === '#dc2626' ? '#7f1d1d' : base.background, opacity: 0.6, cursor: 'not-allowed' }
}

// ─── Presentational components ────────────────────────────────────────────────

export function StatusBadge({ status, small = false }) {
  const m = statusMeta(status)
  return (
    <span style={{
      display: 'inline-block',
      padding: small ? '2px 8px' : '3px 10px',
      borderRadius: '999px',
      fontSize: small ? '0.66rem' : '0.72rem',
      fontWeight: 700,
      letterSpacing: '0.02em',
      color: m.color,
      background: m.bg,
      border: `1px solid ${m.border}`,
      whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  )
}

export function Pill({ children, tone = 'grey' }) {
  const tones = { grey: GREY, blue: BLUE, green: GREEN, amber: AMBER }
  const t = tones[tone] ?? GREY
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '6px',
      fontSize: '0.68rem', fontWeight: 600, color: t.color,
      background: t.bg, border: `1px solid ${t.border}`, whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  )
}

export function Banner({ tone = 'info', children }) {
  const tones = {
    info: { color: '#93c5fd', bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.2)' },
    error: { color: '#f87171', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)' },
    success: { color: '#4ade80', bg: 'rgba(34,197,94,0.1)', border: 'rgba(34,197,94,0.3)' },
  }
  const t = tones[tone] ?? tones.info
  return (
    <div style={{
      background: t.bg, border: `1px solid ${t.border}`, color: t.color,
      borderRadius: '10px', padding: '12px 16px', fontSize: '0.82rem', lineHeight: 1.5,
    }}>
      {children}
    </div>
  )
}

export function EmptyState({ children }) {
  return (
    <div style={{
      padding: '20px', textAlign: 'center', color: '#6b7280',
      fontSize: '0.85rem', border: '1px dashed #2a2a2a', borderRadius: '10px',
    }}>
      {children}
    </div>
  )
}

export function SectionHeading({ title, subtitle, right }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: '12px', flexWrap: 'wrap', marginBottom: '16px',
    }}>
      <div>
        <h2 style={{ margin: '0 0 2px 0', fontSize: '1rem', fontWeight: 700, color: '#f9fafb' }}>
          {title}
        </h2>
        {subtitle && (
          <p style={{ margin: 0, fontSize: '0.78rem', color: '#6b7280' }}>{subtitle}</p>
        )}
      </div>
      {right}
    </div>
  )
}
