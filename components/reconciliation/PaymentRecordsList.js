'use client'

// ─── PaymentRecordsList ───────────────────────────────────────────────────────
// Objective 5 (status surface, record side) — every payment line the operator
// has recorded, newest first, each flagged Allocated / Unallocated. "Unallocated"
// = no status-eligible (auto_match / manual) link yet (listUnallocatedPayments,
// § 8.4); discrepancy_note links do NOT make a record allocated. Reloads on
// `reloadToken`.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react'
import { listPaymentRecords } from '@/lib/fat/services/paymentRecords'
import { listUnallocatedPayments } from '@/lib/fat/services/reconciliationQueues'
import {
  CARD_STYLE, SectionHeading, EmptyState, Banner, Pill,
  fmtMoney, fmtDate, STREAM_LABELS,
} from './ui'

export default function PaymentRecordsList({ ownerId, reloadToken }) {
  const [records, setRecords] = useState([])
  const [unallocatedIds, setUnallocatedIds] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!ownerId) return
    setLoading(true)
    setError(null)
    try {
      const [all, unallocated] = await Promise.all([
        listPaymentRecords(ownerId),
        listUnallocatedPayments(ownerId),
      ])
      setRecords(all)
      setUnallocatedIds(new Set(unallocated.map((r) => r.id)))
    } catch (err) {
      setError(err.message || 'Failed to load payment records.')
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [ownerId])

  useEffect(() => { load() }, [load, reloadToken])

  const unallocatedCount = records.filter((r) => unallocatedIds.has(r.id)).length

  return (
    <div style={CARD_STYLE}>
      <SectionHeading
        title="Payment records"
        subtitle={
          records.length === 0
            ? 'Payslip lines and petty-cash submissions you have recorded.'
            : `${records.length} record${records.length === 1 ? '' : 's'} · ${unallocatedCount} unallocated`
        }
      />

      {error && <div style={{ marginBottom: '12px' }}><Banner tone="error">{error}</Banner></div>}

      {loading ? (
        <EmptyState>Loading…</EmptyState>
      ) : records.length === 0 ? (
        <EmptyState>No payment records yet. Record a payment line above.</EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {records.map((rec) => {
            const unalloc = unallocatedIds.has(rec.id)
            return (
              <div
                key={rec.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: '12px', padding: '12px 14px', background: '#111',
                  border: '1px solid #222', borderRadius: '10px',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f9fafb', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtMoney(rec.gross_amount)}
                    </span>
                    <span style={{ fontSize: '0.76rem', color: '#9ca3af' }}>
                      {STREAM_LABELS[rec.stream] ?? rec.stream}
                    </span>
                  </div>
                  <div style={{ marginTop: '4px', fontSize: '0.74rem', color: '#6b7280' }}>
                    {fmtDate(rec.record_date)}
                    {rec.reference ? ` · ${rec.reference}` : ''}
                  </div>
                </div>
                <Pill tone={unalloc ? 'amber' : 'green'}>
                  {unalloc ? 'Unallocated' : 'Allocated'}
                </Pill>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
