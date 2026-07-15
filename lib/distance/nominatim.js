// ─── Nominatim (OpenStreetMap) Geocoding ─────────────────────────────────────
// Lightweight client-side wrapper around the public Nominatim search API.
// Used to convert a free-text home address or a fire-station name into
// { lat, lng } coordinates that OSRM can route between.
//
// Etiquette:
//   - Single request per call (no batching needed for our flow).
//   - Identifying Referer header is automatic from the browser.
//   - Results are cached in fat.home_address / fat.station_distances so we
//     never re-call Nominatim for the same input.
// ─────────────────────────────────────────────────────────────────────────────

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search'

/**
 * Generic geocode call. Returns { lat, lng } or throws.
 * @param {string} query  Free-form query string
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 */
async function geocode(query, opts = {}) {
  if (!query || !query.trim()) {
    throw new Error('Address is empty.')
  }

  const url =
    NOMINATIM_BASE +
    '?format=json&limit=1&addressdetails=0&q=' +
    encodeURIComponent(query.trim())

  let res
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: opts.signal,
    })
  } catch (err) {
    throw new Error('Network error contacting geocoder.')
  }

  if (!res.ok) {
    throw new Error('Geocoder returned status ' + res.status + '.')
  }

  let json
  try {
    json = await res.json()
  } catch (err) {
    throw new Error('Geocoder returned invalid JSON.')
  }

  if (!Array.isArray(json) || json.length === 0) {
    throw new Error('Address not found.')
  }

  const lat = parseFloat(json[0].lat)
  const lng = parseFloat(json[0].lon)
  if (!isFinite(lat) || !isFinite(lng)) {
    throw new Error('Geocoder returned invalid coordinates.')
  }

  return { lat, lng }
}

/**
 * Geocode a user's home address.
 * @param {string} address
 * @param {object} [opts]
 */
export async function geocodeAddress(address, opts = {}) {
  return geocode(address, opts)
}

/**
 * Coerce a stored coordinate value (which may arrive from Supabase as a numeric
 * string, a number, null, or '') into a finite number, or null when it is not a
 * usable coordinate. Guards against Number(null)/Number('') === 0 masquerading
 * as a valid coordinate.
 * @param {unknown} value
 * @returns {number|null}
 */
function toCoord(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Build a full structured-address query from a station's stored address
 * columns (street_address / suburb / postcode). Returns null when there is no
 * street line to anchor the lookup — a bare suburb is no more specific than the
 * name-based query, so it is not worth a separate attempt.
 *
 * Produces e.g. "284-290 Hume Highway, Craigieburn VIC 3064, Australia".
 * @param {{ street_address?: string, suburb?: string, postcode?: string }} station
 * @returns {string|null}
 */
function buildStationAddressQuery(station) {
  const street   = (station.street_address || '').trim()
  const suburb   = (station.suburb || '').trim()
  const postcode = (station.postcode || '').trim()

  if (!street) return null

  // These are all Victorian FRV stations, so "VIC" is a safe locality hint that
  // helps Nominatim disambiguate same-named suburbs interstate.
  const locality = [suburb ? `${suburb} VIC` : '', postcode].filter(Boolean).join(' ').trim()
  return [street, locality, 'Australia'].filter(Boolean).join(', ')
}

/**
 * Geocode a fire station to { lat, lng }. Resolution order, most authoritative
 * first, so non-standard stations (e.g. the Training Academy, whose name is not
 * an OpenStreetMap "<name> Fire Station") still resolve:
 *
 *   1. Stored coordinates on the station record (fat.stations.lat/lng) — no
 *      network call.
 *   2. The station's structured street address (street_address/suburb/postcode).
 *   3. Legacy fallback: "<name> Fire Station, Victoria, Australia".
 *
 * The "Australia"/"VIC" hints disambiguate against same-named places elsewhere.
 * @param {{ id?: number, name: string, abbreviation?: string, street_address?: string, suburb?: string, postcode?: string, lat?: unknown, lng?: unknown }} station
 * @param {object} [opts]
 */
export async function geocodeStation(station, opts = {}) {
  if (!station || !station.name) {
    throw new Error('Station name is missing.')
  }

  // 1. Stored coordinates win — authoritative and free.
  const lat = toCoord(station.lat)
  const lng = toCoord(station.lng)
  if (lat != null && lng != null) {
    return { lat, lng }
  }

  // 2. Structured street address — far more reliable than the bare name for
  //    stations whose name is not a recognised "<name> Fire Station".
  const addressQuery = buildStationAddressQuery(station)
  if (addressQuery) {
    try {
      return await geocode(addressQuery, opts)
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      // Structured address didn't resolve — fall through to the name query so
      // behaviour is never worse than before for these stations.
    }
  }

  // 3. Legacy name-based fallback — retained so conventionally-named stations
  //    with no stored coordinates or address keep working exactly as before.
  const query = station.name + ' Fire Station, Victoria, Australia'
  return geocode(query, opts)
}
