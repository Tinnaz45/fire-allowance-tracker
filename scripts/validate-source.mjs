#!/usr/bin/env node
/**
 * validate-source.mjs — Fire Allowance Tracker
 *
 * Standalone source-file integrity validator.
 * Mirrors the pre-commit hook checks so they can be run manually or in CI
 * without requiring git staged state.
 *
 * Checks:
 *   1. Empty file detection       — 0-byte JS/JSX/MJS files
 *   2. Truncation detection       — JS/JSX/MJS files under 20 bytes
 *   3. JS syntax validation       — node --check on .js / .mjs files
 *   4. JSON validity              — package.json
 *
 * Usage:
 *   node scripts/validate-source.mjs            # checks app/ components/ lib/ scripts/
 *   npm run validate
 *
 * Exit 0 = all passed. Exit 1 = one or more errors.
 */

import { execFileSync } from 'child_process'
import { readdirSync, statSync, readFileSync } from 'fs'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// Directories to scan (relative to repo root)
const SCAN_DIRS = ['app', 'components', 'lib', 'scripts']
const JS_EXTS = new Set(['.js', '.jsx', '.mjs'])
const MIN_BYTES = 20  // files smaller than this are considered suspiciously truncated

let errors = 0
let checked = 0

function collectFiles(dir) {
  const results = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath))
    } else if (entry.isFile() && JS_EXTS.has(extname(entry.name))) {
      results.push(fullPath)
    }
  }
  return results
}

function checkFile(filePath) {
  const rel = filePath.replace(ROOT + '/', '').replace(ROOT + '\\', '')
  const stat = statSync(filePath)
  const size = stat.size

  if (size === 0) {
    console.error(`  ✗ EMPTY: ${rel} (0 bytes)`)
    errors++
    return
  }

  if (size < MIN_BYTES) {
    console.error(`  ✗ TRUNCATED: ${rel} (${size} bytes — suspiciously short)`)
    errors++
    return
  }

  // Syntax check for .js and .mjs only (JSX is not valid plain JS)
  const ext = extname(filePath)
  if (ext === '.js' || ext === '.mjs') {
    try {
      execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' })
    } catch (err) {
      console.error(`  ✗ SYNTAX: ${rel}`)
      if (err.stderr) {
        err.stderr.toString().split('\n').filter(Boolean).forEach(l => console.error(`     ${l}`))
      }
      errors++
      return
    }
  }

  checked++
}

// ── package.json JSON validity ────────────────────────────────────────────────
function checkPackageJson() {
  const pkgPath = join(ROOT, 'package.json')
  try {
    const raw = readFileSync(pkgPath, 'utf8')
    JSON.parse(raw)
    checked++
  } catch (err) {
    console.error(`  ✗ INVALID JSON: package.json — ${err.message}`)
    errors++
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────
console.log('\n🔍  validate-source: scanning source files...\n')

for (const dir of SCAN_DIRS) {
  const files = collectFiles(join(ROOT, dir))
  for (const f of files) {
    checkFile(f)
  }
}

checkPackageJson()

console.log(`\n${'─'.repeat(50)}`)
if (errors > 0) {
  console.error(`✗  ${errors} error(s) found. Fix files above before committing.\n`)
  process.exit(1)
} else {
  console.log(`✓  All ${checked} files passed validation.\n`)
  process.exit(0)
}
