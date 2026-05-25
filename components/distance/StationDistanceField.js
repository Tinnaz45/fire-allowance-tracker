'use client'

// ─── StationDistanceField ────────────────────────────────────────────────────
// Inline field used by ClaimForm (Recall claim type) to populate the one-way
// home-to-rostered-station km value. Behaves as a controlled input from the
// parent's perspective (parent owns the numeric value), but internally runs a
// small phase machine to fetch / display the OSM-based estimate.
//
// Phases:
//   IDLE        — waiting for profile or station info to be ready
//   LOADING     — Nominatim/OSRM call in flight
//   ESTIMATE    — got a fresh number, awaiting user Accept or Edit
//   CONFIRMED   — user accepted (or manually entered + saved). Value is locked
//                 until the user clicks "Edit" again
//   STALE       — cached row exists but home address changed or row flagged;
//                 only "Recalculate" is offered (no auto-accept)
//   ERROR       — geocode/route failed. Manual entry + retry offered
//
// Cache behaviour:
//   - On mount (when userId + station + homeAddress are all present), we call
//     resolveDistance(). That function is cache-first.
//   - "Accept Estimate" calls saveConfirmedDistance with source='auto'.
//   - "Save" (manual edit) calls saveConfirmedDistance with source='manual'.
//   - Manual entry never triggers Nominatim/OSRM.
//
// Loop / re-entrancy guards:
//   - One in-flight token per effect run; a stale token discards its result.
//   - The effect dependency list is intentionally narrow (userId, stationId,
//     homeHash). We do NOT depend on the numeric value the parent holds, so
//     a parent re-render with the same key never restarts the lookup.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react'
import {
  PHASE,
  resolveDistance,
  recalculateDistance,
  getHomeRecordForConfirm,
} from '@/lib/distance/distanceEstimator'
import {
  saveConfirmedDistance,
  normaliseAddress,
} from '@/lib/distance/addressCache'

// ─── Styles (match ClaimForm conventions) ────────────────────────────────────

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

const FIELD       = { marginBottom: '16px' }
const HELP_STYLE  = { marginTop: '4px', fontSize: '0.74rem', color: '#6b7280' }
const BTN_PRIMARY = {
  padding: '8px 14px', background: '#dc2626', border: 'none',
  borderRadius: '6px', color: 'white', fontSize: '0.82rem',
  fontWeight: 600, cursor: 'pointer',
}
const BTN_GHOST = {
  padding: '8px 14px', background: 'transparent',
  border: '1px solid #333', borderRadius: '6px',
  color: '#9ca3af', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer',
}

const BANNER_BASE = {
  padding: '10px 14px', borderRadius: '8px',
  fontSize: '0.78rem', lineHeight: 1.5, marginBottom: '8px',
}

// Map the routing-provider discriminator returned by resolveDistance /
// recalculateDistance into human-readable banner copy. Keep tightly aligned
// with the source values produced by app/api/travel/google/route.js and the
// catch-branch fallback in lib/distance/distanceEstimator.js.
function describeRouteSource(source) {
  switch (source) {
    case 'google':         return 'via Google Maps routing (avoid tolls, shortest distance)'
    case 'osrm-fallback':  return 'via OpenStreetMap routing — Google Maps unavailable, used fallback'
    case 'osrm':           return 'via OpenStreetMap routing (direct fallback)'
    case 'cached':
    case 'auto':           return 'using a previously saved estimate'
    default:               return 'via driving-route estimate'
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function StationDistanceField({
  userId,
  station,           // { id, name, abbreviation? } — required for auto-estimate
  homeAddress,       // current profile home address (string)
  profileLoading,    // true while parent is still loading profile
  value,             // numeric value held by the parent (string, like other ClaimForm inputs)
  onChange,          // (newValueString) => void — emitted on accept / save / manual edit
  onRoutingMeta,     // optional ({ source, km, calculatedAt }) → void — routing provenance for persistence
}) {
  const emitMeta = (km, source) => {
    if (typeof onRoutingMeta === 'function') {
      onRoutingMeta({ source, km: Number(km), calculatedAt: new Date().toISOString() })
    }
  }
  const [phase,   setPhase]   = useState(PHASE.IDLE)
  const [estKm,   setEstKm]   = useState(null)
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState('')           // free-text edit buffer
  const [error,   setError]   = useState(null)
  const [staleReason, setStaleReason] = useState(null)
  // Routing provenance for the visible banner. Mirrors what is plumbed to
  // emitMeta / persisted. Without this the banner would always read the
  // historical "OpenStreetMap" copy even when Google succeeded server-side.
  const [routeSource, setRouteSource] = useState(null)

  // In-flight guard: each effect run gets a fresh token; if the token has
  // changed by the time the promise resolves, we discard the result.
  const tokenRef = useRef(0)

  const canAutoEstimate = Boolean(
    !profileLoading &&
    userId &&
    station?.id &&
    homeAddress && homeAddress.trim()
  )

  // Dependency hash — we restart the lookup only when one of these changes.
  const homeHash = normaliseAddress(homeAddress || '')

  useEffect(() => {
    if (!canAutoEstimate) {
      // Stay idle until parent has the info we need. Once a user is mid-edit
      // we don't want to clobber their draft; only reset if not editing.
      if (!editing) {
        setPhase(PHASE.IDLE)
        setEstKm(null)
        setError(null)
        setStaleReason(null)
      }
      return
    }

    const myToken = ++tokenRef.current
    const ctrl    = new AbortController()

    setPhase(PHASE.LOADING)
    setError(null)
    setStaleReason(null)

    resolveDistance(userId, station, homeAddress, { signal: ctrl.signal })
      .then((result) => {
        if (tokenRef.current !== myToken) return
        if (result.phase === PHASE.CONFIRMED) {
          setEstKm(result.km)
          setRouteSource(result.source || 'cached')
          setPhase(PHASE.CONFIRMED)
          // Sync parent input with the cached confirmed value.
          onChange?.(String(result.km))
          emitMeta(result.km, result.source || 'cached')
        } else if (result.phase === PHASE.ESTIMATE) {
          setEstKm(result.km)
          setRouteSource(result.source || 'google')
          setPhase(PHASE.ESTIMATE)
          emitMeta(result.km, result.source || 'google')
        } else if (result.phase === PHASE.STALE) {
          setEstKm(result.km)
          setStaleReason(result.reason)
          setPhase(PHASE.STALE)
        }
      })
      .catch((err) => {
        if (tokenRef.current !== myToken) return
        if (err?.name === 'AbortError') return
        console.error('[StationDistanceField] resolveDistance:', err)
        setError(err.message || 'Unable to estimate distance.')
        setPhase(PHASE.ERROR)
      })

    return () => {
      ctrl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAutoEstimate, userId, station?.id, homeHash])

  // ─── Actions ───────────────────────────────────────────────────────────────

  const persistConfirmed = async (km, source) => {
    const homeRecord = await getHomeRecordForConfirm(userId)
    if (!homeRecord) throw new Error('Home address record missing.')
    await saveConfirmedDistance(
      userId,
      station.id,
      homeRecord.address_hash,
      homeRecord.address_version,
      estKm ?? km,
      km,
      source,
      null,  // station coords already cached by saveDistanceEstimate
      null,
    )
  }

  const handleAccept = async () => {
    if (estKm == null) return
    try {
      await persistConfirmed(estKm, 'auto')
      onChange?.(String(estKm))
      setPhase(PHASE.CONFIRMED)
      emitMeta(estKm, 'google')
    } catch (err) {
      console.error('[StationDistanceField] accept:', err)
      setError(err.message || 'Could not save confirmed distance.')
    }
  }

  const handleEdit = () => {
    setDraft(value || (estKm != null ? String(estKm) : ''))
    setEditing(true)
  }

  const handleSaveManual = async () => {
    const km = Number(draft)
    if (!isFinite(km) || km <= 0) {
      setError('Enter a distance greater than 0.')
      return
    }
    setError(null)
    try {
      await persistConfirmed(km, 'manual')
      onChange?.(String(km))
      setEstKm(km)
      setEditing(false)
      setPhase(PHASE.CONFIRMED)
      emitMeta(km, 'manual')
    } catch (err) {
      console.error('[StationDistanceField] manual save:', err)
      setError(err.message || 'Could not save distance.')
    }
  }

  const handleCancelEdit = () => {
    setEditing(false)
    setDraft('')
    setError(null)
  }

  const handleRecalculate = async () => {
    if (!canAutoEstimate) return
    const myToken = ++tokenRef.current
    setPhase(PHASE.LOADING)
    setError(null)
    try {
      const result = await recalculateDistance(userId, station, homeAddress)
      if (tokenRef.current !== myToken) return
      setEstKm(result.km)
      setRouteSource(result.source || 'google')
      setStaleReason(null)
      setPhase(PHASE.ESTIMATE)
      emitMeta(result.km, result.source || 'google')
    } catch (err) {
      if (tokenRef.current !== myToken) return
      console.error('[StationDistanceField] recalculate:', err)
      setError(err.message || 'Could not recalculate distance.')
      setPhase(PHASE.ERROR)
    }
  }

  // ─── Render helpers ────────────────────────────────────────────────────────

  const renderManualOnly = (message) => (
    <>
      <input
        type="number" min="0" step="0.1" placeholder="0.0"
        value={value || ''}
        onChange={(e) => onChange?.(e.target.value)}
        style={INPUT_STYLE}
      />
      {message && (
        <div style={{
          ...BANNER_BASE, marginTop: '6px',
          background: 'rgba(107,114,128,0.08)',
          border: '1px solid rgba(107,114,128,0.25)',
          color: '#9ca3af',
        }}>
          {message}
        </div>
      )}
    </>
  )

  // ─── Main render ───────────────────────────────────────────────────────────

  return (
    <div style={FIELD}>
      <label style={LABEL_STYLE}>Home to Rostered Station (one way, km)</label>

      {/* Idle: parent hasn't provided enough info yet → fall back to manual entry */}
      {phase === PHASE.IDLE && (
        profileLoading
          ? renderManualOnly('Loading your profile…')
          : !station?.id
            ? renderManualOnly('Set a rostered station in your profile to enable auto-estimate.')
            : !homeAddress || !homeAddress.trim()
              ? renderManualOnly('Set your home address in your profile to enable auto-estimate.')
              : renderManualOnly(null)
      )}

      {/* Loading */}
      {phase === PHASE.LOADING && (
        <>
          <input
            type="number" disabled placeholder="Estimating…"
            value={value || ''}
            style={{ ...INPUT_STYLE, opacity: 0.6 }}
          />
          <div style={{
            ...BANNER_BASE, marginTop: '6px',
            background: 'rgba(59,130,246,0.08)',
            border: '1px solid rgba(59,130,246,0.25)',
            color: '#93c5fd',
          }}>
            Estimating driving distance from your home address to {station?.name || 'station'}…
          </div>
        </>
      )}

      {/* Estimate (awaiting Accept) */}
      {phase === PHASE.ESTIMATE && !editing && estKm != null && (
        <>
          <input
            type="number" readOnly value={estKm}
            style={{ ...INPUT_STYLE, background: '#0f0f0f' }}
          />
          <div style={{
            ...BANNER_BASE, marginTop: '6px',
            background: 'rgba(251,191,36,0.08)',
            border: '1px solid rgba(251,191,36,0.3)',
            color: '#fbbf24',
          }}>
            Estimated <strong>{estKm} km</strong> (one way) {describeRouteSource(routeSource)}.
            Please confirm or edit — this is a best-effort estimate and may not match
            your actual route.
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button type="button" onClick={handleAccept} style={BTN_PRIMARY}>
              Accept Estimate
            </button>
            <button type="button" onClick={handleEdit} style={BTN_GHOST}>
              Edit Distance
            </button>
            <button type="button" onClick={handleRecalculate} style={BTN_GHOST}>
              Recalculate
            </button>
          </div>
        </>
      )}

      {/* Confirmed */}
      {phase === PHASE.CONFIRMED && !editing && (
        <>
          <input
            type="number" readOnly value={value || (estKm != null ? estKm : '')}
            style={{ ...INPUT_STYLE, background: '#0f0f0f' }}
          />
          <div style={{
            ...BANNER_BASE, marginTop: '6px',
            background: 'rgba(34,197,94,0.08)',
            border: '1px solid rgba(34,197,94,0.3)',
            color: '#4ade80',
          }}>
            Confirmed distance saved. Future Recall claims to {station?.name || 'this station'} will reuse this value.
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button type="button" onClick={handleEdit} style={BTN_GHOST}>
              Edit Distance
            </button>
          </div>
        </>
      )}

      {/* Stale */}
      {phase === PHASE.STALE && !editing && (
        <>
          <input
            type="number" disabled value={estKm != null ? estKm : ''}
            placeholder="—"
            style={{ ...INPUT_STYLE, opacity: 0.6 }}
          />
          <div style={{
            ...BANNER_BASE, marginTop: '6px',
            background: 'rgba(251,146,60,0.08)',
            border: '1px solid rgba(251,146,60,0.3)',
            color: '#fdba74',
          }}>
            Your previous estimate is out of date{staleReason === 'home_address_changed' ? ' because your home address has changed' : ''}.
            Recalculate to continue.
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button type="button" onClick={handleRecalculate} style={BTN_PRIMARY}>
              Recalculate
            </button>
            <button type="button" onClick={handleEdit} style={BTN_GHOST}>
              Edit Manually
            </button>
          </div>
        </>
      )}

      {/* Error */}
      {phase === PHASE.ERROR && !editing && (
        <>
          <input
            type="number" min="0" step="0.1" placeholder="0.0"
            value={value || ''}
            onChange={(e) => onChange?.(e.target.value)}
            style={INPUT_STYLE}
          />
          <div style={{
            ...BANNER_BASE, marginTop: '6px',
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#f87171',
          }}>
            Auto-estimate unavailable: {error || 'unknown error'}. Enter the distance manually, or retry.
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button type="button" onClick={handleRecalculate} style={BTN_GHOST}>
              Retry Auto-Estimate
            </button>
          </div>
        </>
      )}

      {/* Edit mode (shared across phases) */}
      {editing && (
        <>
          <input
            type="number" min="0" step="0.1" placeholder="0.0"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            style={INPUT_STYLE}
            autoFocus
          />
          {error && (
            <div style={{
              ...BANNER_BASE, marginTop: '6px',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#f87171',
            }}>
              {error}
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button type="button" onClick={handleSaveManual} style={BTN_PRIMARY}>
              Save
            </button>
            <button type="button" onClick={handleCancelEdit} style={BTN_GHOST}>
              Cancel
            </button>
          </div>
        </>
      )}

      <p style={HELP_STYLE}>
        One-way distance. Return leg is automatic (x2). Total route = (this x2) + (station-to-station x2).
      </p>
    </div>
  )
}
