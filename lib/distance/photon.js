// ─── Photon (OpenStreetMap) Address Autocomplete ─────────────────────────────
// Free, key-less autocomplete service backed by Komoot's hosted Photon. We use
// it on the profile page to let the user pick a verified, geocoded address
// instead of free-typing one.
//
// Primary: photon.komoot.io  (https://photon.komoot.io)
// Fallback: nominatim.openstreetmap.org/search (when Photon errors or returns
// no usable results — same upstream OSM data, slightly different ranking).
//
// Design choices:
//   - Australia bbox bias on Photon + countrycodes=au on Nominatim.
//   - Small in-memory LRU keyed by lowercased query so repeat keystrokes don't
//     re-fetch (e.g. user backspaces one char and retypes it).
//   - AbortSignal honoured end-to-end so the component can cancel in-flight
//     requests when newer keystrokes supersede them.
//   - Returns a normalised suggestion shape:
//       { id, label, lat, lng, source }
//     so the UI doesn't need to know which provider answered.
//
// No API keys, no paid services, no vendor lock-in — both endpoints are public
// and free.
// ─────────────────────────────────────────────────────────────────────────────

const PHOTON_BASE    = 'https://photon.komoot.io/api'
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search'

// Australia bounding box (continental + Tas). Used to bias Photon results.
const AU_BBOX = '112.92,-43.74,153.64,-10.66'

const MAX_RESULTS = 6
const MIN_QUERY_LEN = 3

// ── Tiny query cache ────────────────────────────────────────────────────────

const CACHE_CAP = 50
const _cache = new Map() // insertion-order = LRU

function cacheGet(key) {
  if (!_cache.has(key)) return undefined
  const v = _cache.get(key)
  _cache.delete(key)
  _cache.set(key, v)
  return v
}

function cacheSet(key, value) {
  if (_cache.has(key)) _cache.delete(key)
  _cache.set(key, value)
  while (_cache.size > CACHE_CAP) _cache.delete(_cache.keys().next().value)
}

function cacheKey(query) {
  return query.toLowerCase().replace(/\s+/g, ' ').trim()
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function joinNonEmpty(parts, sep = ', ') {
  return parts.filter((p) => p && String(p).trim()).join(sep)
}

// Why this order matters for AU addresses:
//   Photon flattens the OSM admin hierarchy into a small set of fields. For
//   Greater Geelong (and most metro AU councils), the OSM `place=suburb` node
//   for e.g. "Breakwater" surfaces as `properties.district`, while the broader
//   municipality ("Geelong" / "City of Greater Geelong") surfaces as
//   `properties.city`. Preferring `city` therefore collapses neighbouring
//   suburbs into the council label. Picking `district` (and `locality`, which
//   Photon uses for smaller named places) first restores suburb precision
//   without losing the city/town fallback for rural addresses where only
//   `city`/`town`/`county` is populated.
function pickPhotonLocality(p) {
  return (
    p.district ||
    p.locality ||
    p.suburb ||         // not standard in Photon, but defensive
    p.neighbourhood ||  // ditto
    p.hamlet ||
    p.village ||
    p.town ||
    p.city ||
    p.county ||
    ''
  )
}

function formatPhotonFeature(feature) {
  const p = feature?.properties || {}
  const coords = feature?.geometry?.coordinates
  if (!Array.isArray(coords) || coords.length < 2) return null
  const lng = Number(coords[0])
  const lat = Number(coords[1])
  if (!isFinite(lat) || !isFinite(lng)) return null

  const street = joinNonEmpty([p.housenumber, p.street], ' ')
  const suburb = pickPhotonLocality(p)
  const region = p.state || ''
  const postcode = p.postcode || ''
  const country = p.country || ''

  // Build a human-friendly canonical line:
  //   "12 Collins Street, Breakwater VIC 3219, Australia"
  const localityLine = joinNonEmpty([suburb, joinNonEmpty([region, postcode], ' ')], ' ')
  const label = joinNonEmpty([
    street || (p.name && p.name !== suburb ? p.name : ''),
    localityLine,
    country,
  ])

  if (!label) return null

  return {
    id:    `photon:${p.osm_type || ''}/${p.osm_id || `${lat},${lng}`}`,
    label,
    lat,
    lng,
    source: 'photon',
  }
}

// Nominatim's address object exposes the full OSM admin hierarchy under
// distinct keys. Prefer the most specific locality so suburbs like Breakwater
// aren't collapsed into the surrounding LGA ("Geelong" / "City of Greater
// Geelong" / "Greater Geelong"). Order: suburb > neighbourhood > hamlet >
// village > town > city_district > city > municipality > county.
function pickNominatimLocality(a) {
  return (
    a.suburb ||
    a.neighbourhood ||
    a.hamlet ||
    a.village ||
    a.town ||
    a.city_district ||
    a.city ||
    a.municipality ||
    a.county ||
    a.locality ||
    ''
  )
}

function formatNominatimItem(item) {
  if (!item) return null
  const lat = parseFloat(item.lat)
  const lng = parseFloat(item.lon)
  if (!isFinite(lat) || !isFinite(lng)) return null

  const a = item.address || {}
  const street = joinNonEmpty([a.house_number, a.road], ' ')
  const suburb = pickNominatimLocality(a)
  const region = a.state || ''
  const postcode = a.postcode || ''
  const country = a.country || ''

  const localityLine = joinNonEmpty([suburb, joinNonEmpty([region, postcode], ' ')], ' ')
  const label = joinNonEmpty([
    street || a.attraction || a.amenity || '',
    localityLine,
    country,
  ]) || item.display_name || ''

  if (!label) return null

  return {
    id:    `nominatim:${item.osm_type || ''}/${item.osm_id || `${lat},${lng}`}`,
    label,
    lat,
    lng,
    source: 'nominatim',
  }
}

// ── Provider calls ──────────────────────────────────────────────────────────

async function searchPhoton(query, signal) {
  const url =
    `${PHOTON_BASE}/?q=${encodeURIComponent(query)}&limit=${MAX_RESULTS}` +
    `&lang=en&bbox=${AU_BBOX}`

  const res = await fetch(url, {
    method:  'GET',
    headers: { 'Accept': 'application/json' },
    signal,
  })
  if (!res.ok) throw new Error(`Photon ${res.status}`)

  const json = await res.json()
  const features = Array.isArray(json?.features) ? json.features : []

  return features
    .map(formatPhotonFeature)
    .filter(Boolean)
    // The bbox biases ranking but Photon still occasionally returns results
    // just outside the box, so filter to AU when the country tag is set.
    .filter((s) => !s._country || /Australia/i.test(s._country))
}

async function searchNominatim(query, signal) {
  const url =
    `${NOMINATIM_BASE}?format=json&addressdetails=1&countrycodes=au` +
    `&limit=${MAX_RESULTS}&q=${encodeURIComponent(query)}`

  const res = await fetch(url, {
    method:  'GET',
    headers: { 'Accept': 'application/json' },
    signal,
  })
  if (!res.ok) throw new Error(`Nominatim ${res.status}`)

  const json = await res.json()
  const items = Array.isArray(json) ? json : []
  return items.map(formatNominatimItem).filter(Boolean)
}

// ── Public entrypoint ───────────────────────────────────────────────────────

/**
 * Autocomplete an address query. Returns an array of suggestions
 * { id, label, lat, lng, source }. Never throws on AbortError — callers can
 * compare the returned array's identity to detect aborted runs by passing in a
 * signal and catching AbortError themselves if needed.
 *
 * @param {string} query Free-text user input.
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Array<{id:string,label:string,lat:number,lng:number,source:string}>>}
 */
export async function searchAddress(query, opts = {}) {
  const q = (query || '').trim()
  if (q.length < MIN_QUERY_LEN) return []

  const key = cacheKey(q)
  const cached = cacheGet(key)
  if (cached) return cached

  const { signal } = opts

  // Try Photon first — usually faster and more typo-tolerant for partial input.
  let results = []
  try {
    results = await searchPhoton(q, signal)
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    // fall through to Nominatim
  }

  if (results.length === 0) {
    try {
      results = await searchNominatim(q, signal)
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      // Both providers failed — return empty so the UI can show
      // "no suggestions; you can still type manually".
      results = []
    }
  }

  // Cache only successful, non-empty result sets — empty might be transient.
  if (results.length > 0) cacheSet(key, results)
  return results
}

// Exported for tests / debugging.
export const _internal = {
  formatPhotonFeature,
  formatNominatimItem,
  cacheKey,
  MIN_QUERY_LEN,
}
