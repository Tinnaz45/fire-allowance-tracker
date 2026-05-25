// ─── Travel API: Google Maps Driving Distance ────────────────────────────────
// First server-side API route in the codebase. Exists because the Google Maps
// API key MUST NEVER be shipped to the browser. The browser asks this route
// for a deterministic shortest-distance driving route between two coordinates;
// the route enforces the FRV recall/standby/M&D routing rules:
//
//   - mode: driving
//   - avoid: tolls
//   - shortest by DISTANCE (not duration)
//   - departure_time: next 03:00 local Melbourne — used so traffic prediction
//     is effectively zero ("0300 no-traffic methodology")
//
// Auth: the caller MUST forward the Supabase access token (`Authorization:
// Bearer <token>`). The route validates it against the Supabase auth server
// using the anon key; an authenticated user is required to spend Google credit.
// No data is read or written via this client — the auth check is the only
// reason it exists.
//
// Fallback: when Google is unavailable (no key configured, network error, no
// route found) the route transparently falls back to the existing OSRM public
// router so the claim workflow is never blocked. The response includes a
// `source` discriminator so callers can persist routing provenance.
//
// Caching is the CALLER's responsibility — the existing fat.station_distances
// cache + lib/distance/stationDistance.js in-memory caches already handle
// per-user/per-pair memoisation. Caching at the route layer would defeat
// per-user RLS and complicate cache invalidation on home-address changes.
//
// Rate limiting: simple in-memory token bucket per authenticated user, sized
// for human claim entry (60 req / 60 s). Per-instance only — Vercel may run
// multiple isolates, so this is best-effort protection, not abuse prevention.
// The Google API console quota is the hard backstop.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server'
import { createClient }  from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── Config ──────────────────────────────────────────────────────────────────

const RATE_LIMIT_PER_MIN = 60
const MAX_DISTANCE_KM    = 2000   // sanity guard — claims are local
const TIMEOUT_MS         = 8000

const GOOGLE_BASE = 'https://maps.googleapis.com/maps/api/directions/json'
const OSRM_BASE   = 'https://router.project-osrm.org/route/v1/driving'

// In-memory rate-limit map: user_id → { count, windowStart }
const rateMap = new Map()


// ── Helpers ─────────────────────────────────────────────────────────────────

function jsonError(status, code, message, extras = {}) {
  return NextResponse.json({ ok: false, code, message, ...extras }, { status })
}

function jsonOk(body) {
  return NextResponse.json({ ok: true, ...body }, { status: 200 })
}

/**
 * Compute the Unix seconds timestamp of the next 03:00 AM in Australia/
 * Melbourne local time. Used as `departure_time` so Google's traffic model
 * returns essentially no-traffic predictions, matching FRV's "0300
 * methodology" for deterministic route comparison.
 */
function nextMelbourne0300Unix(now = new Date()) {
  // Build a target in Australia/Melbourne wall clock without a heavy tz lib.
  // toLocaleString + Date() is rock-solid for this single conversion.
  const mlb = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }))
  const target = new Date(mlb)
  target.setHours(3, 0, 0, 0)
  if (target.getTime() <= mlb.getTime()) target.setDate(target.getDate() + 1)
  // Offset between the synthetic Melbourne-clock Date and the real UTC clock
  // gives us the absolute Unix seconds for that wall-clock instant.
  const offsetMs = now.getTime() - mlb.getTime()
  return Math.floor((target.getTime() + offsetMs) / 1000)
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n)
}

function validCoord(p) {
  return p && isFiniteNumber(p.lat) && isFiniteNumber(p.lng) &&
         p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180
}

function pickShortestRoute(routes) {
  let best = null
  for (const r of routes || []) {
    const leg = r?.legs?.[0]
    if (!leg) continue
    const meters = Number(leg.distance?.value)
    if (!isFinite(meters) || meters <= 0) continue
    if (best == null || meters < best.meters) {
      best = {
        meters,
        seconds: Number(leg.duration?.value) || 0,
        summary: r.summary || null,
        warnings: r.warnings || [],
      }
    }
  }
  return best
}

async function fetchWithTimeout(url, opts = {}, ms = TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function routeViaGoogle({ from, to }) {
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) return { ok: false, reason: 'no_key' }

  const url = new URL(GOOGLE_BASE)
  url.searchParams.set('origin',          `${from.lat},${from.lng}`)
  url.searchParams.set('destination',     `${to.lat},${to.lng}`)
  url.searchParams.set('mode',            'driving')
  url.searchParams.set('avoid',           'tolls')
  url.searchParams.set('alternatives',    'true')
  url.searchParams.set('departure_time',  String(nextMelbourne0300Unix()))
  url.searchParams.set('traffic_model',   'best_guess')
  url.searchParams.set('units',           'metric')
  url.searchParams.set('region',          'au')
  url.searchParams.set('key',             key)

  let res
  try {
    res = await fetchWithTimeout(url.toString(), { method: 'GET', headers: { Accept: 'application/json' } })
  } catch (err) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'network_error' }
  }
  if (!res.ok) return { ok: false, reason: `http_${res.status}` }

  let json
  try { json = await res.json() }
  catch { return { ok: false, reason: 'bad_json' } }

  if (json.status !== 'OK') {
    return { ok: false, reason: `google_${json.status}`, message: json.error_message }
  }

  const best = pickShortestRoute(json.routes)
  if (!best) return { ok: false, reason: 'no_route' }
  if (best.meters / 1000 > MAX_DISTANCE_KM) {
    return { ok: false, reason: 'too_far' }
  }

  return {
    ok:        true,
    source:    'google',
    distanceKm: Math.round((best.meters / 1000) * 10) / 10,
    durationSeconds: best.seconds,
    summary:   best.summary,
    warnings:  best.warnings,
    routeCount: json.routes.length,
  }
}

async function routeViaOsrm({ from, to }) {
  const path = `${from.lng},${from.lat};${to.lng},${to.lat}`
  const url  = `${OSRM_BASE}/${path}?overview=false&alternatives=false&steps=false`

  let res
  try {
    res = await fetchWithTimeout(url, { method: 'GET', headers: { Accept: 'application/json' } })
  } catch (err) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'network_error' }
  }
  if (!res.ok) return { ok: false, reason: `http_${res.status}` }

  let json
  try { json = await res.json() }
  catch { return { ok: false, reason: 'bad_json' } }

  if (json.code !== 'Ok' || !Array.isArray(json.routes) || json.routes.length === 0) {
    return { ok: false, reason: 'no_route' }
  }
  const meters  = Number(json.routes[0].distance)
  const seconds = Number(json.routes[0].duration)
  if (!isFinite(meters) || meters <= 0) return { ok: false, reason: 'invalid_distance' }

  return {
    ok:        true,
    source:    'osrm-fallback',
    distanceKm: Math.round((meters / 1000) * 10) / 10,
    durationSeconds: isFinite(seconds) ? seconds : 0,
    summary:   null,
    warnings:  [],
  }
}


// ── Auth + Rate limit ──────────────────────────────────────────────────────

async function authenticate(req) {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization')
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return { ok: false, status: 401, code: 'missing_token' }
  }
  const token = authHeader.slice(7).trim()
  if (!token) return { ok: false, status: 401, code: 'missing_token' }

  const url     = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    return { ok: false, status: 500, code: 'server_misconfigured' }
  }
  const client = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data, error } = await client.auth.getUser(token)
  if (error || !data?.user) {
    return { ok: false, status: 401, code: 'invalid_token' }
  }
  return { ok: true, userId: data.user.id }
}

function rateLimit(userId) {
  const now = Date.now()
  const window = 60_000
  const entry = rateMap.get(userId)
  if (!entry || now - entry.windowStart > window) {
    rateMap.set(userId, { count: 1, windowStart: now })
    return { ok: true, remaining: RATE_LIMIT_PER_MIN - 1 }
  }
  if (entry.count >= RATE_LIMIT_PER_MIN) {
    return { ok: false, retryAfterMs: window - (now - entry.windowStart) }
  }
  entry.count++
  return { ok: true, remaining: RATE_LIMIT_PER_MIN - entry.count }
}


// ── Handler ────────────────────────────────────────────────────────────────

export async function POST(req) {
  const auth = await authenticate(req)
  if (!auth.ok) return jsonError(auth.status, auth.code, 'Not authenticated.')

  const rl = rateLimit(auth.userId)
  if (!rl.ok) {
    return jsonError(429, 'rate_limited', 'Too many travel lookups; slow down.', {
      retryAfterMs: rl.retryAfterMs,
    })
  }

  let body
  try { body = await req.json() }
  catch { return jsonError(400, 'bad_json', 'Request body must be JSON.') }

  const { from, to } = body || {}
  if (!validCoord(from) || !validCoord(to)) {
    return jsonError(400, 'bad_coords', 'from/to must be valid {lat,lng} objects.')
  }

  // Try Google first. On any failure, fall through to OSRM so the recall /
  // standby workflow is never blocked when Google has issues.
  const googleResult = await routeViaGoogle({ from, to })
  if (googleResult.ok) {
    return jsonOk({
      distanceKm:      googleResult.distanceKm,
      durationSeconds: googleResult.durationSeconds,
      source:          googleResult.source,
      summary:         googleResult.summary,
      warnings:        googleResult.warnings,
      routeCount:      googleResult.routeCount,
    })
  }

  const osrmResult = await routeViaOsrm({ from, to })
  if (osrmResult.ok) {
    return jsonOk({
      distanceKm:      osrmResult.distanceKm,
      durationSeconds: osrmResult.durationSeconds,
      source:          osrmResult.source,
      googleFailureReason: googleResult.reason,
    })
  }

  return jsonError(502, 'route_unavailable',
    'No driving route available from either provider.',
    { google: googleResult.reason, osrm: osrmResult.reason })
}

// Convenience: tell anyone GETting this endpoint how it actually works.
export async function GET() {
  return NextResponse.json(
    { ok: false, code: 'method_not_allowed', message: 'POST {from:{lat,lng}, to:{lat,lng}}' },
    { status: 405 }
  )
}
