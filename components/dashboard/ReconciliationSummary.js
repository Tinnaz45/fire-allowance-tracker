'use client'

// ─── ReconciliationSummary ────────────────────────────────────────────────────
// Compact reconciliation header for the dashboard.
//
// CANONICAL TRUTH: figures derive from sub-claim payment_status,
// payment_method, and component_amount via calcNormalizedSummary().
// Parent-level status is NEVER used as an authoritative source.
//
// DISPLAYS (intentionally minimal — keeps the dashboard short on mobile):
//   - Outstanding total (pending)
//   - Paid total
//
// The full per-method / per-type breakdown and CSV exports live on the
// Payments surface; this widget is a quick-glance summary only.
// ─────────────────────────────────────────────────────────────────────────────

import { useClaims } from '@/lib/claims/ClaimsContext'
import { useFY } from '@/lib/fy/FinancialYearContext'
import { calcNormalizedSummary } from '@/lib/reconciliation/reconciliationUtils'

// ─── Compact Stat ─────────────────────────────────────────────────────────────
// Label stacked over value — sits inline in a single summary row.

function CompactStat({ label, value, accent, muted = false }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, opacity: muted ? 0.6 : 1 }}>
      <span style={{
        fontSize: '0.68rem',
        fontWeight: 700,
        color: '#6b7280',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}>
        {label}
      </span>
      <span style={{
        fontSize: '1.2rem',
        fontWeight: 800,
        color: accent,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.01em',
      }}>
        {value}
      </span>
    </div>
  )
}

// ─── ReconciliationSummary ────────────────────────────────────────────────────

export default function ReconciliationSummary() {
  const { groupedView, loading } = useClaims()
  const { activeFY } = useFY()

  if (loading || !groupedView) return null

  const { grouped = [], ungrouped = [] } = groupedView
  const hasData = grouped.length > 0 || ungrouped.length > 0
  if (!hasData) return null

  // CANONICAL: all figures from normalized sub-claim aggregation
  const summary = calcNormalizedSummary(groupedView)
  const fyLabel = activeFY?.label || ''

  // When nothing has been paid yet, de-emphasise the Paid figure so the eye
  // lands on Outstanding. The value stays visible (not hidden) — just muted.
  const paidIsZero = summary.paidTotal === 0

  return (
    <div style={{
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: '16px',
      padding: '12px 14px',
      marginBottom: '16px',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        flexWrap: 'wrap',
      }}>
        <h2 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: '#f9fafb' }}>
          Financial Snapshot
          {fyLabel && (
            <span style={{ color: '#6b7280', fontWeight: 600 }}> · {fyLabel}</span>
          )}
        </h2>

        {/* Compact summary row — Outstanding + Paid only */}
        <div style={{ display: 'flex', gap: '28px', flexShrink: 0 }}>
          <CompactStat
            label="Outstanding"
            value={`$${summary.pendingTotal.toFixed(2)}`}
            accent="#fde68a"
          />
          <CompactStat
            label="Paid"
            value={`$${summary.paidTotal.toFixed(2)}`}
            accent={paidIsZero ? '#4b5563' : '#4ade80'}
            muted={paidIsZero}
          />
        </div>
      </div>
    </div>
  )
}
