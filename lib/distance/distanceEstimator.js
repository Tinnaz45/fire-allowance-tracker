// ─── Distance Estimator ──────────────────────────────────────────────────────
// Orchestrates the cache-first home-to-station distance lookup used by
// StationDistanceField. The estimator is the only module that decides when
// to call out to Nominatim / OSRM; everything else reads from the cache.
//
// Resolution flow (per (user, station)):
//
//   1. Load home cache (fat.home_address).
//   2. If missing or address text differs from current profile address,
//      geocode the new address and upsert. This bumps address_version when
//      the hash changes — which is what marks downstream distances stale.
//   3. Load station cache (fat.station_distances) for this (user, station).
//   4. If a confirmed distance exists AND it is not stale AND its
//      home_address_version matches the current home record → cache hit.
//      Return phase='confirmed' and the confirmed value.
//   5. If a row exists but is stale OR the version mismatches → phase='stale'.
//      Return the previous estimate (if any) but require re-confirmation.
//   6. Otherwise compute: geocode the station (or reuse cached station coords),
//      route via OSRM, persist the estimate, return phase='estimate'.
//
// All network operations are awaited from the caller's effect; the caller is
// expected to track a single in-flight token so React StrictMode double-mount
// can't race two estimates against each other.
// ─────────────────────────────────────────────────────────────────────────────

import {
  normaliseAddress,
  getHomeAddress,
  saveHomeAddress,
  getStationDistance,
  saveDistanceEstimate,
} from '@/lib/distance/addressCache'
import { geocodeAddress, geocodeStation } from '@/lib/distance/nominatim'
import { requestRoute }                   from '@/lib/distance/googleRouting'
import { routeDistanceKm as routeOsrmKm } from '@/lib/distance/osrm'

export const PHASE = Object.freeze({
  IDLE:      'idle',
  LOADING:   'loading',
  ESTIMATE:  'estimate',
  CONFIRMED: 'confirmed',
  STALE:     'stale',
  ERROR:     'error',
})

/**
 * Ensure the home address record exists and matches the current profile
 * address. Returns the canonical home record { lat, lng, address_hash,
 * address_version, geocode_status }. Throws on geocode failure.
 */
async function ensureHomeRecord(userId, currentAddress, opts) {
  const currentHash = normaliseAddress(currentAddress)
  const existing    = await getHomeAddress(userId)

  if (existing && existing.address_hash === currentHash && existing.geocode_status === 'ok') {
    return existing
  }

  // Either no record, the address changed, or a previous attempt failed —
  // geocode fresh. We let exceptions bubble to the caller so the UI can
  // surface a retry button.
  const { lat, lng } = await geocodeAddress(currentAddress, opts)
  const { data }     = await saveHomeAddress(userId, currentAddress, lat, lng, 'ok')
  return data
}

/**
 * Compute and persist a fresh estimate for (user, station).
 * Reuses cached station coordinates when present so we never re-geocode the
 * same station twice for the same user.
 *
 * Routes through the server-side /api/travel/google endpoint first so the
 * Google Maps API key stays server-only. When the user is unauthenticated
 * (no Supabase session) OR the server has no GOOGLE_MAPS_API_KEY configured,
 * the API route transparently falls through to OSRM. We additionally retry
 * against the public OSRM router directly if the API call itself fails, so
 * the legacy keyless cache-first flow is never blocked.
 */
async function computeEstimate(userId, station, homeRecord, existingStationRow, opts) {
  let stationLat = existingStationRow?.station_lat ?? null
  let stationLng = existingStationRow?.station_lng ?? null

  if (stationLat == null || stationLng == null) {
    const geo = await geocodeStation(station, opts)
    stationLat = geo.lat
    stationLng = geo.lng
  }

  const from = { lat: homeRecord.lat, lng: homeRecord.lng }
  const to   = { lat: stationLat,     lng: stationLng     }

  let km
  let source = 'osrm'
  try {
    const r = await requestRoute(from, to, opts)
    km     = r.distanceKm
    source = r.source || 'google'
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    km     = await routeOsrmKm(from, to, opts)
    source = 'osrm'
  }

  await saveDistanceEstimate(
    userId,
    station.id,
    homeRecord.address_hash,
    homeRecord.address_version,
    km,
    stationLat,
    stationLng,
  )

  return { km, stationLat, stationLng, source }
}

/**
 * Main entrypoint. Returns one of:
 *   { phase: 'confirmed', km, source }
 *   { phase: 'estimate',  km }
 *   { phase: 'stale',     km|null, reason }
 * Throws on hard failure — the caller turns that into phase 'error'.
 *
 * Inputs:
 *   userId          — auth uid
 *   station         — { id, name, abbreviation? }
 *   currentAddress  — the user's current profile home_address text
 *   opts.signal     — optional AbortSignal
 */
export async function resolveDistance(userId, station, currentAddress, opts = {}) {
  if (!userId)         throw new Error('Not signed in.')
  if (!station?.id)    throw new Error('No rostered station selected on profile.')
  if (!currentAddress) throw new Error('No home address set on profile.')

  const homeRecord = await ensureHomeRecord(userId, currentAddress, opts)
  const stationRow = await getStationDistance(userId, station.id)

  const versionMatches = stationRow &&
    stationRow.home_address_version === homeRecord.address_version &&
    stationRow.home_address_hash    === homeRecord.address_hash

  // Cache hit — confirmed and still valid.
  if (stationRow && versionMatches && !stationRow.is_stale &&
      stationRow.confirmed_distance_km != null) {
    return {
      phase:  PHASE.CONFIRMED,
      km:     Number(stationRow.confirmed_distance_km),
      source: stationRow.confirmation_source || 'auto',
    }
  }

  // Stale — either flagged is_stale or the home version moved on. We surface
  // the prior estimate (if any) so the user has a starting point, but the
  // UI must require re-confirmation before the value is used in a claim.
  if (stationRow && (stationRow.is_stale || !versionMatches)) {
    return {
      phase:  PHASE.STALE,
      km:     stationRow.estimated_distance_km != null
                ? Number(stationRow.estimated_distance_km)
                : null,
      reason: stationRow.stale_reason || (!versionMatches ? 'home_address_changed' : 'unknown'),
    }
  }

  // No usable cache → compute fresh.
  const { km, source } = await computeEstimate(userId, station, homeRecord, stationRow, opts)
  return { phase: PHASE.ESTIMATE, km, source }
}

/**
 * Resolve the informational home → rostered-station travel baseline:
 * one-way driving distance AND one-way travel time, in a single pass.
 *
 * This is intentionally a READ-MOSTLY sibling of resolveDistance — it reuses
 * the same primitives (home geocode + cached/geocoded station coords + the
 * existing /api/travel/google routing source) but DOES NOT persist anything.
 * In particular it never calls saveDistanceEstimate, so it can never clobber a
 * user's confirmed station distance. It exists because the cache only stores
 * distance; travel time is only ever available transiently from the router.
 *
 * Returns { km, durationSeconds|null, source }. durationSeconds is null only in
 * the rare case where routing falls all the way through to the direct OSRM
 * helper (which reports distance only) — the API route itself returns duration
 * for both Google and its server-side OSRM fallback.
 *
 * Inputs mirror resolveDistance: userId, station {id,name}, currentAddress.
 */
export async function resolveTravelBaseline(userId, station, currentAddress, opts = {}) {
  if (!userId)         throw new Error('Not signed in.')
  if (!station?.id)    throw new Error('No rostered station selected on profile.')
  if (!currentAddress) throw new Error('No home address set on profile.')

  const homeRecord = await ensureHomeRecord(userId, currentAddress, opts)

  // Reuse cached station coordinates from the home → station flow when present;
  // only geocode when we have nothing cached. We do not write the coords back —
  // this resolver is non-persisting by design.
  const stationRow = await getStationDistance(userId, station.id)
  let stationLat = stationRow?.station_lat != null ? Number(stationRow.station_lat) : null
  let stationLng = stationRow?.station_lng != null ? Number(stationRow.station_lng) : null
  if (!Number.isFinite(stationLat) || !Number.isFinite(stationLng)) {
    const geo  = await geocodeStation(station, opts)
    stationLat = geo.lat
    stationLng = geo.lng
  }

  const from = { lat: homeRecord.lat, lng: homeRecord.lng }
  const to   = { lat: stationLat,     lng: stationLng     }

  let km
  let durationSeconds = null
  let source = 'osrm'
  try {
    const r = await requestRoute(from, to, opts)
    km              = r.distanceKm
    durationSeconds = Number.isFinite(r.durationSeconds) ? r.durationSeconds : null
    source          = r.source || 'google'
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    // Direct OSRM fallback reports distance only — leave travel time unknown.
    km     = await routeOsrmKm(from, to, opts)
    source = 'osrm'
  }

  return { km, durationSeconds, source }
}

/**
 * Forced recalculation — used by the "Recalculate" button on stale or error
 * states. Always re-routes via OSRM, but reuses the cached station geocode
 * if present.
 */
export async function recalculateDistance(userId, station, currentAddress, opts = {}) {
  if (!userId)         throw new Error('Not signed in.')
  if (!station?.id)    throw new Error('No rostered station selected on profile.')
  if (!currentAddress) throw new Error('No home address set on profile.')

  const homeRecord     = await ensureHomeRecord(userId, currentAddress, opts)
  const stationRow     = await getStationDistance(userId, station.id)
  const { km, source } = await computeEstimate(userId, station, homeRecord, stationRow, opts)
  return { phase: PHASE.ESTIMATE, km, source }
}

/**
 * Helper for callers that need the home record (hash + version) at confirm time.
 */
export async function getHomeRecordForConfirm(userId) {
  return getHomeAddress(userId)
}
