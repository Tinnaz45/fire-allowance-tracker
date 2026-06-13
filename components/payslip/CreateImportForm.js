'use client'

// ─── CreateImportForm ─────────────────────────────────────────────────────────
// Objective 1 (create) — the operator types a payslip's lines by hand. There is
// NO OCR, NO PDF/screenshot upload, NO AI extraction here (constraints): this is a
// structuring pass over already-typed input via the ManualEntryAdapter, wired
// through createManualEntryImport (lib/fat/services/payslipImports.js). The new
// batch walks uploaded → parsing → parsed → needs_review server-side and rests
// ready for review (§ 4.1).
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react'
import { createManualEntryImport } from '@/lib/fat/services/payslipImports'
import {
  CARD_STYLE, INPUT_STYLE, LABEL_STYLE, PRIMARY_BTN, GHOST_BTN, disabledBtn,
  Banner, SectionHeading,
} from '@/components/reconciliation/ui'

function todayISO() {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10)
}

const emptyLine = () => ({ reference: '', description: '', amount: '', date: '' })

export default function CreateImportForm({ ownerId, onCreated }) {
  const [payDate, setPayDate] = useState(todayISO())
  const [payPeriodRef, setPayPeriodRef] = useState('')
  const [lines, setLines] = useState([emptyLine()])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)

  const setLine = (i, patch) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  const addLine = () => setLines((prev) => [...prev, emptyLine()])
  const removeLine = (i) =>
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)))

  const reset = () => {
    setPayPeriodRef('')
    setLines([emptyLine()])
    // keep pay_date — operators usually enter one payslip's worth of lines
  }

  // A line counts if it carries any signal (reference / description / amount).
  const filledLines = lines.filter(
    (l) => l.reference.trim() || l.description.trim() || String(l.amount).trim(),
  )

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (filledLines.length === 0) {
      setError('Add at least one line (a reference, description, or amount).')
      return
    }
    if (!payDate) { setError('Select the pay date.'); return }

    setSubmitting(true)
    try {
      const { import: imp, lines: created } = await createManualEntryImport({
        ownerId,
        form: {
          pay_date: payDate,
          pay_period_ref: payPeriodRef.trim() || null,
          lines: filledLines.map((l) => ({
            reference: l.reference.trim() || null,
            description: l.description.trim() || null,
            amount: String(l.amount).trim() || null,
            date: l.date || null,
          })),
        },
      })
      setSuccess(`Import created with ${created.length} line${created.length === 1 ? '' : 's'} — ready for review.`)
      reset()
      onCreated?.(imp)
      setTimeout(() => setSuccess(null), 4000)
    } catch (err) {
      setError(err.message || 'Failed to create import.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={CARD_STYLE}>
      <SectionHeading
        title="New manual import"
        subtitle="Type the lines from a payslip. No upload or OCR — you enter the values, then review and confirm them below."
      />

      <form onSubmit={handleSubmit} noValidate>
        {/* Batch header */}
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}>
            <label style={LABEL_STYLE}>Pay date</label>
            <input
              type="date"
              value={payDate}
              onChange={(e) => setPayDate(e.target.value)}
              style={{ ...INPUT_STYLE, colorScheme: 'dark' }}
            />
          </div>
          <div style={{ flex: '1 1 180px', minWidth: 0 }}>
            <label style={LABEL_STYLE}>Pay period ref (optional)</label>
            <input
              type="text" placeholder="e.g. PP-13"
              value={payPeriodRef}
              onChange={(e) => setPayPeriodRef(e.target.value)}
              style={INPUT_STYLE}
            />
          </div>
        </div>

        {/* Lines */}
        <label style={LABEL_STYLE}>Lines</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {lines.map((l, i) => (
            <div
              key={i}
              style={{
                display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end',
                background: '#111', border: '1px solid #222', borderRadius: '10px', padding: '12px',
              }}
            >
              <div style={{ flex: '1 1 130px', minWidth: 0 }}>
                <label style={{ ...LABEL_STYLE, fontSize: '0.66rem' }}>Reference</label>
                <input
                  type="text" placeholder="EXCESS TRAVEL"
                  value={l.reference}
                  onChange={(e) => setLine(i, { reference: e.target.value })}
                  style={INPUT_STYLE}
                />
              </div>
              <div style={{ flex: '1 1 150px', minWidth: 0 }}>
                <label style={{ ...LABEL_STYLE, fontSize: '0.66rem' }}>Description</label>
                <input
                  type="text" placeholder="excess travel SB"
                  value={l.description}
                  onChange={(e) => setLine(i, { description: e.target.value })}
                  style={INPUT_STYLE}
                />
              </div>
              <div style={{ flex: '0 1 110px', minWidth: 0 }}>
                <label style={{ ...LABEL_STYLE, fontSize: '0.66rem' }}>Amount</label>
                <div style={{ position: 'relative' }}>
                  <span style={{
                    position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)',
                    color: '#6b7280', fontSize: '0.85rem', pointerEvents: 'none',
                  }}>$</span>
                  <input
                    type="number" min="0" step="0.01" placeholder="0.00"
                    value={l.amount}
                    onChange={(e) => setLine(i, { amount: e.target.value })}
                    style={{ ...INPUT_STYLE, paddingLeft: '22px' }}
                  />
                </div>
              </div>
              <div style={{ flex: '0 1 140px', minWidth: 0 }}>
                <label style={{ ...LABEL_STYLE, fontSize: '0.66rem' }}>Date (optional)</label>
                <input
                  type="date"
                  value={l.date}
                  onChange={(e) => setLine(i, { date: e.target.value })}
                  style={{ ...INPUT_STYLE, colorScheme: 'dark' }}
                />
              </div>
              <button
                type="button"
                onClick={() => removeLine(i)}
                disabled={lines.length === 1}
                title="Remove line"
                style={{
                  ...GHOST_BTN, padding: '8px 12px',
                  opacity: lines.length === 1 ? 0.4 : 1,
                  cursor: lines.length === 1 ? 'not-allowed' : 'pointer',
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div style={{ marginTop: '10px' }}>
          <button type="button" onClick={addLine} style={GHOST_BTN}>+ Add line</button>
        </div>

        <p style={{ margin: '10px 0 0', fontSize: '0.72rem', color: '#6b7280', lineHeight: 1.5 }}>
          Leave the amount blank for an hours-based line (e.g. excess travel / standby dismissal) —
          the link itself is the settlement evidence.
        </p>

        {error && <div style={{ marginTop: '14px' }}><Banner tone="error">{error}</Banner></div>}
        {success && <div style={{ marginTop: '14px' }}><Banner tone="success">✓ {success}</Banner></div>}

        <div style={{ marginTop: '16px' }}>
          <button type="submit" disabled={submitting} style={submitting ? disabledBtn(PRIMARY_BTN) : PRIMARY_BTN}>
            {submitting ? 'Creating…' : 'Create import'}
          </button>
        </div>
      </form>
    </div>
  )
}
