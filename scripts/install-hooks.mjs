#!/usr/bin/env node
/**
 * install-hooks.mjs - Fire Allowance Tracker
 *
 * Installs git hooks from scripts/hooks/ into .git/hooks/.
 * Run automatically via `npm install` (package.json "prepare" script).
 * Safe to re-run; overwrites stale hooks.
 *
 * Usage:
 *   node scripts/install-hooks.mjs
 *   npm install   (runs automatically via "prepare")
 */

import { copyFileSync, chmodSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const HOOKS_SRC = join(ROOT, 'scripts', 'hooks')
const HOOKS_DEST = join(ROOT, '.git', 'hooks')

const HOOKS = ['pre-commit', 'pre-push']

if (!existsSync(join(ROOT, '.git'))) {
  console.log('install-hooks: not a git repo, skipping.')
  process.exit(0)
}

if (!existsSync(HOOKS_DEST)) {
  mkdirSync(HOOKS_DEST, { recursive: true })
}

let installed = 0
for (const hook of HOOKS) {
  const src = join(HOOKS_SRC, hook)
  const dest = join(HOOKS_DEST, hook)
  if (!existsSync(src)) {
    console.warn('install-hooks: source not found: scripts/hooks/' + hook + ' - skipping')
    continue
  }
  copyFileSync(src, dest)
  chmodSync(dest, 0o755)
  console.log('install-hooks: installed ' + hook)
  installed++
}

console.log('install-hooks: ' + installed + ' hook(s) installed.')
