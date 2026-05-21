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

// ── AU unit-prefix workaround ───────────────────────────────────────────────
// Photon/Nominatim are backed by OSM, which lacks Australian subpremise data:
// queries like "8/58 Tucker St" or "Unit 8 58 Tucker St" miss the parent
// street entirely or — worse — silently match a number-only street elsewhere.
// We detect the unit prefix on the user's input, query upstream with only the
// base street address, then re-attach the original prefix to each suggestion
// label. Coordinates remain Photon's base-street coordinates (the same shape
// we already return for unit-less addresses), so geocoding, the verification
// hash, and downstream distance code are untouched.
//
//   "8/58 Tucker St"          → prefix "8/",     base "58 Tucker St"
//   "Unit 8 58 Tucker St"     → prefix "Unit 8", base "58 Tucker St"
//   "Apt 4 12 Example St"     → prefix "Apt 4",  base "12 Example St"
//   "12 Smith St"             → no prefix, original query passed through.
//
// The base must look like a street (start with a number) for the prefix to be
// recognised; this avoids misclassifying free-text like "Lot 5 Reserve".

const UNIT_WORDS = '(?:unit|apt|apartment|suite|ste|flat|shop)'

function parseUnitPrefix(query) {
  if (!query) return { prefix: '', base: '' }
  const q = String(query)

  // Slash form: "8/58 …", "8A / 58 …". Capture the leading subpremise and
  // require a digit after the slash so plain "8/" or "8/letters" doesn't fire.
  const slashMatch = q.match(/^\s*(\d+[A-Za-z]?)\s*\/\s*(?=\d)/)
  if (slashMatch) {
    return { prefix: `${slashMatch[1]}/`, base: q.slice(slashMatch[0].length) }
  }

  // Word form: "Unit 8 58 …", "Apt 4 12 …". Require a digit after the unit
  // identifier (the street number) so "Unit Block A 12 …" doesn't false-match.
  const wordRe = new RegExp(`^\\s*(${UNIT_WORDS})\\.?\\s+(\\S+)\\s+(?=\\d)`, 'i')
  const wordMatch = q.match(wordRe)
  if (wordMatch) {
    return { prefix: `${wordMatch[1]} ${wordMatch[2]}`, base: q.slice(wordMatch[0].length) }
  }

  return { prefix: '', base: q }
}

function attachUnitPrefix(prefix, label) {
  if (!prefix || !label) return label
  // Defensive: if the label already starts with the same prefix (rare for AU
  // OSM data, but defensible for pasted text or future provider changes),
  // don't double-attach.
  const normLabel  = label.toLowerCase().replace(/\s+/g, '')
  const normPrefix = prefix.toLowerCase().replace(/\s+/g, '')
  if (normLabel.startsWith(normPrefix)) return label

  // Slash form attaches without spacing: "8/" + "58 …" → "8/58 …".
  // Word form keeps a single space: "Unit 8" + "58 …" → "Unit 8 58 …".
  const sep = prefix.endsWith('/') ? '' : ' '
  return `${prefix}${sep}${label}`
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

  // AU subpremise workaround — see parseUnitPrefix above. Strip the unit
  // prefix before the upstream call (OSM lacks subpremise data) and re-attach
  // it to each label below. Only meaningful when the base is long enough to
  // be a useful query on its own; otherwise pass the original through.
  const { prefix, base } = parseUnitPrefix(q)
  const lookupQuery = prefix && base.trim().length >= MIN_QUERY_LEN
    ? base.trim()
    : q

  // Try Photon first — usually faster and more typo-tolerant for partial input.
  let results = []
  try {
    results = await searchPhoton(lookupQuery, signal)
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    // fall through to Nominatim
  }

  if (results.length === 0) {
    try {
      results = await searchNominatim(lookupQuery, signal)
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      // Both providers failed — return empty so the UI can show
      // "no suggestions; you can still type manually".
      results = []
    }
  }

  if (prefix && results.length > 0) {
    results = results.map((r) => ({ ...r, label: attachUnitPrefix(prefix, r.label) }))
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
  parseUnitPrefix,
  attachUnitPrefix,
  MIN_QUERY_LEN,
}
