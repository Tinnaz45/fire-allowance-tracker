// ─── FRV Travel Matrix Parser ────────────────────────────────────────────────
// Parses the FRV "Index (hr)" tab exported to CSV. The tab is a square matrix
// of decimal travel hours between every station pair:
//
//   ,FS01 Eastern Hill,FS02 West Melbourne,FS03 Carlton, … (header row)
//   FS01 Eastern Hill,0,0.10,0.15, …
//   FS02 West Melbourne,0.10,0,0.08, …
//   …
//
// Real FRV exports vary: some include abbreviations only ("FS44"), some
// include the full label ("FS44 Sunshine"), some are name-only ("Sunshine").
// The parser normalises both header and row labels through a resolver function
// supplied by the caller so all of those forms map onto fat.stations.id.
//
// The output is a deterministic, sparse set of cells in canonical ordering
// (station_a_id <= station_b_id), suitable for direct insertion into
// fat.travel_matrix_cells.
//
// PURE — no I/O, no DB. The import script (scripts/import-travel-matrix.mjs)
// is responsible for reading the file and applying the cells to Supabase.
// ─────────────────────────────────────────────────────────────────────────────


// ── CSV tokeniser ───────────────────────────────────────────────────────────
// Minimal RFC-4180-style tokeniser: handles quoted fields, escaped quotes,
// CRLF or LF row separators. Avoids pulling in a CSV dependency for what
// amounts to a single ingest path.

export function parseCsv(text) {
  if (typeof text !== 'string') return []
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else                      { inQuotes = false }
      } else {
        field += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        row.push(field); field = ''
      } else if (ch === '\r') {
        if (text[i + 1] === '\n') i++
        row.push(field); field = ''
        rows.push(row); row = []
      } else if (ch === '\n') {
        row.push(field); field = ''
        rows.push(row); row = []
      } else {
        field += ch
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
}


// ── Station label normalisation ─────────────────────────────────────────────

const FS_PATTERN  = /\bFS\s*0*(\d{1,3})\b/i
const STN_STRIP   = /\(.*?\)/g            // drop trailing "(Malvern)" suffixes
const NON_ALNUM   = /[^a-z0-9]+/g

export function normaliseLabel(s) {
  if (!s) return ''
  return String(s)
    .replace(STN_STRIP, ' ')
    .toLowerCase()
    .replace(NON_ALNUM, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Try to extract a FRV station id from a label like "FS44 Sunshine" or "44".
 * Returns the integer id or null.
 */
export function extractFsId(label) {
  if (!label) return null
  const m = String(label).match(FS_PATTERN)
  if (m) {
    const id = parseInt(m[1], 10)
    return isFinite(id) ? id : null
  }
  // Also accept a bare integer like "44"
  const bare = String(label).trim().match(/^(\d{1,3})$/)
  if (bare) {
    const id = parseInt(bare[1], 10)
    return isFinite(id) ? id : null
  }
  return null
}


// ── Resolver ────────────────────────────────────────────────────────────────

/**
 * Build a label → station_id resolver from the canonical stations list plus
 * an optional alias map.
 *
 * @param {Array<{id:number,name:string,abbreviation:string|null}>} stations
 * @param {Map<string, number>|Object<string, number>} [aliases]  alias_norm → station_id
 * @returns {(label:string) => number|null}
 */
export function buildResolver(stations, aliases) {
  const byId      = new Map()
  const byName    = new Map()
  const byAbbrev  = new Map()
  const aliasMap  = aliases instanceof Map
    ? new Map(aliases)
    : new Map(Object.entries(aliases || {}).map(([k, v]) => [normaliseLabel(k), Number(v)]))

  for (const s of stations || []) {
    if (s?.id == null) continue
    byId.set(s.id, s)
    if (s.name)         byName  .set(normaliseLabel(s.name), s.id)
    if (s.abbreviation) byAbbrev.set(normaliseLabel(s.abbreviation), s.id)
  }

  return function resolve(label) {
    if (!label) return null
    const id = extractFsId(label)
    if (id != null && byId.has(id)) return id

    const norm = normaliseLabel(label)
    if (!norm) return null
    if (aliasMap.has(norm))  return aliasMap.get(norm)
    if (byAbbrev.has(norm))  return byAbbrev.get(norm)
    if (byName  .has(norm))  return byName.get(norm)

    // Substring fallback — pick the shortest matching name to avoid greedy
    // collisions. This is deterministic given the canonical stations list.
    let bestId   = null
    let bestSize = Infinity
    for (const [name, sid] of byName.entries()) {
      if (name.includes(norm) || norm.includes(name)) {
        if (name.length < bestSize) { bestId = sid; bestSize = name.length }
      }
    }
    return bestId
  }
}


// ── Matrix parse ────────────────────────────────────────────────────────────

/**
 * Parse a square travel-hours matrix into deterministic sparse cells.
 *
 * @param {string|Array<Array<string>>} input  CSV text OR pre-parsed rows
 * @param {(label:string) => number|null} resolveStation
 * @param {object} [opts]
 * @param {boolean} [opts.includeZeroDiagonal=false]   Emit (x,x,0) cells.
 * @param {number}  [opts.maxValue=24]                 Reject impossible hours.
 * @returns {{
 *   cells: Array<{ station_a_id:number, station_b_id:number, value:number }>,
 *   stations: number[],                  // distinct resolved station ids
 *   unresolvedHeaders: string[],         // labels that did not resolve
 *   unresolvedRowLabels: string[],
 *   skipped: number,                     // empty / non-numeric cells
 *   rejected: Array<{ row:string, col:string, value:string, reason:string }>,
 * }}
 */
export function parseTravelMatrix(input, resolveStation, opts = {}) {
  const includeZeroDiagonal = !!opts.includeZeroDiagonal
  const maxValue            = Number.isFinite(opts.maxValue) ? opts.maxValue : 24

  const rows = Array.isArray(input) ? input : parseCsv(input)
  if (rows.length < 2) {
    return {
      cells: [], stations: [],
      unresolvedHeaders: [], unresolvedRowLabels: [],
      skipped: 0, rejected: [],
    }
  }

  const header     = rows[0]
  const colIds     = header.slice(1).map((h) => resolveStation(h))
  const unresolved = []
  header.slice(1).forEach((h, i) => { if (colIds[i] == null && h && h.trim()) unresolved.push(h) })

  const cellMap     = new Map()        // canonical "a:b" → { a, b, value }
  const stationSet  = new Set()
  const unresRows   = []
  const rejected    = []
  let   skipped     = 0

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.length === 0) continue
    const rowLabel = row[0]
    if (!rowLabel || !rowLabel.trim()) continue

    const rowId = resolveStation(rowLabel)
    if (rowId == null) { unresRows.push(rowLabel); continue }
    stationSet.add(rowId)

    for (let c = 1; c < row.length; c++) {
      const colId = colIds[c - 1]
      if (colId == null) { skipped++; continue }

      const raw = row[c]
      if (raw == null || String(raw).trim() === '') { skipped++; continue }

      // Strip whitespace, percent signs, etc. Accept comma-decimal too.
      const cleaned = String(raw).replace(/[\s,%]/g, (m) => m === ',' ? '.' : '')
      const value   = Number(cleaned)

      if (!isFinite(value) || isNaN(value)) {
        rejected.push({ row: rowLabel, col: header[c], value: raw, reason: 'not_numeric' })
        continue
      }
      if (value < 0 || value > maxValue) {
        rejected.push({ row: rowLabel, col: header[c], value: raw, reason: 'out_of_range' })
        continue
      }

      stationSet.add(colId)

      // Same-station diagonal is skipped unless explicitly requested
      if (rowId === colId && !includeZeroDiagonal) continue

      const a = Math.min(rowId, colId)
      const b = Math.max(rowId, colId)
      const key = `${a}:${b}`

      const existing = cellMap.get(key)
      if (existing) {
        // Keep the first non-zero observation. If both are non-zero and disagree
        // beyond 1 minute (~0.017 hr) flag it; this is informational and the
        // import script can surface it.
        if (existing.value === 0 && value > 0) {
          cellMap.set(key, { station_a_id: a, station_b_id: b, value })
        } else if (Math.abs(existing.value - value) > 0.02) {
          rejected.push({
            row: rowLabel, col: header[c], value: raw,
            reason: `mirror_mismatch (kept ${existing.value})`,
          })
        }
      } else {
        cellMap.set(key, { station_a_id: a, station_b_id: b, value })
      }
    }
  }

  return {
    cells:                Array.from(cellMap.values()),
    stations:             Array.from(stationSet).sort((x, y) => x - y),
    unresolvedHeaders:    unresolved,
    unresolvedRowLabels:  unresRows,
    skipped,
    rejected,
  }
}
