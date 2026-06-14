'use client'

// ─── ImportsList ──────────────────────────────────────────────────────────────
// Objective 2 (display imports) + Objective 3 (display import lifecycle). Every
// payslip-import batch the operator has created, newest first, each tagged with
// its canonical lifecycle status (ImportStatusBadge). Tap a row to open its detail
// (lines + per-line actions). Reloads on `reloadToken`.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react'
import { listImports } from '@/lib/fat/services/payslipImports'
import {
  CARD_STYLE, SectionHeading, EmptyState, Banner, fmtDate,
} from '@/components/reconciliation/ui'
import { ImportStatusBadge, importSourceLabel } from './statusUi'

export default function ImportsList({ ownerId, reloadToken, selectedId, onSelect }) {
  const [imports, setImports] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!ownerId) return
    setLoading(true)
    setError(null)
    try {
      setImports(await listImports(ownerId))
    } catch (err) {
      setError(err.message || 'Failed to load imports.')
      setImports([])
    } finally {
      setLoading(false)
    }
  }, [ownerId])

  useEffect(() => { load() }, [load, reloadToken])

  return (
    <div style={CARD_STYLE}>
      <SectionHeading
        title="Imports"
        subtitle={
          imports.length === 0
            ? 'Payslip batches you have created.'
            : `${imports.length} import${imports.length === 1 ? '' : 's'}`
        }
      />

      {error && <div style={{ marginBottom: '12px' }}><Banner tone="error">{error}</Banner></div>}

      {loading ? (
        <EmptyState>Loading…</EmptyState>
      ) : imports.length === 0 ? (
        <EmptyState>No imports yet. Create one above.</EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {imports.map((imp) => {
            const selected = imp.id === selectedId
            return (
              <button
                key={imp.id}
                type="button"
                onClick={() => onSelect(imp.id)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: '12px', width: '100%', textAlign: 'left',
                  padding: '12px 14px', background: selected ? '#1f1f1f' : '#111',
                  border: `1px solid ${selected ? '#dc2626' : '#222'}`,
                  borderRadius: '10px', cursor: 'pointer', color: '#e5e7eb',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#f9fafb' }}>
                      {importSourceLabel(imp.source)}
                    </span>
                    <span style={{ fontSize: '0.76rem', color: '#9ca3af' }}>
                      {imp.line_count} line{imp.line_count === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div style={{ marginTop: '4px', fontSize: '0.74rem', color: '#6b7280' }}>
                    Pay {fmtDate(imp.pay_date)}
                    {imp.pay_period_ref ? ` · ${imp.pay_period_ref}` : ''}
                    {` · created ${fmtDate(imp.created_at)}`}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                  <ImportStatusBadge status={imp.status} small />
                  <span style={{ color: '#4b5563', fontSize: '1.1rem', lineHeight: 1 }}>›</span>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
