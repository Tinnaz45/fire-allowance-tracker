'use client'

// ─── PaymentProgressBadge ──────────────────────────────────────────────────────
// Single, unambiguous payment-progress indicator for a claim or claim group.
//
// Replaces the old two-element combination (a "0/2 paid" pill + a separate
// "Pending" status badge) which forced the reader to mentally combine two chips.
// One badge now states both the status word AND the progress count:
//
//   Outstanding      (0 of 2 paid)   — amber   · nothing paid yet
//   Partially Paid   (1 of 2 paid)   — indigo  · some paid
//   Paid             (2 of 2 paid)   — green   · all paid
//
// A leading status dot gives an at-a-glance colour cue; the count is rendered in
// a muted tone so the status word stays dominant. For single-component claims
// (total ≤ 1) the redundant "(1 of 1 paid)" count is dropped — just "Paid" /
// "Outstanding" — so the same component reads cleanly for both groups and flat cards.
//
// CANONICAL TRUTH: derives purely from paidCount / totalCount, which both list
// views compute from payment_status only (see ClaimsContext groupedView). This
// component is presentation-only and never changes amounts or payment state.
// ─────────────────────────────────────────────────────────────────────────────

const THEME = {
  paid:    { label: 'Paid',           bg: 'rgba(34,197,94,0.15)',  border: 'rgba(34,197,94,0.45)', color: '#86efac', dot: '#22c55e' },
  partial: { label: 'Partially Paid', bg: 'rgba(99,102,241,0.15)', border: 'rgba(99,102,241,0.45)', color: '#a5b4fc', dot: '#818cf8' },
  pending: { label: 'Outstanding',    bg: 'rgba(234,179,8,0.13)',  border: 'rgba(234,179,8,0.4)',  color: '#fde68a', dot: '#eab308' },
}

/**
 * @param {object} props
 * @param {number} props.paidCount  — number of paid components
 * @param {number} props.totalCount — number of components
 */
export default function PaymentProgressBadge({ paidCount = 0, totalCount = 0 }) {
  if (totalCount <= 0) return null

  const allPaid = paidCount >= totalCount
  const partial = paidCount > 0 && paidCount < totalCount
  const theme   = allPaid ? THEME.paid : partial ? THEME.partial : THEME.pending

  // Drop the redundant count for single-component claims.
  const showCount = totalCount > 1

  return (
    <span
      title={`${paidCount} of ${totalCount} paid`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '3px 10px',
        borderRadius: '999px',
        fontSize: '0.7rem',
        fontWeight: 700,
        letterSpacing: '0.02em',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '7px',
          height: '7px',
          borderRadius: '999px',
          background: theme.dot,
          flexShrink: 0,
        }}
      />
      {theme.label}
      {showCount && (
        <span style={{ fontWeight: 600, opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>
          ({paidCount} of {totalCount} paid)
        </span>
      )}
    </span>
  )
}
