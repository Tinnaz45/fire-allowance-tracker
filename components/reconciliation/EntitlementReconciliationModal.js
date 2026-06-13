'use client'

// ─── EntitlementReconciliationModal ───────────────────────────────────────────
// Objectives 4, 5, 6, 7, 8 — the per-entitlement reconciliation drawer (§ 8.1).
// Everything the operator needs to settle one entitlement, all through the
// existing service layer (objective 9):
//   · current reconciliation status + DERIVED partial state (evaluateDerivedStatus)
//   · manual linking of a payment record → entitlement   (linkPayment)
//   · unlink                                             (unlinkPayment)
//   · the link set + the reconciliation_audit trail      (listEntitlementHistory)
//
// Terminal determination is server-authoritative (recompute RPC); the derived
// status shown here is computed by the SAME predicate the server mirrors, so the
// badge never disagrees with the persisted status.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react'
import { listEntitlementHistory } from '@/lib/fat/services/reconciliationQueues'
import { listPaymentRecords } from '@/lib/fat/services/paymentRecords'
import { linkPayment, unlinkPayment } from '@/lib/fat/services/reconciliation'
import { sumAllocated } from '@/lib/fat/models/reconciliationHelpers'
import { LINK_KINDS } from '@/lib/fat/models/reconciliationConstants'
import {
  INPUT_STYLE, LABEL_STYLE, PRIMARY_BTN, GHOST_BTN, disabledBtn,
  Banner, EmptyState, StatusBadge, Pill,
  fmtMoney, fmtHours, fmtDate, fmtDateTime,
  entitlementTypeLabel, entitlementValueLabel, effectiveAmount,
  STREAM_LABELS, LINK_KIND_LABELS, actionLabel,
} from './ui'

// ─── Modal shell (matches app/page.js ModalBackdrop) ──────────────────────────

function ModalShell({ onClose, children }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: '20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: '16px',
          padding: '24px 22px', width: '100%', maxWidth: '560px', maxHeight: '90vh',
          overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.6)', position: 'relative',
        }}
      >
        {children}
      </div>
    </div>
  )
}

// ─── Link form ────────────────────────────────────────────────────────────────

function LinkForm({ entitlement, currentLinks, ownerId, onLinked }) {
  const isHours = entitlement.unit === 'hours'
  const stream = entitlement.payment_method

  const [records, setRecords] = useState([])
  const [recordId, setRecordId] = useState('')
  const [linkKind, setLinkKind] = useState(LINK_KINDS.MANUAL)
  const [allocated, setAllocated] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [loadingRecords, setLoadingRecords] = useState(true)

  // Remaining dollar need (dollars-first only) — default the allocation to it.
  const effective = effectiveAmount(entitlement)
  const alreadyAllocated = sumAllocated(currentLinks)
  const remainingNeed = effective == null
    ? null
    : Math.max(0, Math.round((Number(effective) - alreadyAllocated) * 100) / 100)

  useEffect(() => {
    let alive = true
    setLoadingRecords(true)
    // Candidate records: same stream as the entitlement (matcher enforces stream
    // coherence for status-eligible links; we mirror that in the picker).
    listPaymentRecords(ownerId, { stream })
      .then((recs) => { if (alive) setRecords(recs) })
      .catch((err) => { if (alive) setError(err.message) })
      .finally(() => { if (alive) setLoadingRecords(false) })
    return () => { alive = false }
  }, [ownerId, stream])

  // Seed the allocation default once records load.
  useEffect(() => {
    if (isHours) setAllocated('0')
    else if (remainingNeed != null) setAllocated(String(remainingNeed))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHours])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    if (!recordId) { setError('Select a payment record to link.'); return }
    const amt = Number(allocated)
    if (allocated === '' || Number.isNaN(amt) || amt < 0) { setError('Allocation must be 0 or more.'); return }

    setSubmitting(true)
    try {
      const result = await linkPayment({
        entitlementId: entitlement.id,
        paymentRecordId: recordId,
        allocatedAmount: amt,
        linkKind,
        actorId: ownerId,
        note: note.trim() || null,
      })
      setRecordId('')
      setNote('')
      onLinked?.(result)
    } catch (err) {
      setError(err.message || 'Failed to link payment.')
    } finally {
      setSubmitting(false)
    }
  }

  const isNote = linkKind === LINK_KINDS.DISCREPANCY_NOTE

  return (
    <form onSubmit={handleSubmit} noValidate style={{
      background: '#111', border: '1px solid #222', borderRadius: '10px', padding: '14px',
    }}>
      <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#f9fafb', marginBottom: '12px' }}>
        Link a payment record
      </div>

      {/* Record picker */}
      <div style={{ marginBottom: '12px' }}>
        <label style={LABEL_STYLE}>{STREAM_LABELS[stream] ?? stream} record</label>
        <select
          value={recordId}
          onChange={(e) => setRecordId(e.target.value)}
          style={{ ...INPUT_STYLE, cursor: 'pointer' }}
          disabled={loadingRecords}
        >
          <option value="">
            {loadingRecords ? 'Loading records…' : records.length ? 'Select a record…' : 'No matching records — record one first'}
          </option>
          {records.map((r) => (
            <option key={r.id} value={r.id}>
              {fmtMoney(r.gross_amount)} · {fmtDate(r.record_date)}{r.reference ? ` · ${r.reference}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        {/* Link kind */}
        <div style={{ flex: '1 1 150px', minWidth: 0 }}>
          <label style={LABEL_STYLE}>Link kind</label>
          <select
            value={linkKind}
            onChange={(e) => setLinkKind(e.target.value)}
            style={{ ...INPUT_STYLE, cursor: 'pointer' }}
          >
            <option value={LINK_KINDS.MANUAL}>Manual link (counts)</option>
            <option value={LINK_KINDS.DISCREPANCY_NOTE}>Discrepancy note (excluded)</option>
          </select>
        </div>

        {/* Allocation */}
        <div style={{ flex: '1 1 130px', minWidth: 0 }}>
          <label style={LABEL_STYLE}>Allocation</label>
          <div style={{ position: 'relative' }}>
            <span style={{
              position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)',
              color: '#6b7280', fontSize: '0.9rem', pointerEvents: 'none',
            }}>$</span>
            <input
              type="number" min="0" step="0.01"
              value={allocated}
              onChange={(e) => setAllocated(e.target.value)}
              style={{ ...INPUT_STYLE, paddingLeft: '26px' }}
            />
          </div>
        </div>
      </div>

      <p style={{ margin: '8px 0 0', fontSize: '0.72rem', color: '#6b7280', lineHeight: 1.5 }}>
        {isHours
          ? 'Hours-based entitlement: the link itself is the settlement evidence — allocation can stay $0.00.'
          : remainingNeed != null
            ? `Remaining to settle: ${fmtMoney(remainingNeed)} of ${fmtMoney(effective)}.`
            : ''}
        {isNote && ' A discrepancy note is recorded but never counts toward settlement.'}
      </p>

      {/* Note */}
      <div style={{ marginTop: '12px' }}>
        <label style={LABEL_STYLE}>Note (optional)</label>
        <input
          type="text" placeholder={isNote ? 'Why this is noted but not counted' : 'e.g. matched payslip line'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          style={INPUT_STYLE}
        />
      </div>

      {error && <div style={{ marginTop: '12px' }}><Banner tone="error">{error}</Banner></div>}

      <div style={{ marginTop: '14px' }}>
        <button type="submit" disabled={submitting} style={submitting ? disabledBtn(PRIMARY_BTN) : PRIMARY_BTN}>
          {submitting ? 'Linking…' : isNote ? 'Add discrepancy note' : 'Link payment'}
        </button>
      </div>
    </form>
  )
}

// ─── Link row (with unlink) ───────────────────────────────────────────────────

function LinkRow({ link, recordsById, ownerId, onUnlinked }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const rec = recordsById.get(link.payment_record_id)
  const isNote = link.link_kind === LINK_KINDS.DISCREPANCY_NOTE

  const handleUnlink = async () => {
    setError(null)
    setBusy(true)
    try {
      const result = await unlinkPayment({ linkId: link.id, actorId: ownerId, reason: 'removed via UI' })
      onUnlinked?.(result)
    } catch (err) {
      setError(err.message || 'Failed to unlink.')
      setBusy(false)
    }
  }

  return (
    <div style={{
      padding: '10px 12px', background: '#111', border: '1px solid #222', borderRadius: '8px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 }}>
          <Pill tone={isNote ? 'grey' : 'blue'}>{LINK_KIND_LABELS[link.link_kind] ?? link.link_kind}</Pill>
          <span style={{ fontSize: '0.82rem', color: '#e5e7eb', fontVariantNumeric: 'tabular-nums' }}>
            {fmtMoney(link.allocated_amount)} allocated
          </span>
          {rec && (
            <span style={{ fontSize: '0.74rem', color: '#6b7280' }}>
              ← {fmtMoney(rec.gross_amount)} {fmtDate(rec.record_date)}{rec.reference ? ` · ${rec.reference}` : ''}
            </span>
          )}
        </div>
        <button
          type="button" onClick={handleUnlink} disabled={busy}
          style={{ ...GHOST_BTN, padding: '6px 10px', fontSize: '0.76rem', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? 'Removing…' : 'Unlink'}
        </button>
      </div>
      {link.note && (
        <div style={{ marginTop: '6px', fontSize: '0.74rem', color: '#9ca3af', fontStyle: 'italic' }}>
          “{link.note}”
        </div>
      )}
      {error && <div style={{ marginTop: '8px' }}><Banner tone="error">{error}</Banner></div>}
    </div>
  )
}

// ─── Audit row ────────────────────────────────────────────────────────────────

function AuditRow({ entry }) {
  return (
    <div style={{ display: 'flex', gap: '10px', padding: '8px 0', borderBottom: '1px solid #1f1f1f' }}>
      <div style={{ width: '6px', flexShrink: 0, display: 'flex', justifyContent: 'center', paddingTop: '5px' }}>
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#dc2626' }} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#f9fafb' }}>{actionLabel(entry.action)}</span>
          {(entry.prior_status || entry.new_status) && (
            <span style={{ fontSize: '0.74rem', color: '#6b7280' }}>
              {entry.prior_status ?? '—'} → {entry.new_status ?? '—'}
            </span>
          )}
          {entry.automated && <Pill tone="grey">auto</Pill>}
        </div>
        {entry.reason && (
          <div style={{ fontSize: '0.74rem', color: '#9ca3af', marginTop: '2px' }}>{entry.reason}</div>
        )}
        <div style={{ fontSize: '0.7rem', color: '#4b5563', marginTop: '2px' }}>{fmtDateTime(entry.created_at)}</div>
      </div>
    </div>
  )
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export default function EntitlementReconciliationModal({ entitlementId, ownerId, onClose, onChanged }) {
  const [data, setData] = useState(null)   // { entitlement, links, audit_history, derived_status }
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const hist = await listEntitlementHistory(entitlementId)
      setData(hist)
      // Records (any stream) so link rows can show the record they reference.
      const recs = await listPaymentRecords(ownerId)
      setRecords(recs)
    } catch (err) {
      setError(err.message || 'Failed to load reconciliation detail.')
    } finally {
      setLoading(false)
    }
  }, [entitlementId, ownerId])

  useEffect(() => { load() }, [load])

  // After any mutation: refresh this modal AND tell the parent to refresh queues.
  const handleMutation = useCallback(() => {
    load()
    onChanged?.()
  }, [load, onChanged])

  const ent = data?.entitlement
  const links = data?.links ?? []
  const recordsById = new Map(records.map((r) => [r.id, r]))

  return (
    <ModalShell onClose={onClose}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '18px' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: '#f9fafb' }}>
            {ent ? entitlementTypeLabel(ent.entitlement_type) : 'Reconciliation'}
          </h2>
          {ent && (
            <p style={{ margin: '2px 0 0', fontSize: '0.78rem', color: '#6b7280' }}>
              {entitlementValueLabel(ent)} · {STREAM_LABELS[ent.payment_method] ?? 'Unrouted'}
            </p>
          )}
        </div>
        <button
          type="button" onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: '1.4rem', lineHeight: 1, padding: '0 4px', flexShrink: 0 }}
          aria-label="Close"
        >×</button>
      </div>

      {error && <div style={{ marginBottom: '14px' }}><Banner tone="error">{error}</Banner></div>}

      {loading ? (
        <EmptyState>Loading…</EmptyState>
      ) : !ent ? (
        <EmptyState>Entitlement not found.</EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* Status + derived partial state (objectives 5, 6) */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: '12px', flexWrap: 'wrap',
            padding: '14px', background: '#111', border: '1px solid #222', borderRadius: '10px',
          }}>
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
                Reconciliation status
              </div>
              <StatusBadge status={data.derived_status} />
            </div>
            <div style={{ textAlign: 'right', fontSize: '0.76rem', color: '#9ca3af' }}>
              {ent.unit === 'hours' ? (
                <>{links.filter((l) => l.link_kind !== LINK_KINDS.DISCREPANCY_NOTE).length} settlement link(s)</>
              ) : (
                <>{fmtMoney(sumAllocated(links))} of {fmtMoney(effectiveAmount(ent))} allocated</>
              )}
              <div style={{ fontSize: '0.7rem', color: '#4b5563', marginTop: '2px' }}>
                stored: {ent.payment_status ?? '—'}
              </div>
            </div>
          </div>

          {/* Link form (objective 4) */}
          <LinkForm
            entitlement={ent}
            currentLinks={links}
            ownerId={ownerId}
            onLinked={handleMutation}
          />

          {/* Current links (objective 8 — entitlement evidence) */}
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#f9fafb', marginBottom: '10px' }}>
              Linked payments ({links.length})
            </div>
            {links.length === 0 ? (
              <EmptyState>No payments linked yet.</EmptyState>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {links.map((link) => (
                  <LinkRow
                    key={link.id}
                    link={link}
                    recordsById={recordsById}
                    ownerId={ownerId}
                    onUnlinked={handleMutation}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Audit history (objective 7) */}
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#f9fafb', marginBottom: '6px' }}>
              Audit history ({data.audit_history.length})
            </div>
            {data.audit_history.length === 0 ? (
              <EmptyState>No actions recorded yet.</EmptyState>
            ) : (
              <div>
                {data.audit_history.map((entry) => (
                  <AuditRow key={entry.id} entry={entry} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </ModalShell>
  )
}
