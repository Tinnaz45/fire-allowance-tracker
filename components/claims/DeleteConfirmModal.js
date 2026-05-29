'use client'

// DeleteConfirmModal — reusable permanent-deletion confirmation.
// Used for deleting an entire claim (parent group + all sub-claims) or a
// single sub-claim. Deletion is permanent — there is no archive/soft-delete.
//
// Props:
//   title        — heading text (e.g. 'Delete Claim')
//   message      — body copy describing exactly what will be removed
//   confirmLabel — confirm button text (default 'Delete')
//   onConfirm    — async fn; modal shows submitting state + surfaces errors
//   onClose      — close without deleting

import { useState } from 'react'

export default function DeleteConfirmModal({
  title = 'Delete',
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onClose,
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const handleConfirm = async () => {
    setError(null)
    setSubmitting(true)
    try {
      await onConfirm()
    } catch (err) {
      console.error('[DeleteConfirmModal]', err)
      setError(err.message || 'Failed to delete. Please try again.')
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
            {title}
          </h2>
          <button type="button" onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: '1.4rem', lineHeight: 1 }}
            aria-label="Close">×</button>
        </div>

        <p style={{ margin: '0 0 18px', fontSize: '0.85rem', color: '#9ca3af', lineHeight: 1.5 }}>
          {message}
        </p>

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
          <button type="button" onClick={handleConfirm} disabled={submitting}
            style={{
              flex: 1, padding: '10px',
              background: submitting ? '#7f1d1d' : '#dc2626',
              border: 'none', borderRadius: '8px',
              color: 'white',
              cursor: submitting ? 'not-allowed' : 'pointer',
              fontSize: '0.9rem', fontWeight: 600,
              transition: 'background 0.15s',
            }}>
            {submitting ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
