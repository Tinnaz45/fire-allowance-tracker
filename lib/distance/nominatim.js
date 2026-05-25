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
 * Geocode a fire station. Stations are keyed by FRV id + name; we add an
 * "Australia" hint so Nominatim disambiguates against same-named places
 * elsewhere in the world.
 * @param {{ id: number, name: string, abbreviation?: string }} station
 * @param {object} [opts]
 */
export async function geocodeStation(station, opts = {}) {
  if (!station || !station.name) {
    throw new Error('Station name is missing.')
  }
  const query = station.name + ' Fire Station, Victoria, Australia'
  return geocode(query, opts)
}
