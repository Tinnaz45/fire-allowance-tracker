// ─── Google Routing Client ───────────────────────────────────────────────────
// Browser helper that calls the server-side /api/travel/google route. Acts as
// a drop-in replacement for lib/distance/osrm.js#routeDistanceKm but with
// avoid-tolls + shortest-by-distance + 0300 traffic methodology enforced
// server-side (where the Google API key lives).
//
// Identity contract:
//   routeShortestKm(from, to) → number (km, one decimal)
//
// Result metadata (source, routeCount, etc.) is returned via the lower-level
// requestRoute(...) call for callers that want to persist routing provenance.
//
// Auth: forwards the current Supabase access token. If no session is active
// the route returns 401 and we surface a clear error so the caller can keep
// the existing manual-entry path available.
//
// Caching is the CALLER's responsibility — this module never memoises so it
// stays compatible with the existing in-memory caches in stationDistance.js
// and the per-user fat.station_distances persistence layer.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '@/lib/supabaseClient'

async function getAccessToken() {
  const { data, error } = await supabase.auth.getSession()
  if (error || !data?.session?.access_token) {
    throw new Error('Not signed in — sign in again to refresh your session.')
  }
  return data.session.access_token
}

/**
 * Low-level request to /api/travel/google. Returns the raw structured payload
 * so callers can persist `source`, `durationSeconds`, etc.
 *
 * @param {{lat:number,lng:number}} from
 * @param {{lat:number,lng:number}} to
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{
 *   distanceKm:number, durationSeconds:number,
 *   source:'google'|'osrm-fallback',
 *   summary?:string|null, warnings?:string[], routeCount?:number,
 *   googleFailureReason?:string,
 * }>}
 */
export async function requestRoute(from, to, opts = {}) {
  if (!from || !to) throw new Error('Invalid coordinates for routing.')

  const token = await getAccessToken()
  const res = await fetch('/api/travel/google', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body:    JSON.stringify({ from, to }),
    signal:  opts.signal,
  })

  let body
  try { body = await res.json() }
  catch { throw new Error('Travel API returned invalid JSON.') }

  if (!res.ok || !body?.ok) {
    const msg = body?.message
      || (body?.code ? `Travel API error (${body.code}).` : 'Travel API error.')
    const err = new Error(msg)
    err.code   = body?.code || `http_${res.status}`
    err.detail = body
    throw err
  }
  return body
}

/**
 * Convenience: just the distance in km. Mirrors lib/distance/osrm.js shape.
 */
export async function routeShortestKm(from, to, opts = {}) {
  const r = await requestRoute(from, to, opts)
  return r.distanceKm
}
