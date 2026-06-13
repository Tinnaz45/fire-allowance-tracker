'use client'

// ─── CreatePaymentRecordForm ──────────────────────────────────────────────────
// Objective 3 — operator types one observed real-world pay line. Thin wrapper
// over recordPayment (lib/fat/services/paymentRecords.js → create_payment_record
// RPC). source is fixed to 'manual' for MVP (§ 8 — OCR / exports deferred). The
// new record lands in the unallocated queue until the operator links it.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react'
import { recordPayment } from '@/lib/fat/services/paymentRecords'
import { PAYMENT_STREAMS } from '@/lib/fat/models/reconciliationConstants'
import {
  CARD_STYLE, INPUT_STYLE, LABEL_STYLE, PRIMARY_BTN, disabledBtn,
  Banner, SectionHeading, STREAM_LABELS,
} from './ui'

function todayISO() {
  // Local date in YYYY-MM-DD (avoids UTC off-by-one for AU users).
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10)
}

export default function CreatePaymentRecordForm({ ownerId, onCreated }) {
  const [stream, setStream] = useState(PAYMENT_STREAMS.PAYSLIP)
  const [recordDate, setRecordDate] = useState(todayISO())
  const [grossAmount, setGrossAmount] = useState('')
  const [reference, setReference] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)

  const reset = () => {
    setGrossAmount('')
    setReference('')
    // keep stream + date — operators usually enter several lines from one payslip
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    const amt = Number(grossAmount)
    if (grossAmount === '' || Number.isNaN(amt)) { setError('Enter a gross amount.'); return }
    if (amt < 0) { setError('Gross amount cannot be negative.'); return }
    if (!recordDate) { setError('Select a record date.'); return }

    setSubmitting(true)
    try {
      const rec = await recordPayment({
        ownerId,
        stream,
        recordDate,
        grossAmount: amt,
        source: 'manual',
        reference: reference.trim() || null,
      })
      setSuccess(`${STREAM_LABELS[stream]} line for ${reference.trim() || 'no reference'} recorded.`)
      reset()
      onCreated?.(rec)
      setTimeout(() => setSuccess(null), 4000)
    } catch (err) {
      setError(err.message || 'Failed to create payment record.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={CARD_STYLE}>
      <SectionHeading
        title="Record a payment line"
        subtitle="A payslip line or petty-cash submission you actually received. Link it to entitlements below."
      />

      <form onSubmit={handleSubmit} noValidate>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {/* Stream */}
          <div style={{ flex: '1 1 160px', minWidth: 0 }}>
            <label style={LABEL_STYLE}>Stream</label>
            <select
              value={stream}
              onChange={(e) => setStream(e.target.value)}
              style={{ ...INPUT_STYLE, cursor: 'pointer' }}
            >
              <option value={PAYMENT_STREAMS.PAYSLIP}>📋 Payslip</option>
              <option value={PAYMENT_STREAMS.PETTY_CASH}>💵 Petty Cash</option>
            </select>
          </div>

          {/* Date */}
          <div style={{ flex: '1 1 150px', minWidth: 0 }}>
            <label style={LABEL_STYLE}>Record date</label>
            <input
              type="date"
              value={recordDate}
              onChange={(e) => setRecordDate(e.target.value)}
              style={{ ...INPUT_STYLE, colorScheme: 'dark' }}
            />
          </div>

          {/* Gross amount */}
          <div style={{ flex: '1 1 140px', minWidth: 0 }}>
            <label style={LABEL_STYLE}>Gross amount</label>
            <div style={{ position: 'relative' }}>
              <span style={{
                position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)',
                color: '#6b7280', fontSize: '0.9rem', pointerEvents: 'none',
              }}>$</span>
              <input
                type="number" min="0" step="0.01" placeholder="0.00"
                value={grossAmount}
                onChange={(e) => setGrossAmount(e.target.value)}
                style={{ ...INPUT_STYLE, paddingLeft: '26px' }}
              />
            </div>
          </div>

          {/* Reference */}
          <div style={{ flex: '1 1 180px', minWidth: 0 }}>
            <label style={LABEL_STYLE}>Reference (optional)</label>
            <input
              type="text" placeholder="Payslip line / form ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              style={INPUT_STYLE}
            />
          </div>
        </div>

        {error && <div style={{ marginTop: '14px' }}><Banner tone="error">{error}</Banner></div>}
        {success && <div style={{ marginTop: '14px' }}><Banner tone="success">✓ {success}</Banner></div>}

        <div style={{ marginTop: '16px' }}>
          <button
            type="submit"
            disabled={submitting}
            style={submitting ? disabledBtn(PRIMARY_BTN) : PRIMARY_BTN}
          >
            {submitting ? 'Recording…' : 'Record payment line'}
          </button>
        </div>
      </form>
    </div>
  )
}
