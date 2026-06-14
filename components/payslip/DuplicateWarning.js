'use client'

// ─── DuplicateWarning ─────────────────────────────────────────────────────────
// Surfaces the duplicate-detection verdict an import carries in `duplicate_check`
// (objectives 4–6; PAYSLIP_DUPLICATE_DETECTION_v1.0.md § 4). Advisory only — it
// warns, it never blocks. An EXACT match (identical batch + line set) is the loud
// case; NEAR matches (overlapping lines / same pay period) are the quieter "did you
// mean to re-enter this?" case. The operator stays in control (objective 8): nothing
// here changes lifecycle — the only hard stop is the per-line confirm guard, which
// is itself overridable.
//
// Pure presentational. Reads the persisted metadata blob; offers an optional jump to
// a matched import when the parent provides onSelectImport.
// ─────────────────────────────────────────────────────────────────────────────

import { Banner, fmtDate, fmtDateTime } from '@/components/reconciliation/ui'
import { ImportStatusBadge, importSourceLabel } from './statusUi'

function MatchRow({ m, kind, onSelectImport }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '10px', flexWrap: 'wrap',
      padding: '7px 10px', background: 'rgba(0,0,0,0.25)',
      border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px',
    }}>
      <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <ImportStatusBadge status={m.status} small />
        <span style={{ fontSize: '0.76rem', color: '#e5e7eb' }}>
          {importSourceLabel(m.source)} · Pay {fmtDate(m.pay_date)}
          {m.pay_period_ref ? ` · ${m.pay_period_ref}` : ''}
        </span>
        <span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>
          {kind === 'near'
            ? `${m.shared_lines} shared line${m.shared_lines === 1 ? '' : 's'} · ${Math.round((m.score ?? 0) * 100)}% overlap${m.same_pay_period ? ' · same pay period' : ''}`
            : `${m.line_count} line${m.line_count === 1 ? '' : 's'} · created ${fmtDate(m.created_at)}`}
        </span>
      </div>
      {onSelectImport && (
        <button
          type="button"
          onClick={() => onSelectImport(m.import_id)}
          style={{
            padding: '4px 10px', background: 'transparent', border: '1px solid #444',
            borderRadius: '6px', color: '#cbd5e1', fontSize: '0.72rem', fontWeight: 600,
            cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          View
        </button>
      )}
    </div>
  )
}

export default function DuplicateWarning({ check, onSelectImport }) {
  if (!check || check.verdict === 'clear') return null
  const exact = check.exact ?? []
  const near = check.near ?? []
  if (exact.length === 0 && near.length === 0) return null

  const isExact = check.verdict === 'exact'

  return (
    <div style={{ marginBottom: '16px' }}>
      <Banner tone={isExact ? 'error' : 'info'}>
        <div style={{ fontWeight: 700, marginBottom: '4px' }}>
          {isExact
            ? `⚠ Looks like a duplicate of ${exact.length} existing import${exact.length === 1 ? '' : 's'}`
            : `Possible near-duplicate of ${near.length} existing import${near.length === 1 ? '' : 's'}`}
        </div>
        <div style={{ fontSize: '0.78rem', opacity: 0.95 }}>
          {isExact
            ? 'This import’s pay period and every line match an import you already created. Review before confirming — confirming a line that another import already settled is blocked unless you explicitly override.'
            : 'This import shares lines or a pay period with earlier imports. It may be a re-entry. You can still confirm — duplicate confirms are guarded per line.'}
        </div>
      </Banner>

      {(exact.length > 0 || near.length > 0) && (
        <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {exact.map((m) => (
            <MatchRow key={m.import_id} m={m} kind="exact" onSelectImport={onSelectImport} />
          ))}
          {near.map((m) => (
            <MatchRow key={m.import_id} m={m} kind="near" onSelectImport={onSelectImport} />
          ))}
        </div>
      )}

      {check.checked_at && (
        <div style={{ marginTop: '6px', fontSize: '0.68rem', color: '#6b7280' }}>
          Checked {fmtDateTime(check.checked_at)}
        </div>
      )}
    </div>
  )
}
