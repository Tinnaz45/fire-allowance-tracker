'use client'

// ─── MdDistanceField ─────────────────────────────────────────────────────────
// Muster & Dismiss petty-cash distance field. Implements the CONFIRMED rule:
//
//     payable one-way km = max(0, A − B)
//       A = Home → Rostered Station (one-way km)
//       B = Home → M&D Station      (one-way km)
//
// Petty cash = payableKm × kilometre rate (NO return-leg doubling).
//
// This REPLACES the previous M&D behaviour (rostered↔M&D round-trip × 2, home
// ignored). It reuses the SAME home geocode/route source used by Recall
// (lib/distance/distanceEstimator → resolveTravelBaseline): a read-only,
// non-persisting lookup that never clobbers a user's confirmed Recall station
// distance. Both legs originate at the profile home address.
//
// The FRV matrix HOURS figure is intentionally NOT computed here — that value is
// a payroll-comparison entitlement owned by the canonical engine and must never
// be mistaken for the petty-cash km. See lib/fat/engine/generators/musterDismiss.js.
//
// Contract with the parent (StandbyInputs):
//   - `value` is the payable-km string; it drives travel reimbursement via the
//     existing dist_km column (calcStandbyClaim treats M&D dist_km as payable km).
//   - onRoutingMeta({ homeToRosteredKm, homeToMdKm, payableKm, source,
//     calculatedAt, mode:'home_diff' }) carries provenance for persistence.
//
// Graceful degradation: if the home address or either station is missing, or a
// lookup fails, the field falls back to manual entry of the payable km so the
// claim form is never blocked.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react'

import { resolveTravelBaseline } from '@/lib/distance/distanceEstimator'
import { normaliseAddress } from '@/lib/distance/addressCache'
import { calcMdPayableKm } from '@/lib/calculations/engine'

// ── Styles (match StandbyDistanceField) ──────────────────────────────────────

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
  row:      { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' },
  rowLabel: { fontSize: '0.72rem', fontWeight: 700, color: '#93c5fd', textTransform: 'uppercase', letterSpacing: '0.05em' },
  rowValue: { fontSize: '0.95rem', fontWeight: 700, color: '#f9fafb' },
  payable:  { fontSize: '1.15rem', fontWeight: 800, color: '#f9fafb' },
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
    borderRadius: '6px', color: 'white', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer',
  },
  btnSecondary: {
    padding: '8px 16px', background: 'transparent', border: '1px solid #444',
    borderRadius: '6px', color: '#9ca3af', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer',
  },
}

const DISCLAIMER =
  'Petty-cash kilometres = max(0, Home→Rostered − Home→M&D). Distances are ' +
  'best-effort driving estimates from your profile home address — verify against ' +
  'your actual travel before submitting.'

const round1 = (n) => Math.round(Number(n) * 10) / 10

/**
 * @param {object} props
 * @param {string}      props.userId
 * @param {object|null} props.rosterStation   Resolved { id, name, label }
 * @param {object|null} props.mdStation       Resolved { id, name, label } (M&D destination)
 * @param {string}      props.homeAddress     Profile home address text
 * @param {boolean}     [props.profileLoading]
 * @param {string}      props.value           Payable-km value (controlled)
 * @param {(km:string) => void} props.onChange
 * @param {(meta:object) => void} [props.onRoutingMeta]
 */
export default function MdDistanceField({
  userId,
  rosterStation,
  mdStation,
  homeAddress,
  profileLoading = false,
  value,
  onChange,
  onRoutingMeta,
}) {
  const [phase, setPhase]     = useState('idle')  // idle | loading | ready | error | manual
  const [aKm, setAKm]         = useState(null)    // Home → Rostered (one-way)
  const [bKm, setBKm]         = useState(null)    // Home → M&D (one-way)
  const [source, setSource]   = useState(null)
  const [errorMsg, setError]  = useState(null)
  const [editing, setEditing] = useState(false)

  const latestKey = useRef(null)

  const emitMeta = (meta) => {
    if (typeof onRoutingMeta === 'function') {
      onRoutingMeta({ mode: 'home_diff', calculatedAt: new Date().toISOString(), ...meta })
    }
  }

  const homeHash = normaliseAddress(homeAddress || '')

  useEffect(() => {
    const rosterId = rosterStation?.id ?? null
    const mdId     = mdStation?.id ?? null
    const home     = (homeAddress || '').trim()

    // Need home + both stations to auto-calculate. Otherwise fall back to manual.
    if (profileLoading || !userId || !home || rosterId == null || mdId == null) {
      setPhase('manual')
      return
    }

    const key = `${rosterId}:${mdId}:${homeHash}`
    latestKey.current = key

    setPhase('loading')
    setError(null)
    setAKm(null); setBKm(null); setSource(null)
    ;(async () => {
      // Two independent home-origin lookups. resolveTravelBaseline is read-only
      // (never persists) so it cannot clobber the Recall confirmed distance.
      const [aRes, bRes] = await Promise.all([
        resolveTravelBaseline(userId, { id: rosterId, name: rosterStation.name }, home).catch((err) => ({ _error: err })),
        resolveTravelBaseline(userId, { id: mdId,     name: mdStation.name },     home).catch((err) => ({ _error: err })),
      ])

      if (latestKey.current !== key) return

      const a = aRes && !aRes._error && Number.isFinite(aRes.km) ? aRes.km : null
      const b = bRes && !bRes._error && Number.isFinite(bRes.km) ? bRes.km : null

      if (a == null || b == null) {
        setError(
          (aRes?._error?.message) ||
          (bRes?._error?.message) ||
          'Could not estimate one or both home distances. Enter payable km manually.'
        )
        setPhase('error')
        return
      }

      const payableKm = calcMdPayableKm({ homeToRosteredKm: a, homeToMdKm: b })
      const src = aRes.source || bRes.source || 'estimate'

      setAKm(a); setBKm(b); setSource(src)
      onChange(String(payableKm))
      emitMeta({ homeToRosteredKm: round1(a), homeToMdKm: round1(b), payableKm, source: src })
      setPhase('ready')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, rosterStation?.id, mdStation?.id, homeHash, profileLoading])

  // ── Render helpers ──────────────────────────────────────────────────────────

  function renderManualInput(message) {
    return (
      <>
        <input
          type="number" min="0" step="0.1" placeholder="0.0"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          style={S.input}
        />
        <p style={S.help}>{message}</p>
      </>
    )
  }

  function manualMessage() {
    if (profileLoading) return 'Loading your profile…'
    if (!homeAddress || !homeAddress.trim()) return 'Set your home address in your profile to auto-calculate Home→Rostered − Home→M&D.'
    if (rosterStation?.id == null) return 'Set a rostered station to enable auto-calculation.'
    if (mdStation?.id == null) return 'Enter the M&D station to enable auto-calculation.'
    return 'Enter the payable km (max(0, Home→Rostered − Home→M&D)).'
  }

  function renderReadyPanel() {
    const payableKm = calcMdPayableKm({ homeToRosteredKm: aKm, homeToMdKm: bKm })
    const floored = aKm != null && bKm != null && (aKm - bKm) <= 0
    return (
      <>
        <div style={S.panel}>
          <div style={S.row}>
            <span style={S.rowLabel}>A · Home → Rostered</span>
            <span style={S.rowValue}>{round1(aKm)} km</span>
          </div>
          <div style={S.row}>
            <span style={S.rowLabel}>B · Home → M&D</span>
            <span style={S.rowValue}>{round1(bKm)} km</span>
          </div>
          <div style={{ height: '1px', background: 'rgba(148,163,184,0.2)', margin: '10px 0' }} />
          <div style={S.row}>
            <span style={S.rowLabel}>Payable · max(0, A − B)</span>
            <span style={S.payable}>{payableKm} km</span>
          </div>
          {floored && (
            <p style={{ ...S.help, color: '#d97706' }}>
              M&D station is at least as far from home as your rostered station — payable floored to 0 km.
            </p>
          )}
          <p style={S.help}>
            {source === 'osrm' ? 'via OpenStreetMap routing' : 'via Google Maps routing'}. Petty cash = payable km × km rate.
          </p>

          <div style={S.disclaimer}>{DISCLAIMER}</div>

          <div style={S.btnRow}>
            <button type="button" onClick={() => setEditing(true)} style={S.btnSecondary}>
              Edit payable km
            </button>
          </div>
        </div>

        {editing && (
          <>
            <input
              type="number" min="0" step="0.1" placeholder="Payable km"
              value={value || ''}
              onChange={(e) => onChange(e.target.value)}
              style={S.input}
              autoFocus
            />
            <div style={S.btnRow}>
              <button type="button" onClick={() => setEditing(false)} style={S.btnPrimary}>
                Done
              </button>
            </div>
            <p style={S.help}>Manual override is saved on submit. Petty cash = payable km × km rate.</p>
          </>
        )}
      </>
    )
  }

  return (
    <div style={S.field}>
      <label style={S.label}>Petty-Cash Distance · Home→Rostered − Home→M&D</label>

      {phase === 'loading' && (
        <div style={S.panel}>
          <span style={{ color: '#93c5fd', fontSize: '0.85rem' }}>
            Estimating Home→Rostered and Home→M&D distances…
          </span>
        </div>
      )}

      {phase === 'error' && (
        <>
          <div style={S.errorBox}>{errorMsg}</div>
          {renderManualInput('Auto-estimate unavailable — enter the payable km manually.')}
        </>
      )}

      {phase === 'manual' && renderManualInput(manualMessage())}
      {phase === 'ready'  && renderReadyPanel()}
      {phase === 'idle'   && renderManualInput(manualMessage())}
    </div>
  )
}
