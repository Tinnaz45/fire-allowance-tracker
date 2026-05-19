'use client'

// ─── RecallLegDistanceField ──────────────────────────────────────────────────
// Auto-fills the "Rostered to Recall Station (one way, km)" distance from the
// official FRV "Index (KM)" lookup table — never from a live routing provider.
//
// This is a deterministic lookup against fat.travel_matrix_versions /
// fat.travel_matrix_cells (active KM version). The previous implementation
// derived this leg from Google Maps / OSRM, which produced non-deterministic
// distances that did not match the indexed allowance calculation. We now read
// the canonical FRV value so claim totals match payroll exactly.
//
// Behaviour:
//   1. Same station for both rostered + recall → 0 km (operational rule:
//      "Leave 0 if recalled to your own rostered station").
//   2. Both stations resolvable AND an indexed cell exists → surface the
//      indexed KM value with Accept / Edit / Recalculate (re-reads the index).
//   3. Recall input empty / unparseable → manual numeric entry.
//   4. Indexed cell is missing for the pair → controlled "no indexed match"
//      warning + manual entry. NO silent fallback to routing APIs.
//   5. Network failure reading the index → error state, manual entry usable.
//
// The value surfaced to the parent is still written into form.distStnKm so
// calcRecallClaim continues to drive totals unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react'
import { lookupMatrixKm, getActiveMatrixVersion } from '@/lib/distance/matrix/matrixClient'

// ── Constants ───────────────────────────────────────────────────────────────

const DISCLAIMER_TEXT =
  'Distance is read from the official FRV Index (KM) lookup table for this ' +
  'station pair. It is deterministic and matches the indexed allowance ' +
  'calculation — but you remain responsible for verifying the value before ' +
  'submitting the claim.'

const NO_INDEX_TEXT =
  'No indexed KM value is recorded for this station pair in the active FRV ' +
  'Index (KM) matrix. Enter the distance manually. The recall claim total is ' +
  'still produced from the value you enter below.'

// ── Styles (kept inline to match the rest of ClaimForm) ─────────────────────

const S = {
  label: {
    display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#9ca3af',
    textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px',
  },
  input: {
    width: '100%', padding: '10px 12px', background: '#111',
    border: '1px solid #333', borderRadius: '8px', color: '#e5e7eb',
    fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box',
  },
  help:  { marginTop: '4px', fontSize: '0.74rem', color: '#6b7280' },
  field: { marginBottom: '16px' },

  estimateBox: {
    background: 'rgba(59,130,246,0.07)',
    border: '1px solid rgba(59,130,246,0.25)',
    borderRadius: '10px', padding: '14px 16px', marginBottom: '10px', fontSize: '0.85rem',
  },
  estimateLabel: {
    fontSize: '0.72rem', fontWeight: 700, color: '#93c5fd',
    textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px',
  },
  estimateKm: { fontSize: '1.1rem', fontWeight: 700, color: '#f9fafb', marginBottom: '10px' },

  disclaimer: {
    background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)',
    borderRadius: '8px', padding: '10px 12px', fontSize: '0.74rem',
    color: '#d97706', lineHeight: 1.5, marginBottom: '12px',
  },

  errorBox: {
    background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
    borderRadius: '8px', padding: '10px 14px', fontSize: '0.8rem',
    color: '#f87171', marginBottom: '10px',
  },

  confirmedBadge: {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    padding: '2px 10px', background: 'rgba(34,197,94,0.1)',
    border: '1px solid rgba(34,197,94,0.3)', borderRadius: '4px',
    fontSize: '0.72rem', fontWeight: 700, color: '#4ade80', marginLeft: '8px',
  },

  btnRow: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '2px' },
  btnPrimary: {
    padding: '8px 16px', background: '#dc2626', border: 'none',
    borderRadius: '6px', color: 'white', fontSize: '0.82rem',
    fontWeight: 600, cursor: 'pointer',
  },
  btnSecondary: {
    padding: '8px 16px', background: 'transparent', border: '1px solid #444',
    borderRadius: '6px', color: '#9ca3af', fontSize: '0.82rem',
    fontWeight: 600, cursor: 'pointer',
  },
  btnLink: {
    padding: '6px 0', background: 'none', border: 'none', color: '#6b7280',
    fontSize: '0.78rem', cursor: 'pointer', textDecoration: 'underline',
  },
}

// ── Component ───────────────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {string}  props.userId
 * @param {object}  props.originStation   Resolved rostered station { id, label, name }
 * @param {object|null} props.destStation Resolved recall station { id, label, name } or null
 * @param {string}  props.value           Current form field value (km, controlled)
 * @param {function} props.onChange       (km: string) => void
 * @param {string}  [props.label]
 */
export default function RecallLegDistanceField({
  userId,
  originStation,
  destStation,
  value,
  onChange,
  onRoutingMeta,
  label = 'Rostered to Recall Station (one way, km)',
}) {
  const emitMeta = (km, source, versionId, versionLbl) => {
    if (typeof onRoutingMeta === 'function') {
      onRoutingMeta({
        source,
        km: Number(km),
        matrixVersionId:  versionId || null,
        matrixVersionLbl: versionLbl || null,
        calculatedAt:     new Date().toISOString(),
      })
    }
  }
  // ── State ────────────────────────────────────────────────────────────────
  // phases: idle | loading | show_estimate | confirmed | editing |
  //         no_index | error | manual
  const [phase, setPhase]           = useState('idle')
  const [estimatedKm, setEstimatedKm] = useState(null)
  const [editValue, setEditValue]   = useState('')
  const [errorMsg, setErrorMsg]     = useState(null)
  const [versionLabel, setVersionLabel] = useState(null)

  // Tracks the most recent pair the form intends to estimate. Async callers
  // check this on resolution to bail out if a newer pair has superseded them
  // — this prevents stale results from overwriting fresher state.
  const latestKey = useRef(null)
  // Remember the last pair we *successfully* applied to value, so we don't
  // overwrite a user-entered/edited value when fields re-render.
  const appliedPair = useRef(null) // string key

  // Reset whenever either station changes — including when one becomes null.
  useEffect(() => {
    const originId = originStation?.id ?? null
    const destId   = destStation?.id   ?? null

    // No origin → fall back to manual entry, never block the claim
    if (originId == null) {
      setPhase('manual')
      return
    }

    // No recognisable recall station → manual entry
    if (destId == null) {
      setPhase('manual')
      return
    }

    const key = `${originId}:${destId}`
    latestKey.current = key

    // Same station → operational rule says distance is 0
    if (originId === destId) {
      onChange('0')
      appliedPair.current = key
      setEstimatedKm(0)
      setVersionLabel(null)
      setPhase('confirmed')
      emitMeta(0, 'self')
      return
    }

    // Different stations — read from the FRV Index (KM) matrix
    triggerLookup(originStation, destStation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originStation?.id, destStation?.id])

  async function triggerLookup(origin, dest) {
    if (!origin || !dest) return
    const key = `${origin.id}:${dest.id}`
    latestKey.current = key

    setPhase('loading')
    setErrorMsg(null)

    try {
      const result = await lookupMatrixKm(origin.id, dest.id)

      // The user may have switched the recall station before the lookup
      // returned — only apply if this result is still relevant.
      if (latestKey.current !== key) return

      if (result == null) {
        // No cell for this pair in the active KM matrix. Controlled warning
        // state — manual entry only, NO silent fallback to a routing API.
        const fallbackVersion = await getActiveMatrixVersion()
        if (latestKey.current !== key) return
        setVersionLabel(fallbackVersion?.label || null)
        setEstimatedKm(null)
        setPhase('no_index')
        return
      }

      const km = Number(result.value)
      setEstimatedKm(km)
      setVersionLabel(result.versionLabel || null)
      // Surface the indexed value immediately. The user can still edit /
      // override via the inline input, and the form value flows into the
      // recall total through the standard distStnKm onChange.
      onChange(String(km))
      appliedPair.current = key
      setPhase('show_estimate')
      emitMeta(km, 'index_km', result.versionId, result.versionLabel)
    } catch (err) {
      if (latestKey.current !== key) return
      setErrorMsg(err?.message || 'Could not read indexed distance. Please enter manually.')
      setPhase('error')
    }
  }

  // ── Confirm / Edit handlers ─────────────────────────────────────────────

  function handleAccept() {
    setPhase('confirmed')
  }

  function handleStartEdit() {
    setEditValue(value || (estimatedKm != null ? String(estimatedKm) : ''))
    setPhase('editing')
  }

  function handleSaveEdit() {
    const km = parseFloat(editValue)
    if (editValue === '' || isNaN(km) || km < 0) return // invalid — stay in editing
    onChange(String(km))
    setPhase('confirmed')
    emitMeta(km, 'manual')
  }

  function handleCancelEdit() {
    if (estimatedKm != null)      setPhase('show_estimate')
    else if (phase === 'editing') setPhase('no_index')
    else                          setPhase('manual')
  }

  function handleRetry() {
    if (originStation && destStation) triggerLookup(originStation, destStation)
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div style={S.field}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '6px' }}>
        <label style={{ ...S.label, marginBottom: 0 }}>{label}</label>
        {phase === 'confirmed' && (
          <span style={S.confirmedBadge}>✓ Confirmed</span>
        )}
      </div>

      {/* Loading */}
      {phase === 'loading' && (
        <div style={{ ...S.estimateBox, display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '16px', height: '16px', border: '2px solid #3b82f6',
            borderTopColor: 'transparent', borderRadius: '50%',
            animation: 'spin 0.8s linear infinite', flexShrink: 0,
          }} />
          <span style={{ color: '#93c5fd', fontSize: '0.85rem' }}>
            Looking up indexed distance…
          </span>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* Indexed value ready */}
      {phase === 'show_estimate' && estimatedKm != null && (
        <div style={S.estimateBox}>
          <div style={S.estimateLabel}>FRV Index (KM) · indexed lookup</div>
          <div style={S.estimateKm}>{estimatedKm} km</div>
          {versionLabel && (
            <div style={{ ...S.help, marginTop: '-4px', marginBottom: '8px' }}>
              Source: {versionLabel}
            </div>
          )}
          <div style={S.disclaimer}>{DISCLAIMER_TEXT}</div>
          <div style={S.btnRow}>
            <button type="button" onClick={handleAccept} style={S.btnPrimary}>
              Accept Indexed Distance
            </button>
            <button type="button" onClick={handleStartEdit} style={S.btnSecondary}>
              Edit Distance
            </button>
            <button type="button" onClick={handleRetry} style={S.btnSecondary}>
              Recalculate
            </button>
          </div>
        </div>
      )}

      {/* No indexed match — controlled warning, manual entry only */}
      {phase === 'no_index' && (
        <>
          <div style={{
            background: 'rgba(251,191,36,0.08)',
            border: '1px solid rgba(251,191,36,0.35)',
            borderRadius: '8px',
            padding: '10px 14px',
            fontSize: '0.8rem',
            color: '#fbbf24',
            marginBottom: '10px',
          }}>
            {NO_INDEX_TEXT}
            {versionLabel && (
              <div style={{ marginTop: '4px', fontSize: '0.72rem', color: '#a16207' }}>
                Active index: {versionLabel}
              </div>
            )}
          </div>
          <input
            type="number" min="0" step="0.1" placeholder="0.0"
            value={value}
            onChange={(e) => { onChange(e.target.value); emitMeta(e.target.value, 'manual') }}
            style={S.input}
          />
          <div style={S.btnRow}>
            <button
              type="button"
              onClick={handleRetry}
              style={{ ...S.btnSecondary, fontSize: '0.78rem', padding: '6px 12px' }}
            >
              Retry Indexed Lookup
            </button>
          </div>
          <p style={S.help}>One-way distance (rostered → recall). Return leg is automatic (×2).</p>
        </>
      )}

      {/* Editing override */}
      {phase === 'editing' && (
        <>
          <input
            type="number" min="0" step="0.1"
            placeholder="Enter distance (km)"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            style={S.input}
            autoFocus
          />
          <div style={S.disclaimer}>{DISCLAIMER_TEXT}</div>
          <div style={S.btnRow}>
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={editValue === '' || parseFloat(editValue) < 0}
              style={{
                ...S.btnPrimary,
                background: (editValue === '' || parseFloat(editValue) < 0) ? '#7f1d1d' : '#dc2626',
                cursor:     (editValue === '' || parseFloat(editValue) < 0) ? 'not-allowed' : 'pointer',
              }}
            >
              Confirm Distance
            </button>
            <button type="button" onClick={handleCancelEdit} style={S.btnSecondary}>
              Cancel
            </button>
          </div>
          <p style={S.help}>One-way distance (rostered → recall). Return leg is automatic (×2).</p>
        </>
      )}

      {/* Confirmed — show as inline input with edit/recalc links */}
      {phase === 'confirmed' && (
        <>
          <input
            type="number" min="0" step="0.1"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={{ ...S.input, borderColor: 'rgba(34,197,94,0.4)' }}
          />
          <p style={S.help}>
            Confirmed leg distance.{' '}
            <button type="button" onClick={handleStartEdit} style={S.btnLink}>Edit</button>
            {originStation?.id != null && destStation?.id != null && originStation.id !== destStation.id && (
              <>
                {' · '}
                <button type="button" onClick={handleRetry} style={S.btnLink}>Recalculate</button>
              </>
            )}
          </p>
        </>
      )}

      {/* Error — keep manual input usable */}
      {phase === 'error' && (
        <>
          <div style={S.errorBox}>{errorMsg}</div>
          <input
            type="number" min="0" step="0.1"
            placeholder="Enter distance manually (km)"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={S.input}
          />
          <div style={S.btnRow}>
            <button
              type="button"
              onClick={handleRetry}
              style={{ ...S.btnSecondary, fontSize: '0.78rem', padding: '6px 12px' }}
            >
              Retry Indexed Lookup
            </button>
          </div>
          <p style={S.help}>One-way distance (rostered → recall). Return leg is automatic (×2).</p>
        </>
      )}

      {/* Manual fallback — recall station unknown / unparseable */}
      {phase === 'manual' && (
        <>
          <input
            type="number" min="0" step="0.1" placeholder="0.0"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={S.input}
          />
          <p style={S.help}>
            {originStation?.id == null
              ? 'Set a rostered station in your profile to enable auto-calculation for this leg.'
              : !destStation
              ? 'Enter a known recall station (e.g. "FS44 - Sunshine") to auto-calculate this leg.'
              : 'Leave 0 if recalled to your own rostered station.'}
          </p>
        </>
      )}
    </div>
  )
}
