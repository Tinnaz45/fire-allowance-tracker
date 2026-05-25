'use client'

// ─── ReconciliationSummary ────────────────────────────────────────────────────
// Phase 4 — Normalized reconciliation summary widget.
//
// CANONICAL TRUTH: all figures derive from sub-claim payment_status,
// payment_method, and component_amount via calcNormalizedSummary().
// Parent-level status is NEVER used as an authoritative source.
//
// DISPLAYS:
//   - Outstanding total (pending)
//   - Paid total
//   - Grand total
//   - Payslip breakdown (pending / paid)
//   - Petty cash breakdown (pending / paid)
//   - Quick-access export buttons (CSV downloads)
//
// PRESERVES:
//   - Existing dashboard layout (rendered above Recent Activity)
//   - Mobile responsive
//   - No hydration warnings (no dynamic server/client mismatch)
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react'
import { useClaims } from '@/lib/claims/ClaimsContext'
import { useFY } from '@/lib/fy/FinancialYearContext'
import { calcNormalizedSummary } from '@/lib/reconciliation/reconciliationUtils'
import {
  downloadReconciliationCSV,
  downloadPayslipCSV,
  downloadPettyCashCSV,
  downloadOutstandingCSV,
  downloadFinancialSummaryCSV,
  buildClipboardSummary,
} from '@/lib/reconciliation/exportUtils'

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent = '#6b7280', small = false }) {
  return (
    <div style={{
      flex: '1 1 140px',
      minWidth: 0,
      background: '#111',
      border: `1px solid #2a2a2a`,
      borderRadius: '10px',
      padding: small ? '10px 14px' : '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
    }}>
      <div style={{
        fontSize: '0.7rem',
        fontWeight: 700,
        color: '#6b7280',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: small ? '1rem' : '1.3rem',
        fontWeight: 800,
        color: accent,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.01em',
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '0.7rem', color: '#4b5563' }}>{sub}</div>
      )}
    </div>
  )
}

// ─── Method Row ───────────────────────────────────────────────────────────────

function MethodRow({ label, total, paid, pending, accentColor, borderColor }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 14px',
      borderRadius: '8px',
      border: `1px solid ${borderColor}`,
      background: 'rgba(0,0,0,0.2)',
      gap: '8px',
      flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{
          fontSize: '0.72rem',
          fontWeight: 700,
          color: accentColor,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}>
          {label}
        </span>
        <span style={{
          fontSize: '1rem',
          fontWeight: 800,
          color: '#e5e7eb',
          fontVariantNumeric: 'tabular-nums',
        }}>
          ${total.toFixed(2)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: '10px', flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.72rem', color: '#4ade80', fontVariantNumeric: 'tabular-nums' }}>
          ✓ ${paid.toFixed(2)} paid
        </span>
        <span style={{ fontSize: '0.72rem', color: '#fde68a', fontVariantNumeric: 'tabular-nums' }}>
          ○ ${pending.toFixed(2)} pending
        </span>
      </div>
    </div>
  )
}

// ─── Export Button ────────────────────────────────────────────────────────────

function ExportBtn({ label, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '6px 12px',
        background: 'transparent',
        border: '1px solid #333',
        borderRadius: '7px',
        color: disabled ? '#374151' : '#9ca3af',
        fontSize: '0.76rem',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'border-color 0.15s, color 0.15s',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

// ─── ReconciliationSummary ────────────────────────────────────────────────────

export default function ReconciliationSummary() {
  const { groupedView, loading } = useClaims()
  const { activeFY } = useFY()

  const [copied, setCopied]     = useState(false)
  const [expanded, setExpanded] = useState(false)

  if (loading || !groupedView) return null

  const { grouped = [], ungrouped = [] } = groupedView
  const hasData = grouped.length > 0 || ungrouped.length > 0
  if (!hasData) return null

  // CANONICAL: all figures from normalized sub-claim aggregation
  const summary = calcNormalizedSummary(groupedView)
  const fyLabel = activeFY?.label || ''

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildClipboardSummary(groupedView, fyLabel))
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch (err) {
      console.error('[ReconciliationSummary] Copy failed:', err)
    }
  }

  const hasPayslip    = summary.payslipTotal > 0
  const hasPettyCash  = summary.pettyCashTotal > 0
  const hasAnyMethod  = hasPayslip || hasPettyCash

  return (
    <div style={{
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: '16px',
      padding: '20px 24px',
      marginBottom: '20px',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '16px',
        flexWrap: 'wrap',
        gap: '8px',
      }}>
        <div>
          <h2 style={{ margin: '0 0 2px 0', fontSize: '1rem', fontWeight: 700, color: '#f9fafb' }}>
            Reconciliation Summary
          </h2>
          <p style={{ margin: 0, fontSize: '0.78rem', color: '#6b7280' }}>
            {fyLabel ? `${fyLabel} · ` : ''}All figures from sub-claim payment records
          </p>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            padding: '4px 10px',
            background: 'transparent',
            border: '1px solid #333',
            borderRadius: '7px',
            color: '#6b7280',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Hide ▲' : 'Details ▼'}
        </button>
      </div>

      {/* Main stat row */}
      <div style={{
        display: 'flex',
        gap: '10px',
        flexWrap: 'wrap',
        marginBottom: hasAnyMethod || expanded ? '14px' : '0',
      }}>
        <StatCard
          label="Outstanding"
          value={`$${summary.pendingTotal.toFixed(2)}`}
          sub={`${summary.pendingGroupCount} group${summary.pendingGroupCount !== 1 ? 's' : ''} pending`}
          accent="#fde68a"
        />
        <StatCard
          label="Paid"
          value={`$${summary.paidTotal.toFixed(2)}`}
          sub={`${summary.paidGroupCount} group${summary.paidGroupCount !== 1 ? 's' : ''} paid`}
          accent="#4ade80"
        />
        <StatCard
          label="Total"
          value={`$${summary.grandTotal.toFixed(2)}`}
          sub={`${summary.groupCount} group${summary.groupCount !== 1 ? 's' : ''}`}
          accent="#e5e7eb"
        />
      </div>

      {/* Payment method rows */}
      {hasAnyMethod && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
          {hasPayslip && (
            <MethodRow
              label="📋 Payslip"
              total={summary.payslipTotal}
              paid={summary.payslipPaidTotal}
              pending={summary.payslipPendingTotal}
              accentColor="#a5b4fc"
              borderColor="rgba(99,102,241,0.2)"
            />
          )}
          {hasPettyCash && (
            <MethodRow
              label="💵 Petty Cash"
              total={summary.pettyCashTotal}
              paid={summary.pettyCashPaidTotal}
              pending={summary.pettyCashPendingTotal}
              accentColor="#fdba74"
              borderColor="rgba(251,146,60,0.2)"
            />
          )}
        </div>
      )}

      {/* Expanded: per-type breakdown */}
      {expanded && Object.keys(summary.byClaimType).length > 0 && (
        <div style={{
          background: '#111',
          border: '1px solid #222',
          borderRadius: '8px',
          padding: '12px 14px',
          marginBottom: '14px',
        }}>
          <div style={{
            fontSize: '0.68rem',
            fontWeight: 700,
            color: '#4b5563',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: '8px',
          }}>
            By Claim Type
          </div>
          {Object.entries(summary.byClaimType).map(([type, amt]) => (
            <div key={type} style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '5px 0',
              borderBottom: '1px solid #1a1a1a',
              fontSize: '0.82rem',
            }}>
              <span style={{ color: '#9ca3af' }}>{CLAIM_TYPE_LABELS[type] || type}</span>
              <span style={{ color: '#e5e7eb', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                ${amt.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Export buttons */}
      <div style={{
        display: 'flex',
        gap: '8px',
        flexWrap: 'wrap',
        borderTop: '1px solid #222',
        paddingTop: '12px',
        marginTop: '4px',
      }}>
        <ExportBtn
          label={copied ? '✓ Copied!' : '📋 Copy'}
          onClick={handleCopy}
        />
        <ExportBtn
          label="⬇ Reconciliation"
          onClick={() => downloadReconciliationCSV(groupedView, fyLabel)}
        />
        <ExportBtn
          label="⬇ Outstanding"
          onClick={() => downloadOutstandingCSV(groupedView, fyLabel)}
          disabled={summary.pendingTotal === 0}
        />
        {hasPayslip && (
          <ExportBtn
            label="⬇ Payslip"
            onClick={() => downloadPayslipCSV(groupedView, fyLabel)}
          />
        )}
        {hasPettyCash && (
          <ExportBtn
            label="⬇ Petty Cash"
            onClick={() => downloadPettyCashCSV(groupedView, fyLabel)}
          />
        )}
        <ExportBtn
          label="⬇ Financial Summary"
          onClick={() => downloadFinancialSummaryCSV(groupedView, fyLabel)}
        />
      </div>
    </div>
  )
}

// ─── Internal label map ───────────────────────────────────────────────────────

const CLAIM_TYPE_LABELS = {
  recalls:      'Recall',
  retain:       'Retain',
  standby:      'Standby',
  md:           'Muster & Dismiss',
  spoilt:       'Spoilt Meal',
  delayed_meal: 'Delayed Meal',
}
