'use client'

// ─── TravelBaselineCard ──────────────────────────────────────────────────────
// Informational Profile card: shows the one-way driving distance and one-way
// travel time between the user's Home address and their Rostered Station.
//
// It is display-only — it never feeds entitlement calculations and never
// persists anything. The numbers come from the app's existing travel source
// (resolveTravelBaseline → /api/travel/google, with the same OSRM fallback the
// rest of the app uses) and are rendered through the shared round-up rules in
// lib/distance/travelFormat.js (distance → next whole km, time → next whole
// minute).
//
// Home address and station details are deliberately NOT repeated here — they
// already appear in their own cards on the Profile page. This card shows only
// the two derived values.
//
// Recalculation: a debounced effect re-runs whenever the (normalised) home
// address or the rostered station id changes, with an in-flight token + abort
// so rapid edits never race a stale result onto the screen.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react'
import { resolveTravelBaseline } from '@/lib/distance/distanceEstimator'
import { normaliseAddress } from '@/lib/distance/addressCache'
import { formatTravelDistanceKm, formatTravelTimeWithHours } from '@/lib/distance/travelFormat'

const S = {
  card: { background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: '16px', padding: '24px', marginBottom: '20px' },
  cardTitle: { margin: '0 0 4px 0', fontSize: '0.95rem', fontWeight: 700, color: '#f9fafb' },
  subtitle: { margin: '0 0 20px 0', fontSize: '0.78rem', color: '#6b7280', borderBottom: '1px solid #2a2a2a', paddingBottom: '12px' },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  metric: { background: '#111', border: '1px solid #2a2a2a', borderRadius: '10px', padding: '14px 16px' },
  metricLabel: { display: 'block', fontSize: '0.72rem', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' },
  metricValue: { fontSize: '1.3rem', fontWeight: 700, color: '#f9fafb', lineHeight: 1.2 },
  metricValueMuted: { fontSize: '1.3rem', fontWeight: 700, color: '#4b5563', lineHeight: 1.2 },
  hint: { fontSize: '0.8rem', color: '#6b7280', lineHeight: 1.5 },
  error: { fontSize: '0.8rem', color: '#f87171', lineHeight: 1.5 },
}

// Distinguish "we can't compute yet" (missing inputs) from "computing" / "ready".
const STATE = Object.freeze({ IDLE: 'idle', LOADING: 'loading', READY: 'ready', ERROR: 'error' })

export default function TravelBaselineCard({ userId, station, homeAddress, profileLoading }) {
  const [state, setState]   = useState(STATE.IDLE)
  const [result, setResult] = useState(null)   // { km, durationSeconds|null }
  const [error, setError]   = useState(null)

  const tokenRef = useRef(0)

  const canResolve = Boolean(
    !profileLoading && userId && station?.id && homeAddress && homeAddress.trim()
  )

  // Restart only when the inputs that actually change the route change. We key
  // on the normalised home text so cosmetic whitespace edits don't re-fetch.
  const homeHash = normaliseAddress(homeAddress || '')

  useEffect(() => {
    if (!canResolve) {
      setState(STATE.IDLE)
      setResult(null)
      setError(null)
      return
    }

    const myToken = ++tokenRef.current
    const ctrl    = new AbortController()

    // Debounce so typing a home address doesn't fire a geocode per keystroke.
    const timer = setTimeout(() => {
      setState(STATE.LOADING)
      setError(null)
      resolveTravelBaseline(userId, station, homeAddress, { signal: ctrl.signal })
        .then((r) => {
          if (tokenRef.current !== myToken) return
          setResult({ km: r.km, durationSeconds: r.durationSeconds })
          setState(STATE.READY)
        })
        .catch((err) => {
          if (tokenRef.current !== myToken) return
          if (err?.name === 'AbortError') return
          console.error('[TravelBaselineCard] resolveTravelBaseline:', err)
          setError(err.message || 'Unable to calculate travel baseline.')
          setState(STATE.ERROR)
        })
    }, 500)

    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canResolve, userId, station?.id, homeHash])

  const distanceText = state === STATE.READY ? formatTravelDistanceKm(result?.km) : null
  const timeText     = state === STATE.READY ? formatTravelTimeWithHours(result?.durationSeconds) : null

  return (
    <div style={S.card}>
      <h2 style={S.cardTitle}>Home to Rostered Station</h2>
      <p style={S.subtitle}>Estimated one-way driving baseline. Informational only.</p>

      {state === STATE.IDLE && (
        <p style={S.hint}>
          {profileLoading
            ? 'Loading your profile…'
            : !station?.id
              ? 'Set a rostered station above to see your travel baseline.'
              : 'Set your home address above to see your travel baseline.'}
        </p>
      )}

      {state === STATE.ERROR && (
        <p style={S.error}>Couldn&rsquo;t calculate travel baseline: {error}</p>
      )}

      {(state === STATE.LOADING || state === STATE.READY) && (
        <div style={S.grid}>
          <div style={S.metric}>
            <span style={S.metricLabel}>One-Way Distance</span>
            <span style={state === STATE.READY && distanceText ? S.metricValue : S.metricValueMuted}>
              {state === STATE.LOADING ? '…' : (distanceText || '—')}
            </span>
          </div>
          <div style={S.metric}>
            <span style={S.metricLabel}>One-Way Travel Time</span>
            <span style={state === STATE.READY && timeText ? S.metricValue : S.metricValueMuted}>
              {state === STATE.LOADING ? '…' : (timeText || '—')}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
