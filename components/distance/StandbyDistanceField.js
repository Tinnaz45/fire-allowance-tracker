'use client'

// ─── StandbyDistanceField ────────────────────────────────────────────────────
// Dual-output distance field for Standby / Muster & Dismiss claims. Produces:
//
//   1. Google Maps KM (rostered ↔ standby station, return total)
//        – used for petty-cash reimbursement on the existing dist_km column.
//        – avoid tolls, shortest route by distance, 0300 traffic methodology
//          (enforced server-side in /api/travel/google).
//
//   2. FRV matrix decimal hours (rostered ↔ standby station, bidirectional)
//        – read from the active fat.travel_matrix_versions / cells via the
//          fat.travel_matrix_lookup RPC.
//        – used ONLY for payroll comparison; NEVER drives reimbursement.
//
// Both outputs are visual + persisted side-by-side. Either output can be
// missing (matrix gap, no Google key, etc.) and the field gracefully degrades
// to manual entry of the existing return-km field. The manual workflow is
// always available so the claim form is never blocked.
//
// The parent is expected to own `value` (return-km string, drives travel
// reimbursement) and to capture `onRoutingMeta({ googleKmOneway, googleKmReturn,
// matrixHours, matrixVersionId, source, calculatedAt })` for persistence.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react'

import { getStationToStationDistance } from '@/lib/distance/stationDistance'
import { lookupMatrixHours, getActiveMatrixVersion } from '@/lib/distance/matrix/matrixClient'

// ── Styles (match existing distance fields) ─────────────────────────────────

const S = {
  field: { marginBottom: '16px' },
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
  panel: {
    background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.25)',
    borderRadius: '10px', padding: '14px 16px', marginBottom: '10px', fontSize: '0.85rem',
  },
  rowLabel: {
    fontSize: '0.72rem', fontWeight: 700, color: '#93c5fd',
    textTransform: 'uppercase', letterSpacing: '0.05em',
  },
  rowValue: { fontSize: '1.05rem', fontWeight: 700, color: '#f9fafb' },
  rowMeta:  { fontSize: '0.72rem', color: '#9ca3af', marginTop: '2px' },
  disclaimer: {
    background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)',
    borderRadius: '8px', padding: '10px 12px', fontSize: '0.74rem',
    color: '#d97706', lineHeight: 1.5, marginTop: '10px',
  },
  errorBox: {
    background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
    borderRadius: '8px', padding: '10px 14px', fontSize: '0.8rem',
    color: '#f87171', marginBottom: '10px',
  },
  btnRow:    { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' },
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
}

const DISCLAIMER =
  'Distance + matrix figures are reference values. Verify against your operational ' +
  'travel for petty cash, and against payroll for travel-time comparison.'


// ── Component ───────────────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {string}      props.userId
 * @param {object|null} props.rosterStation   Resolved { id, label, name }
 * @param {object|null} props.standbyStation  Resolved { id, label, name } or null
 * @param {string}      props.value           Return-km value (controlled)
 * @param {(km:string) => void} props.onChange
 * @param {(meta:object) => void} [props.onRoutingMeta]
 */
export default function StandbyDistanceField({
  userId,
  rosterStation,
  standbyStation,
  value,
  onChange,
  onRoutingMeta,
}) {
  const [phase, setPhase]   = useState('idle')   // idle | loading | ready | error | manual
  const [googleKm, setGoogle]   = useState(null) // one-way km from Google
  const [matrixHours, setHours] = useState(null) // decimal hours from matrix
  const [matrixVersion, setVersion] = useState(null) // { id, label }
  const [errorMsg, setErrorMsg]   = useState(null)
  const [editingReturn, setEditingReturn] = useState(false)

  const latestKey = useRef(null)

  const emitMeta = (meta) => {
    if (typeof onRoutingMeta === 'function') {
      onRoutingMeta({ calculatedAt: new Date().toISOString(), ...meta })
    }
  }

  useEffect(() => {
    const originId = rosterStation?.id  ?? null
    const destId   = standbyStation?.id ?? null

    if (originId == null || destId == null) {
      setPhase('manual')
      return
    }

    const key = `${originId}:${destId}`
    latestKey.current = key

    if (originId === destId) {
      // Same station — both outputs are zero. Surface immediately.
      setGoogle(0); setHours(0); setVersion(null)
      onChange('0')
      setPhase('ready')
      emitMeta({
        googleKmOneway: 0, googleKmReturn: 0,
        matrixHours:    0, matrixVersionId: null,
        source: 'self',
      })
      return
    }

    setPhase('loading')
    setErrorMsg(null)
    setGoogle(null); setHours(null); setVersion(null)
    ;(async () => {
      // Run both lookups in parallel — independent failures don't block the
      // other output. Matrix can be missing (sparse) without breaking Google,
      // and Google can fall back to OSRM without affecting matrix.
      const [googleResult, matrixResult, versionInfo] = await Promise.all([
        getStationToStationDistance({
          userId,
          originStationId: originId,
          originName:      rosterStation.name,
          originLabel:     rosterStation.label,
          destStationId:   destId,
          destName:        standbyStation.name,
          destLabel:       standbyStation.label,
        }).catch((err) => ({ _error: err })),
        lookupMatrixHours(originId, destId).catch((err) => ({ _error: err })),
        getActiveMatrixVersion().catch(() => null),
      ])

      if (latestKey.current !== key) return

      let google = null
      let routingSource = null
      let hours  = null
      let versionId   = null
      let versionLbl  = null

      if (googleResult && !googleResult._error && typeof googleResult.distanceKm === 'number') {
        google        = googleResult.distanceKm
        routingSource = googleResult.routingSource || 'google'
      }
      if (matrixResult && !matrixResult._error && typeof matrixResult.value === 'number') {
        hours      = matrixResult.value
        versionId  = matrixResult.versionId
        versionLbl = matrixResult.versionLabel
      } else if (versionInfo) {
        versionId  = versionInfo.id
        versionLbl = versionInfo.label
      }

      setGoogle(google)
      setHours(hours)
      setVersion(versionId ? { id: versionId, label: versionLbl } : null)

      if (google == null && hours == null) {
        setErrorMsg(googleResult?._error?.message || 'Could not look up travel distance or hours.')
        setPhase('error')
        return
      }

      // Set the parent return-km field from Google (return total = oneway × 2).
      // If Google failed but the user previously typed a return value we leave
      // it alone — manual override is preserved.
      const returnKm = google != null ? Math.round(google * 2 * 10) / 10 : null
      if (returnKm != null) onChange(String(returnKm))

      emitMeta({
        googleKmOneway:   google,
        googleKmReturn:   returnKm,
        matrixHours:      hours,
        matrixVersionId:  versionId,
        matrixVersionLbl: versionLbl,
        source:           routingSource || (google != null ? 'google' : null),
      })
      setPhase('ready')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, rosterStation?.id, standbyStation?.id])

  // ── Render helpers ────────────────────────────────────────────────────────

  function renderManualInput() {
    return (
      <>
        <input
          type="number" min="0" step="0.1" placeholder="0.0"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          style={S.input}
        />
        <p style={S.help}>
          {rosterStation?.id == null
            ? 'Set a rostered station in your profile to enable auto-calculation.'
            : !standbyStation
              ? 'Enter the standby/M&D station to enable auto-calculation.'
              : 'Enter the total return km (both legs combined).'}
        </p>
      </>
    )
  }

  function renderReadyPanel() {
    const returnKm = googleKm != null ? Math.round(googleKm * 2 * 10) / 10 : null
    return (
      <>
        <div style={S.panel}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={S.rowLabel}>Google Maps · KM</span>
            {googleKm != null && (
              <span style={S.rowMeta}>shortest, avoid tolls, 03:00 model</span>
            )}
          </div>
          <div style={S.rowValue}>
            {googleKm != null
              ? `${returnKm} km return  ·  ${googleKm} km one-way`
              : 'Unavailable — manual entry below.'}
          </div>

          <div style={{
            height: '1px', background: 'rgba(148,163,184,0.2)',
            margin: '12px 0',
          }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={S.rowLabel}>FRV Matrix · Hours</span>
            {matrixVersion?.label && (
              <span style={S.rowMeta}>version: {matrixVersion.label}</span>
            )}
          </div>
          <div style={S.rowValue}>
            {matrixHours != null
              ? `${matrixHours.toFixed(2)} hr (payroll comparison only)`
              : 'No cell in active matrix for this pair.'}
          </div>

          <div style={S.disclaimer}>{DISCLAIMER}</div>

          <div style={S.btnRow}>
            <button type="button" onClick={() => setEditingReturn(true)} style={S.btnSecondary}>
              Edit Return km
            </button>
          </div>
        </div>

        {editingReturn && (
          <>
            <input
              type="number" min="0" step="0.1"
              placeholder="Return km"
              value={value || ''}
              onChange={(e) => onChange(e.target.value)}
              style={S.input}
              autoFocus
            />
            <div style={S.btnRow}>
              <button type="button" onClick={() => setEditingReturn(false)} style={S.btnPrimary}>
                Done
              </button>
            </div>
            <p style={S.help}>Return-km override is saved on submit. Reimbursement = return-km × km rate.</p>
          </>
        )}
      </>
    )
  }

  return (
    <div style={S.field}>
      <label style={S.label}>Distance · Rostered ↔ Standby Station</label>

      {phase === 'loading' && (
        <div style={S.panel}>
          <span style={{ color: '#93c5fd', fontSize: '0.85rem' }}>
            Looking up Google KM + FRV matrix hours…
          </span>
        </div>
      )}

      {phase === 'error' && (
        <>
          <div style={S.errorBox}>{errorMsg}</div>
          {renderManualInput()}
        </>
      )}

      {phase === 'manual' && renderManualInput()}
      {phase === 'ready'  && renderReadyPanel()}
      {phase === 'idle'   && renderManualInput()}
    </div>
  )
}
