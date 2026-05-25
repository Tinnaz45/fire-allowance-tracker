// ─── OSRM (Open Source Routing Machine) ──────────────────────────────────────
// Public OSRM demo server is used for one-way driving distance lookups.
// We deliberately keep this thin — no waypoints, no alternatives, no geometry.
//
// Endpoint pattern:
//   https://router.project-osrm.org/route/v1/driving/{lng1},{lat1};{lng2},{lat2}
//     ?overview=false&alternatives=false&steps=false
// ─────────────────────────────────────────────────────────────────────────────

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving'

/**
 * Compute the one-way driving distance (in km) between two coordinates.
 * Returns a number rounded to 1 decimal place, or throws.
 * @param {{lat:number,lng:number}} from
 * @param {{lat:number,lng:number}} to
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 */
export async function routeDistanceKm(from, to, opts = {}) {
  if (!from || !to || !isFinite(from.lat) || !isFinite(from.lng) ||
      !isFinite(to.lat) || !isFinite(to.lng)) {
    throw new Error('Invalid coordinates for routing.')
  }

  const path = from.lng + ',' + from.lat + ';' + to.lng + ',' + to.lat
  const url  = OSRM_BASE + '/' + path + '?overview=false&alternatives=false&steps=false'

  let res
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: opts.signal,
    })
  } catch (err) {
    throw new Error('Network error contacting router.')
  }

  if (!res.ok) {
    throw new Error('Router returned status ' + res.status + '.')
  }

  let json
  try {
    json = await res.json()
  } catch (err) {
    throw new Error('Router returned invalid JSON.')
  }

  if (json.code !== 'Ok' || !Array.isArray(json.routes) || json.routes.length === 0) {
    throw new Error('No driving route found.')
  }

  const meters = json.routes[0].distance
  if (!isFinite(meters) || meters <= 0) {
    throw new Error('Router returned invalid distance.')
  }

  return Math.round((meters / 1000) * 10) / 10
}
