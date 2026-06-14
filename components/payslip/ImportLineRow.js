'use client'

// ─── ImportLineRow ────────────────────────────────────────────────────────────
// One staged payslip line and everything an operator does with it:
//   · Objective 4/5 — the parsed values + the line's canonical lifecycle badge.
//   · Objective 6   — confirm / reject / supersede, each through an existing
//                     staging service (confirmImportLine / updateLineResolution).
//   · Objective 7/8/9 — once confirmed, the linked entitlement, the generated
//                     payment record, and the entitlement's reconciliation status.
//
// Confirm is the only canonical write path; it goes through the bridge RPC. When
// the operator picks an entitlement we first persist the choice onto the line
// (updateLineResolution candidate_entitlement_id) so the confirmed line records
// WHICH entitlement settled it — then call confirmImportLine. Candidates are the
// owner's pending payslip-routed entitlements (the only ones a payslip line can
// settle, § 6.1 stream coherence); choosing none is a deliberate record-only
// confirm (§ 6.4 — the unallocated dead-end).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react'
import {
  confirmImportLine,
  updateLineResolution,
} from '@/lib/fat/services/payslipImports'
import { getPaymentRecord } from '@/lib/fat/services/paymentRecords'
import { listEntitlementHistory } from '@/lib/fat/services/reconciliationQueues'
import { canTransitionLine } from '@/lib/fat/models/payslipImport'
import {
  INPUT_STYLE, LABEL_STYLE, PRIMARY_BTN, GHOST_BTN, disabledBtn,
  Banner, EmptyState, StatusBadge, Pill,
  fmtMoney, fmtDate, entitlementTypeLabel, entitlementValueLabel,
  STREAM_LABELS,
} from '@/components/reconciliation/ui'
import { LineStatusBadge, ConfidenceBadge, ExtractConfidenceBadge, confidencePct } from './statusUi'

// ── Recommendation panel: the matcher's proposed candidate + why (Step O4) ──────
// Evidence only — the operator still confirms. Reads the suggestion the matcher
// persisted onto the line (candidate_entitlement_id / match_confidence /
// match_breakdown) and renders the candidate + a per-signal "why it matched" line.
const SIGNAL_LABELS = { amount: 'Amount', pay_cycle: 'Date', reference: 'Reference', type: 'Type' }

function MatchRecommendation({ line, candidates }) {
  const breakdown = line.match_breakdown
  const confidence = line.match_confidence
  if (confidence == null && !line.candidate_entitlement_id) return null

  const band = breakdown?.band ?? 'none'
  const suggested = candidates.find((c) => c.id === line.candidate_entitlement_id) || null
  const signals = breakdown?.signals ?? null
  const applied = signals
    ? Object.entries(signals).filter(([, s]) => s?.applicable)
    : []

  return (
    <div style={{
      background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.18)',
      borderRadius: '8px', padding: '9px 11px', marginTop: '10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.66rem', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Suggested
        </span>
        <ConfidenceBadge confidence={confidence} band={band} small />
        {suggested ? (
          <span style={{ fontSize: '0.8rem', color: '#e5e7eb', fontWeight: 600 }}>
            {entitlementTypeLabel(suggested.entitlement_type)}
            <span style={{ color: '#6b7280', fontWeight: 400 }}>{' · '}{entitlementValueLabel(suggested)}</span>
          </span>
        ) : (
          <span style={{ fontSize: '0.78rem', color: '#9ca3af' }}>
            No confident candidate — link manually below.
          </span>
        )}
      </div>
      {applied.length > 0 && (
        <div style={{ marginTop: '6px', fontSize: '0.7rem', color: '#6b7280', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          {applied.map(([key, s]) => (
            <span key={key}>
              {SIGNAL_LABELS[key] ?? key} <span style={{ color: '#9ca3af', fontVariantNumeric: 'tabular-nums' }}>{confidencePct(s.score)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Confirmed-line detail: linked entitlement + record + reconciliation status ──
function ConfirmedDetail({ line }) {
  const [record, setRecord] = useState(null)
  const [entView, setEntView] = useState(null)   // { entitlement, derived_status }
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    Promise.all([
      line.payment_record_id ? getPaymentRecord(line.payment_record_id) : Promise.resolve(null),
      // A linked line (link_id set) records its entitlement in candidate_entitlement_id.
      line.link_id && line.candidate_entitlement_id
        ? listEntitlementHistory(line.candidate_entitlement_id)
        : Promise.resolve(null),
    ])
      .then(([rec, hist]) => {
        if (!alive) return
        setRecord(rec)
        setEntView(hist ? { entitlement: hist.entitlement, derived_status: hist.derived_status } : null)
      })
      .catch((err) => { if (alive) setError(err.message || 'Failed to load line detail.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [line.payment_record_id, line.link_id, line.candidate_entitlement_id])

  if (loading) return <EmptyState>Loading detail…</EmptyState>
  if (error) return <Banner tone="error">{error}</Banner>

  const ent = entView?.entitlement

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Objective 8 — generated payment record */}
      <div style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: '8px', padding: '10px 12px' }}>
        <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
          Generated payment record
        </div>
        {record ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.86rem', fontWeight: 700, color: '#f9fafb', fontVariantNumeric: 'tabular-nums' }}>
              {fmtMoney(record.gross_amount)}
            </span>
            <span style={{ fontSize: '0.74rem', color: '#9ca3af' }}>{STREAM_LABELS[record.stream] ?? record.stream}</span>
            <span style={{ fontSize: '0.72rem', color: '#6b7280' }}>
              {fmtDate(record.record_date)}{record.reference ? ` · ${record.reference}` : ''} · {record.source}
            </span>
          </div>
        ) : (
          <span style={{ fontSize: '0.78rem', color: '#6b7280' }}>No record found.</span>
        )}
      </div>

      {/* Objectives 7 + 9 — linked entitlement + reconciliation status */}
      <div style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: '8px', padding: '10px 12px' }}>
        <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
          Linked entitlement
        </div>
        {ent ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <span style={{ fontSize: '0.84rem', fontWeight: 600, color: '#f9fafb' }}>
                {entitlementTypeLabel(ent.entitlement_type)}
              </span>
              <span style={{ fontSize: '0.74rem', color: '#6b7280' }}>
                {' · '}{entitlementValueLabel(ent)} · {STREAM_LABELS[ent.payment_method] ?? 'Unrouted'}
              </span>
            </div>
            {entView?.derived_status && <StatusBadge status={entView.derived_status} small />}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Pill tone="amber">Unallocated</Pill>
            <span style={{ fontSize: '0.74rem', color: '#6b7280' }}>
              Record-only confirm — link it from the Payments queue.
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Inline confirm panel: pick an entitlement (or none) and confirm ─────────────
function ConfirmPanel({ line, ownerId, candidates, onDone, onCancel }) {
  // Pre-select the matcher's recommendation (Step O4) — but only if it is a real
  // option the operator can actually pick. The operator can change it or clear it;
  // confirmation stays mandatory.
  const prefill = candidates.some((c) => c.id === line.candidate_entitlement_id)
    ? line.candidate_entitlement_id
    : ''
  const [entitlementId, setEntitlementId] = useState(prefill)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [dupBlock, setDupBlock] = useState(null)   // the duplicate detail when the guard fired

  const chosen = candidates.find((c) => c.id === entitlementId) || null
  const isRecommended = chosen && chosen.id === line.candidate_entitlement_id

  // allowDuplicate=true is the explicit operator override of the double-confirmation
  // guard (objectives 7 + 8): the first attempt is blocked and surfaces the prior
  // record; the operator may then deliberately proceed.
  const handleConfirm = async (allowDuplicate = false) => {
    setError(null)
    setSubmitting(true)
    try {
      if (chosen) {
        // Persist the operator's choice onto the line so the confirmed line records
        // which entitlement settled it, then confirm through the bridge.
        await updateLineResolution({ lineId: line.id, candidateEntitlementId: chosen.id })
        const allocatedAmount = chosen.unit === 'hours' ? 0 : (line.parsed_amount ?? 0)
        await confirmImportLine({
          lineId: line.id,
          actorId: ownerId,
          entitlementId: chosen.id,
          linkKind: 'manual',
          allocatedAmount,
          allowDuplicate,
        })
      } else {
        // Record-only confirm (§ 6.4) — produces a payment record, no link. Clear
        // any stale matcher suggestion so the confirmed line reads as deliberate.
        if (line.candidate_entitlement_id) {
          await updateLineResolution({ lineId: line.id, candidateEntitlementId: '' })
        }
        await confirmImportLine({ lineId: line.id, actorId: ownerId, allowDuplicate })
      }
      onDone?.()
    } catch (err) {
      if (err.code === 'DUPLICATE_CONFIRMED') {
        // Guard fired — don't dead-end; offer an explicit override.
        setDupBlock(err.duplicate ?? true)
      } else {
        setError(err.message || 'Confirm failed.')
      }
      setSubmitting(false)
    }
  }

  return (
    <div style={{ background: '#0d0d0d', border: '1px solid #2a2a2a', borderRadius: '8px', padding: '12px', marginTop: '10px' }}>
      <label style={LABEL_STYLE}>Settle entitlement</label>
      <select
        value={entitlementId}
        onChange={(e) => setEntitlementId(e.target.value)}
        style={{ ...INPUT_STYLE, cursor: 'pointer' }}
      >
        <option value="">Record only — don’t link an entitlement</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id === line.candidate_entitlement_id ? '★ ' : ''}
            {entitlementTypeLabel(c.entitlement_type)} · {entitlementValueLabel(c)}
            {c.id === line.candidate_entitlement_id && line.match_confidence != null
              ? ` (suggested, ${confidencePct(line.match_confidence)})` : ''}
          </option>
        ))}
      </select>
      {isRecommended && (
        <p style={{ margin: '6px 0 0', fontSize: '0.7rem', color: '#93c5fd' }}>
          ★ Pre-selected from the match recommendation — change or clear it if it’s wrong.
        </p>
      )}
      <p style={{ margin: '8px 0 0', fontSize: '0.72rem', color: '#6b7280', lineHeight: 1.5 }}>
        {candidates.length === 0
          ? 'No pending payslip entitlements to settle — this will be a record-only confirm.'
          : chosen
            ? `Confirming creates a payment record and links it to this entitlement (${chosen.unit === 'hours' ? 'hours-based: the link is the evidence' : `allocates ${fmtMoney(line.parsed_amount ?? 0)}`}).`
            : 'Confirming creates a payment record with no link — it lands in the unallocated queue.'}
      </p>

      {error && <div style={{ marginTop: '10px' }}><Banner tone="error">{error}</Banner></div>}

      {dupBlock ? (
        // Double-confirmation guard fired (objective 7). Warn, then let the operator
        // explicitly override (objective 8) — the decision stays theirs.
        <div style={{ marginTop: '12px' }}>
          <Banner tone="error">
            <div style={{ fontWeight: 700, marginBottom: '4px' }}>Already confirmed</div>
            <div style={{ fontSize: '0.78rem' }}>
              An earlier confirmed line already produced a payment record for identical content
              {dupBlock?.duplicate_record_id ? ` (record ${String(dupBlock.duplicate_record_id).slice(0, 8)}…)` : ''}.
              Confirming again will create a <strong>second</strong> payment record. Only override if this
              is a genuinely separate payment.
            </div>
          </Banner>
          <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => handleConfirm(true)}
              disabled={submitting}
              style={submitting ? disabledBtn(PRIMARY_BTN) : PRIMARY_BTN}
            >
              {submitting ? 'Confirming…' : 'Confirm anyway (override)'}
            </button>
            <button type="button" onClick={onCancel} disabled={submitting} style={GHOST_BTN}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
          <button type="button" onClick={() => handleConfirm(false)} disabled={submitting} style={submitting ? disabledBtn(PRIMARY_BTN) : PRIMARY_BTN}>
            {submitting ? 'Confirming…' : 'Confirm line'}
          </button>
          <button type="button" onClick={onCancel} disabled={submitting} style={GHOST_BTN}>Cancel</button>
        </div>
      )}
    </div>
  )
}

// ── The line row ────────────────────────────────────────────────────────────────
export default function ImportLineRow({ line, ownerId, candidates, confirmedFps, onChanged }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(null)   // 'reject' | 'supersede'
  const [error, setError] = useState(null)

  const isOpen = ['parsed', 'needs_review', 'failed'].includes(line.status)
  const isConfirmed = line.status === 'confirmed'
  const canSupersede = canTransitionLine(line.status, 'superseded')
  const canReject = canTransitionLine(line.status, 'rejected')

  // Pre-confirm advisory (objective 7): does this line's content match a line the
  // operator ALREADY confirmed into a payment record (in any import)? The map is the
  // owner's confirmed line fingerprints; exclude this line itself. Confirming will be
  // blocked by the bridge guard unless explicitly overridden — we warn up front.
  const dupConfirmed = isOpen && line.content_fingerprint
    ? confirmedFps?.get(line.content_fingerprint)
    : null
  const alreadyConfirmed = dupConfirmed && dupConfirmed.line_id !== line.id ? dupConfirmed : null

  const runResolution = useCallback(async (status, kind) => {
    setError(null)
    setBusy(kind)
    try {
      await updateLineResolution({ lineId: line.id, status })
      onChanged?.()
    } catch (err) {
      setError(err.message || `Failed to ${kind}.`)
      setBusy(null)
    }
  }, [line.id, onChanged])

  return (
    <div style={{ background: '#111', border: '1px solid #222', borderRadius: '10px', padding: '12px 14px' }}>
      {/* Parsed values + status (objectives 4 + 5) */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.7rem', color: '#4b5563', fontVariantNumeric: 'tabular-nums' }}>#{line.line_index}</span>
            <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f9fafb' }}>
              {line.parsed_reference || line.parsed_description || '(no reference)'}
            </span>
            <span style={{ fontSize: '0.84rem', color: '#e5e7eb', fontVariantNumeric: 'tabular-nums' }}>
              {line.parsed_amount == null ? '— (hours)' : fmtMoney(line.parsed_amount)}
            </span>
          </div>
          <div style={{ marginTop: '4px', fontSize: '0.74rem', color: '#6b7280' }}>
            {line.parsed_description && line.parsed_reference ? `${line.parsed_description} · ` : ''}
            {line.parsed_date ? fmtDate(line.parsed_date) : 'inherits pay date'}
          </div>
          {line.resolution_note && (
            <div style={{ marginTop: '4px', fontSize: '0.72rem', color: '#9ca3af', fontStyle: 'italic' }}>
              “{line.resolution_note}”
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <ExtractConfidenceBadge confidence={line.extract_confidence} small />
          <LineStatusBadge status={line.status} small />
        </div>
      </div>

      {error && <div style={{ marginTop: '10px' }}><Banner tone="error">{error}</Banner></div>}

      {/* Pre-confirm duplicate advisory (objective 7) */}
      {alreadyConfirmed && !confirming && (
        <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <Pill tone="amber">Already confirmed</Pill>
          <span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>
            Identical content was already confirmed into a payment record — confirming is guarded.
          </span>
        </div>
      )}

      {/* Recommendation (Step O4) — the matcher's proposed candidate + confidence */}
      {isOpen && !confirming && <MatchRecommendation line={line} candidates={candidates} />}

      {/* Actions (objective 6) */}
      {isOpen && !confirming && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setConfirming(true)} style={{ ...PRIMARY_BTN, padding: '7px 14px', fontSize: '0.82rem' }}>
            Confirm
          </button>
          {canReject && (
            <button
              type="button"
              onClick={() => runResolution('rejected', 'reject')}
              disabled={busy === 'reject'}
              style={{ ...GHOST_BTN, opacity: busy === 'reject' ? 0.6 : 1 }}
            >
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
          )}
          {canSupersede && (
            <button
              type="button"
              onClick={() => runResolution('superseded', 'supersede')}
              disabled={busy === 'supersede'}
              style={{ ...GHOST_BTN, opacity: busy === 'supersede' ? 0.6 : 1 }}
            >
              {busy === 'supersede' ? 'Superseding…' : 'Supersede'}
            </button>
          )}
        </div>
      )}

      {confirming && (
        <ConfirmPanel
          line={line}
          ownerId={ownerId}
          candidates={candidates}
          onCancel={() => setConfirming(false)}
          onDone={() => { setConfirming(false); onChanged?.() }}
        />
      )}

      {/* Confirmed detail (objectives 7, 8, 9) */}
      {isConfirmed && (
        <div style={{ marginTop: '12px' }}>
          <ConfirmedDetail line={line} />
        </div>
      )}
    </div>
  )
}
