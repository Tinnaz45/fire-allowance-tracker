// ─── Station-to-Station Distance ─────────────────────────────────────────────
// Computes a driving distance between two stations (rostered → recall) for the
// recall-claim "Rostered to Recall Station (one way, km)" field.
//
// Reuses the existing geocode + routing primitives (Nominatim + OSRM) and the
// station-coordinate cache already maintained for home → station distances:
//
//   - Origin (rostered) coords:
//       1. fat.station_distances row for (user_id, originStationId) — uses
//          station_lat/lng populated by the home → station flow.
//       2. Geocode via Nominatim if no cached coords exist.
//
//   - Destination (recall) coords:
//       1. fat.station_distances row for (user_id, destStationId) — uses any
//          previously cached coords (e.g. if the user has had this station as
//          a previous rostered station).
//       2. Geocode via Nominatim otherwise.
//
// In-memory session caches deduplicate repeat lookups:
//   - coordCache:  stationId → { lat, lng }
//   - pairCache:   "originId:destId" → distanceKm
//
// NO database mutations are made by this module. It is purely additive on top
// of the home → station cache (read-only against fat.station_distances) and
// safe against the existing Home → Station calculations.
// ─────────────────────────────────────────────────────────────────────────────

import { geocodeStation } from './nominatim'
import { requestRoute }   from './googleRouting'
import { routeDistanceKm as routeOsrmKm } from './osrm'
import { getStationDistance } from './addressCache'

// ── In-memory caches ─────────────────────────────────────────────────────────
// Lives for the lifetime of the JS module (page/session). Cleared on full
// reload — acceptable for a low-traffic, claim-by-claim workflow.
const coordCache = new Map() // stationId → { lat, lng }
const pairCache  = new Map() // "originId:destId" → { distanceKm, source }

function pairKey(originId, destId) {
  return `${originId}:${destId}`
}

/**
 * Resolve coordinates for a station. Prefers cached coords from
 * fat.station_distances (populated by home → station calculations), falling
 * back to a Nominatim geocode by station name.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {number} params.stationId
 * @param {string} params.stationName    Bare name e.g. "Sunshine" — required for geocode fallback
 * @param {string} params.stationLabel   Display label e.g. "FS44 - Sunshine" — used in error messages
 * @returns {Promise<{ lat: number, lng: number, source: 'memo'|'cache'|'geocoded' }>}
 */
async function resolveStationCoords({ userId, stationId, stationName, stationLabel }) {
  if (stationId != null && coordCache.has(stationId)) {
    return { ...coordCache.get(stationId), source: 'memo' }
  }

  if (userId && stationId != null) {
    try {
      const row = await getStationDistance(userId, stationId)
      if (row?.station_lat != null && row?.station_lng != null) {
        const lat = parseFloat(row.station_lat)
        const lng = parseFloat(row.station_lng)
        if (isFinite(lat) && isFinite(lng)) {
          coordCache.set(stationId, { lat, lng })
          return { lat, lng, source: 'cache' }
        }
      }
    } catch {
      // Non-fatal — fall through to geocode
    }
  }

  // Need a bare station name for Nominatim — geocodeStation appends
  // " Fire Station, Victoria, Australia" to the name to disambiguate.
  if (!stationName || !stationName.trim()) {
    const display = stationLabel || (stationId ? `FS${stationId}` : 'station')
    throw new Error(`Station name unavailable for ${display}; cannot geocode.`)
  }
  const { lat, lng } = await geocodeStation({ name: stationName })
  if (stationId != null) coordCache.set(stationId, { lat, lng })
  return { lat, lng, source: 'geocoded' }
}

/**
 * Compute the one-way driving distance from a rostered station to a recall
 * station.
 *
 * @param {object} params
 * @param {string}      params.userId           Authenticated user ID
 * @param {number}      params.originStationId  Rostered station ID
 * @param {string}      params.originName       Bare name e.g. "Brooklyn" — required for geocode fallback
 * @param {string}      params.originLabel      Display label e.g. "FS45 - Brooklyn"
 * @param {number}      params.destStationId    Recall station ID
 * @param {string}      params.destName         Bare name e.g. "Sunshine"
 * @param {string}      params.destLabel        Display label e.g. "FS44 - Sunshine"
 * @param {boolean}    [params.forceRecalc]     Bypass in-memory pair cache
 * @returns {Promise<{ distanceKm: number, source: 'memo'|'calculated' }>}
 */
export async function getStationToStationDistance({
  userId,
  originStationId,
  originName,
  originLabel,
  destStationId,
  destName,
  destLabel,
  forceRecalc = false,
}) {
  if (originStationId == null || destStationId == null) {
    throw new Error('Both stations must be identified to calculate distance.')
  }

  // Same station — distance is zero, no API calls required
  if (originStationId === destStationId) {
    return { distanceKm: 0, source: 'memo', routingSource: 'self' }
  }

  const key = pairKey(originStationId, destStationId)
  if (!forceRecalc && pairCache.has(key)) {
    const cached = pairCache.get(key)
    return { distanceKm: cached.distanceKm, source: 'memo', routingSource: cached.source }
  }

  const [origin, dest] = await Promise.all([
    resolveStationCoords({ userId, stationId: originStationId, stationName: originName, stationLabel: originLabel }),
    resolveStationCoords({ userId, stationId: destStationId,   stationName: destName,   stationLabel: destLabel }),
  ])

  const from = { lat: origin.lat, lng: origin.lng }
  const to   = { lat: dest.lat,   lng: dest.lng }

  let distanceKm
  let routingSource = 'osrm'
  try {
    const r = await requestRoute(from, to)
    distanceKm    = r.distanceKm
    routingSource = r.source || 'google'
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    distanceKm    = await routeOsrmKm(from, to)
    routingSource = 'osrm'
  }
  pairCache.set(key, { distanceKm, source: routingSource })
  return { distanceKm, source: 'calculated', routingSource }
}

/**
 * Clear the in-memory pair cache. Exposed primarily for testing.
 */
export function _clearStationPairCache() {
  pairCache.clear()
  coordCache.clear()
}
