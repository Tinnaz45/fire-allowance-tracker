#!/usr/bin/env node
// ─── XLSX worksheet → CSV extractor (dependency-free) ────────────────────────
// Converts a single worksheet of an .xlsx workbook into a rectangular CSV grid.
// Used to extract the FRV "Index (hr)" / "Index (km)" matrix tabs from
// "FRV Allowances - Current.xlsx" without pulling in a SheetJS dependency.
//
// An .xlsx file is a ZIP container. Node has no built-in unzip, so unzip first
// (any tool works), then point this script at the extracted XML parts:
//
//   # 1. unzip (Windows PowerShell example)
//   Copy-Item book.xlsx book.zip
//   Expand-Archive book.zip -DestinationPath ./x
//
//   # 2. find the sheet's XML: xl/workbook.xml maps sheet NAMES → r:id,
//   #    xl/_rels/workbook.xml.rels maps r:id → worksheets/sheetN.xml
//
//   # 3. extract to a raw rectangular CSV
//   node scripts/extract-xlsx-sheet.mjs ./x/xl/worksheets/sheet12.xml \
//        ./x/xl/sharedStrings.xml ./index-hr-raw.csv
//
// The raw CSV preserves the sheet's exact cell grid (including any title rows
// above the matrix header). For the FRV Index tabs the matrix begins at sheet
// row 3 (header) — drop the leading title rows and normalise integer-valued
// floats ("44.0" → "44") so station labels resolve as bare FRV ids before
// feeding scripts/import-travel-matrix.mjs. See
// docs/STATION_TIME_MATRIX_IMPORT_v1.0.md for the full, replayable procedure.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs'

const [, , sheetPath, sstPath, outPath] = process.argv
if (!sheetPath || !sstPath || !outPath) {
  console.error('Usage: node scripts/extract-xlsx-sheet.mjs <sheetXml> <sharedStringsXml> <outCsv>')
  process.exit(2)
}

function decode(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&')
}

// ── shared strings (each <si> may hold one <t> or multiple <r><t> runs) ───────
const sstXml = readFileSync(sstPath, 'utf8')
const shared = []
for (const m of sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
  let text = ''
  for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += t[1]
  shared.push(decode(text))
}

function colToIdx(ref) {
  const letters = ref.match(/^[A-Z]+/)[0]
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

// ── worksheet cells. NOTE the lazy `([^>]*?)` on the attribute capture: a
// greedy `[^>]*` swallows the trailing "/" of a self-closing <c .../> cell, so
// the "/>" branch never matches and the next cell's body is consumed — which
// silently shifts values around blank cells. Keep it lazy. ───────────────────
const xml = readFileSync(sheetPath, 'utf8')
const rows = []
let maxCol = 0
for (const rm of xml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
  const rIdx = +rm[1] - 1
  const cells = []
  for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = cm[1]
    const body = cm[2] || ''
    const refM = attrs.match(/\br="([A-Z]+\d+)"/)
    if (!refM) continue
    const cIdx = colToIdx(refM[1])
    const t = (attrs.match(/\bt="([^"]+)"/) || [, 'n'])[1]
    let val = ''
    if (t === 's') {
      const v = body.match(/<v>([\s\S]*?)<\/v>/)
      if (v) val = shared[+v[1]] ?? ''
    } else if (t === 'inlineStr') {
      let txt = ''
      for (const tt of body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) txt += tt[1]
      val = decode(txt)
    } else {
      const v = body.match(/<v>([\s\S]*?)<\/v>/)
      if (v) val = t === 'str' ? decode(v[1]) : v[1]
    }
    cells[cIdx] = val
    if (cIdx + 1 > maxCol) maxCol = cIdx + 1
  }
  rows[rIdx] = cells
}

function esc(s) {
  s = s == null ? '' : String(s)
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
const out = []
for (let r = 0; r < rows.length; r++) {
  const row = rows[r] || []
  const line = []
  for (let c = 0; c < maxCol; c++) line.push(esc(row[c]))
  out.push(line.join(','))
}
writeFileSync(outPath, out.join('\r\n'), 'utf8')
console.log(`rows=${rows.length} maxCol=${maxCol} -> ${outPath}`)
