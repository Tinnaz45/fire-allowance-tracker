// ─── Station Parser ──────────────────────────────────────────────────────────
// Robust free-text → station record parser.
//
// Recall claims accept a free-text "Recall Station" input; users type values
// like "FS44 - Sunshine", "FS 44", "44 - Sunshine", "Sunshine", or "44".
// This module extracts a normalised { id, name, abbreviation, label } tuple
// so downstream code can locate the station's coordinates and compute a
// rostered-to-recall driving distance.
//
// This module never makes a network call. It does pure text parsing plus an
// optional lookup against an already-loaded fat.stations list.
// ─────────────────────────────────────────────────────────────────────────────

// Regex breakdown:
//   ^\s*                  leading whitespace
//   (?:FS|F\.S\.?|STN)?   optional prefix ("FS", "F.S", "F.S.", "STN")
//   \s*                   optional space after prefix
//   (\d{1,3})             station number (1-3 digits)
//   \s*                   optional space
//   (?:[-–—:]\s*(.+))?    optional separator + name
//   \s*$                  trailing whitespace
const STATION_ID_REGEX = /^\s*(?:FS|F\.S\.?|STN)?\s*(\d{1,3})\s*(?:[-–—:]\s*(.+?))?\s*$/i

/**
 * Parse a free-text station input.
 *
 * Returns the most that can be inferred without a stations list. Callers can
 * pass the parsed result + a stations array to `resolveStation()` to upgrade
 * id-only or name-only matches into a full station record.
 *
 * @param {string} text
 * @returns {{ id: number|null, name: string|null, raw: string }}
 */
export function parseStationInput(text) {
  if (text == null) return { id: null, name: null, raw: '' }
  const trimmed = String(text).trim()
  if (!trimmed) return { id: null, name: null, raw: '' }

  const match = trimmed.match(STATION_ID_REGEX)
  if (match) {
    const id   = parseInt(match[1], 10)
    const name = (match[2] || '').trim() || null
    return { id: isFinite(id) ? id : null, name, raw: trimmed }
  }

  // No ID detected — treat the whole string as a name fragment
  return { id: null, name: trimmed, raw: trimmed }
}

/**
 * Resolve a parsed station against a stations list (from fat.stations).
 *
 * - Match by ID when available.
 * - Otherwise match by name (case-insensitive substring), preferring exact
 *   matches and shorter station names to avoid greedy matches.
 *
 * @param {{ id: number|null, name: string|null }} parsed
 * @param {Array<{ id: number, name: string, abbreviation: string|null }>} stations
 * @returns {{ id: number, name: string, abbreviation: string|null, label: string } | null}
 */
export function resolveStation(parsed, stations) {
  if (!parsed || !Array.isArray(stations) || stations.length === 0) return null

  // Prefer an explicit ID match
  if (parsed.id != null) {
    const byId = stations.find((s) => s.id === parsed.id)
    if (byId) {
      return {
        id:           byId.id,
        name:         byId.name,
        abbreviation: byId.abbreviation || `FS${byId.id}`,
        label:        `${byId.abbreviation || 'FS' + byId.id} - ${byId.name}`,
      }
    }
  }

  // Fallback: case-insensitive name match
  if (parsed.name) {
    const query = parsed.name.toLowerCase()
    const exact = stations.find((s) => (s.name || '').toLowerCase() === query)
    const target = exact
      || stations
          .filter((s) => (s.name || '').toLowerCase().includes(query))
          // Prefer shorter names — more specific matches first
          .sort((a, b) => (a.name || '').length - (b.name || '').length)[0]
    if (target) {
      return {
        id:           target.id,
        name:         target.name,
        abbreviation: target.abbreviation || `FS${target.id}`,
        label:        `${target.abbreviation || 'FS' + target.id} - ${target.name}`,
      }
    }
  }

  return null
}

/**
 * Convenience: parse + resolve in one call.
 * Returns the resolved station record or null.
 */
export function parseAndResolve(text, stations) {
  return resolveStation(parseStationInput(text), stations)
}

// ─── Canonical label composition ─────────────────────────────────────────────
// The canonical in-memory shape is (station_id, bare name from fat.stations).
// fat.profile_ext.rostered_station_label is a write-only denormalized cache
// composed from those two values on save and never read into render state —
// see app/profile/page.js hydration and components/claims/ClaimForm.js, which
// both look the bare name up from fat.stations keyed by station_id.
//
// Earlier revisions stored the composed label in state, then re-prepended
// "FS{id} - " on render, producing "FS42 - FS42 - Newport" after login. The
// fix is structural: callers pass a bare name only, and composeStationLabel
// performs a single prepend with no internal stripping (no layered regex
// repair). For free-text inputs like "FS44 - Sunshine", parseStationInput
// above extracts id + name via STATION_ID_REGEX — there is no separate
// stripper.

/**
 * Compose the canonical persisted station label from an id + bare name pair.
 * Callers must pass a bare name (sourced from fat.stations.name) — this
 * function performs no internal stripping, by design.
 *
 * @param {string|number|null} stationId
 * @param {string|null|undefined} stationName  Bare station name, e.g. "Newport"
 * @returns {string} canonical "FS{id} - {name}" / "FS{id}" / ""
 */
export function composeStationLabel(stationId, stationName) {
  if (stationId == null || stationId === '') return ''
  const name = stationName == null ? '' : String(stationName).trim()
  return name ? `FS${stationId} - ${name}` : `FS${stationId}`
}

/**
 * Build the canonical label for a station record (the same shape produced by
 * composeStationLabel + resolveStation). Used by the station picker UI when
 * committing an explicit selection back to the parent form.
 */
export function labelForStation(station) {
  if (!station) return ''
  const abbr = station.abbreviation || `FS${station.id}`
  return station.name ? `${abbr} - ${station.name}` : abbr
}

/**
 * Returns the resolved canonical station ONLY when the supplied text exactly
 * equals that station's canonical label — i.e. the parent value came from an
 * explicit picker selection, not from fuzzy typing.
 *
 * Downstream callers (auto-distance lookups, confirmation chips) gate on this
 * so a partial fragment like "43" never lights up as if the user had picked.
 */
export function getExplicitlyResolvedStation(text, stations) {
  if (!text || !Array.isArray(stations) || stations.length === 0) return null
  const resolved = parseAndResolve(text, stations)
  if (!resolved) return null
  return String(text).trim() === labelForStation(resolved) ? resolved : null
}
