'use client'

// ─── ReconciliationQueues ─────────────────────────────────────────────────────
// Objectives 2 + 5 — the two operator work-queues:
//   · Pending Payslip      (listPendingPayslip:       payslip / pending)
//   · Outstanding Petty Cash (listOutstandingPettyCash: petty_cash / outstanding)
// Each row is an engine-generated entitlement awaiting settlement. Clicking a row
// opens the per-entitlement reconciliation modal (link / status / audit).
// Reloads whenever `reloadToken` changes (after any mutation on the page).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react'
import {
  listPendingPayslip,
  listOutstandingPettyCash,
} from '@/lib/fat/services/reconciliationQueues'
import {
  CARD_STYLE, SectionHeading, EmptyState, Banner, StatusBadge,
  entitlementTypeLabel, entitlementValueLabel, fmtDate, Pill,
} from './ui'

const TABS = [
  { key: 'payslip', label: '📋 Pending Payslip', loader: listPendingPayslip },
  { key: 'petty_cash', label: '💵 Outstanding Petty Cash', loader: listOutstandingPettyCash },
]

function EntitlementRow({ ent, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(ent)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '12px', width: '100%', textAlign: 'left',
        padding: '12px 14px', background: '#111', border: '1px solid #222',
        borderRadius: '10px', cursor: 'pointer', color: '#e5e7eb',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#f9fafb' }}>
            {entitlementTypeLabel(ent.entitlement_type)}
          </span>
          <Pill tone={ent.unit === 'hours' ? 'blue' : 'grey'}>{ent.unit}</Pill>
        </div>
        <div style={{ marginTop: '4px', fontSize: '0.76rem', color: '#6b7280' }}>
          {entitlementValueLabel(ent)} · generated {fmtDate(ent.generated_at)}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
        <StatusBadge status={ent.payment_status} small />
        <span style={{ color: '#4b5563', fontSize: '1.1rem', lineHeight: 1 }}>›</span>
      </div>
    </button>
  )
}

export default function ReconciliationQueues({ ownerId, reloadToken, onSelectEntitlement }) {
  const [active, setActive] = useState('payslip')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!ownerId) return
    setLoading(true)
    setError(null)
    try {
      const loader = TABS.find((t) => t.key === active).loader
      setRows(await loader(ownerId))
    } catch (err) {
      setError(err.message || 'Failed to load queue.')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [ownerId, active])

  useEffect(() => { load() }, [load, reloadToken])

  return (
    <div style={CARD_STYLE}>
      <SectionHeading
        title="Reconciliation queues"
        subtitle="Engine-generated entitlements awaiting settlement. Tap one to link a payment."
      />

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: '4px', background: '#111', borderRadius: '10px',
        padding: '4px', marginBottom: '16px', overflowX: 'auto',
      }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActive(t.key)}
            style={{
              flex: 1, padding: '8px 12px', borderRadius: '8px', border: 'none',
              background: active === t.key ? '#dc2626' : 'transparent',
              color: active === t.key ? 'white' : '#6b7280',
              fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div style={{ marginBottom: '12px' }}><Banner tone="error">{error}</Banner></div>}

      {loading ? (
        <EmptyState>Loading…</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>
          {active === 'payslip'
            ? 'No pending payslip entitlements. Generate a Standby or M&D claim to populate this queue.'
            : 'No outstanding petty-cash entitlements.'}
        </EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {rows.map((ent) => (
            <EntitlementRow key={ent.id} ent={ent} onSelect={onSelectEntitlement} />
          ))}
        </div>
      )}
    </div>
  )
}
