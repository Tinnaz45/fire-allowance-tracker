'use client'

// MarkPaidPayNumberModal — captures the Pay Number when marking a Payslip-paid
// subclaim (Excess Travel or Standby&Dismi) as Paid. The Pay Number is no
// longer collected at claim-creation time; it is mandatory only at this step.
//
// Petty Cash rows never reach this modal — QuickPayToggle skips the prompt and
// marks them paid directly.

import { useState } from 'react'
import { useClaims } from '@/lib/claims/ClaimsContext'

const INPUT_STYLE = {
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

const LABEL_STYLE = {
  display: 'block',
  fontSize: '0.78rem',
  fontWeight: 600,
  color: '#9ca3af',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '6px',
}

export default function MarkPaidPayNumberModal({ claim, session, activeFY, onClose, onSuccess }) {
  const { updatePaymentStatus } = useClaims()
  const [payNumber, setPayNumber] = useState(claim?.payslip_pay_nbr || '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    const trimmed = (payNumber || '').trim()
    if (!trimmed) {
      setError('Pay Number is required to mark a payslip line as paid.')
      return
    }
    setSubmitting(true)
    try {
      await updatePaymentStatus({
        userId: session.user.id,
        claim,
        paymentStatus: 'Paid',
        payNumber: trimmed,
        financialYearId: activeFY?.id || null,
      })
      onSuccess?.()
    } catch (err) {
      console.error('[MarkPaidPayNumberModal]', err)
      setError(err.message || 'Failed to mark as paid. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1100, padding: '20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#1a1a1a',
          border: '1px solid #2a2a2a',
          borderRadius: '16px',
          padding: '24px',
          width: '100%',
          maxWidth: '420px',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
          <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: '#f9fafb' }}>
            Mark as Paid
          </h2>
          <button type="button" onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: '1.4rem', lineHeight: 1 }}
            aria-label="Close">×</button>
        </div>
        <p style={{ margin: '0 0 18px', fontSize: '0.82rem', color: '#9ca3af' }}>
          Enter the Pay Number from the payslip line so the entitlement can be
          reconciled later.
        </p>

        <form onSubmit={handleSubmit} noValidate>
          <div style={{ marginBottom: '16px' }}>
            <label style={LABEL_STYLE}>Pay Number</label>
            <input
              type="text"
              value={payNumber}
              onChange={(e) => setPayNumber(e.target.value)}
              placeholder="e.g. 20.2026"
              autoFocus
              style={INPUT_STYLE}
            />
          </div>

          {error && (
            <div style={{
              marginBottom: '16px',
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#f87171',
              borderRadius: '8px',
              padding: '10px 14px',
              fontSize: '0.85rem',
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px' }}>
            <button type="button" onClick={onClose} disabled={submitting}
              style={{
                flex: 1, padding: '10px',
                background: 'transparent', border: '1px solid #333',
                borderRadius: '8px', color: '#9ca3af',
                cursor: submitting ? 'not-allowed' : 'pointer',
                fontSize: '0.9rem', fontWeight: 600,
              }}>
              Cancel
            </button>
            <button type="submit" disabled={submitting}
              style={{
                flex: 1, padding: '10px',
                background: submitting ? '#14532d' : '#16a34a',
                border: 'none', borderRadius: '8px',
                color: 'white',
                cursor: submitting ? 'not-allowed' : 'pointer',
                fontSize: '0.9rem', fontWeight: 600,
              }}>
              {submitting ? 'Saving…' : 'Mark Paid'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
