#!/usr/bin/env node
// ─── FRV Travel Matrix Import (CLI) ──────────────────────────────────────────
// Ingests a CSV export of an FRV "Index" tab into fat.travel_matrix_*. Supports
// both the "Index (hr)" tab (decimal travel hours, used for Standby/M&D
// payroll comparison) AND the "Index (KM)" tab (deterministic kilometres,
// used for the rostered→recall distance lookup that replaces live routing).
//
// Usage:
//   node scripts/import-travel-matrix.mjs --file ./Index_hr.csv \
//        --label "2026-Q1 FRV Index (hr)" [--unit hours] [--activate] [--dry-run]
//
//   node scripts/import-travel-matrix.mjs --file ./Index_km.csv \
//        --label "2026-Q1 FRV Index (KM)" --unit km --activate
//
// Required env:
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY    (service role — write access to fat schema)
//
// Optional flags:
//   --file FILE          Path to the CSV export of the Index tab.
//   --label LABEL        Human label for this version (unique in DB).
//   --unit UNIT          Cell unit: "hours" (default), "minutes", or "km".
//   --activate           Mark this version active AND deactivate same-unit ones.
//   --dry-run            Parse + resolve, but skip all database writes.
//   --notes "TEXT"       Free-text description stored on the version row.
//
// Activation is scoped per-unit so the hours matrix and KM matrix can both be
// active simultaneously without contaminating each other.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import { basename }     from 'node:path'
import { createClient } from '@supabase/supabase-js'

import {
  parseCsv,
  buildResolver,
  parseTravelMatrix,
  normaliseLabel,
} from '../lib/distance/matrix/parseMatrix.js'


// ── CLI parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { activate: false, dryRun: false, unit: 'hours' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--file')      out.file     = argv[++i]
    else if (a === '--label') out.label   = argv[++i]
    else if (a === '--notes') out.notes   = argv[++i]
    else if (a === '--unit')  out.unit    = String(argv[++i] || '').toLowerCase()
    else if (a === '--activate') out.activate = true
    else if (a === '--dry-run')  out.dryRun  = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

// Plausibility ceilings keep import time defensive — a rogue cell over the
// ceiling is rejected so we never persist nonsense values that would later
// pollute claim totals. The defaults match real-world FRV station spread.
const UNIT_MAX = { hours: 24, minutes: 24 * 60, km: 2000 }
function maxForUnit(unit) {
  return UNIT_MAX[unit] != null ? UNIT_MAX[unit] : 24
}

function printHelp() {
  console.log(`
FRV Travel Matrix Import

Usage:
  node scripts/import-travel-matrix.mjs --file ./Index_hr.csv --label "2026-Q1" [--activate] [--dry-run]

Required env:
  NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
`)
}


// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) { printHelp(); process.exit(0) }
  if (!args.file)  { console.error('Missing --file'); process.exit(2) }
  if (!args.label) { console.error('Missing --label'); process.exit(2) }
  if (!['hours', 'minutes', 'km'].includes(args.unit)) {
    console.error(`Invalid --unit "${args.unit}". Use hours | minutes | km.`)
    process.exit(2)
  }

  const url  = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(2)
  }

  const supabase = createClient(url, key, { db: { schema: 'fat' } })

  // ── Load reference data ───────────────────────────────────────────────────
  const [{ data: stations, error: stnErr }, { data: aliasRows, error: aliasErr }] = await Promise.all([
    supabase.from('stations').select('id, name, abbreviation').eq('is_active', true).order('id'),
    supabase.from('station_aliases').select('alias_norm, station_id'),
  ])
  if (stnErr)   { console.error('stations fetch failed:', stnErr.message); process.exit(1) }
  if (aliasErr) { console.error('station_aliases fetch failed:', aliasErr.message); process.exit(1) }

  const aliasMap = new Map((aliasRows || []).map((r) => [r.alias_norm, r.station_id]))
  const resolve  = buildResolver(stations || [], aliasMap)

  // ── Parse the CSV ─────────────────────────────────────────────────────────
  let csvText
  try {
    csvText = readFileSync(args.file, 'utf8')
  } catch (err) {
    console.error(`Could not read ${args.file}: ${err.message}`)
    process.exit(1)
  }
  const rows    = parseCsv(csvText)
  const parsed  = parseTravelMatrix(rows, resolve, { maxValue: maxForUnit(args.unit) })

  console.log(`[import-travel-matrix] file: ${args.file}`)
  console.log(`  parsed cells:        ${parsed.cells.length}`)
  console.log(`  distinct stations:   ${parsed.stations.length}`)
  console.log(`  skipped empties:     ${parsed.skipped}`)
  console.log(`  rejected cells:      ${parsed.rejected.length}`)
  if (parsed.unresolvedHeaders.length || parsed.unresolvedRowLabels.length) {
    console.log('  unresolved labels:')
    for (const u of [...new Set([...parsed.unresolvedHeaders, ...parsed.unresolvedRowLabels])]) {
      console.log(`    • ${u}  (alias_norm: "${normaliseLabel(u)}")`)
    }
  }

  if (parsed.cells.length === 0) {
    console.error('No cells parsed — refusing to import an empty matrix.')
    process.exit(1)
  }

  if (args.dryRun) {
    console.log('\n--dry-run: not writing to the database.')
    process.exit(0)
  }

  // ── Create the version row ────────────────────────────────────────────────
  const { data: version, error: vErr } = await supabase
    .from('travel_matrix_versions')
    .insert({
      label:           args.label,
      source_filename: basename(args.file),
      unit:            args.unit,
      is_active:       false,
      notes:           args.notes || null,
      cell_count:      parsed.cells.length,
      station_count:   parsed.stations.length,
    })
    .select()
    .single()
  if (vErr) { console.error('version insert failed:', vErr.message); process.exit(1) }
  console.log(`\nCreated version ${version.id}  ("${version.label}", unit=${args.unit})`)

  // ── Insert cells in chunks ────────────────────────────────────────────────
  const CHUNK = 500
  const cells = parsed.cells.map((c) => ({ ...c, version_id: version.id }))
  for (let i = 0; i < cells.length; i += CHUNK) {
    const slice = cells.slice(i, i + CHUNK)
    const { error: cErr } = await supabase.from('travel_matrix_cells').insert(slice)
    if (cErr) {
      console.error(`cell insert failed at offset ${i}:`, cErr.message)
      // Best-effort cleanup so a partial version doesn't linger
      await supabase.from('travel_matrix_versions').delete().eq('id', version.id)
      process.exit(1)
    }
    process.stdout.write(`  inserted ${Math.min(i + CHUNK, cells.length)}/${cells.length}\r`)
  }
  console.log('\nAll cells inserted.')

  // ── Activate if requested (scoped to the same unit) ──────────────────────
  // The hours and KM matrices are independent — activating one must NOT
  // deactivate the other. We only flip is_active=false on other rows whose
  // unit matches this version.
  if (args.activate) {
    const { error: deactErr } = await supabase
      .from('travel_matrix_versions')
      .update({ is_active: false })
      .eq('unit', args.unit)
      .neq('id', version.id)
    if (deactErr) {
      console.error('deactivate-others failed:', deactErr.message); process.exit(1)
    }
    const { error: actErr } = await supabase
      .from('travel_matrix_versions')
      .update({ is_active: true })
      .eq('id', version.id)
    if (actErr) { console.error('activate failed:', actErr.message); process.exit(1) }
    console.log(`Activated version ${version.label} (unit=${args.unit}).`)
  } else {
    console.log('Version created in INACTIVE state. Re-run with --activate to promote.')
  }
}

main().catch((err) => {
  console.error('Fatal:', err?.stack || err?.message || err)
  process.exit(1)
})
