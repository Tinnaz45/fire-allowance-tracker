#!/usr/bin/env node
/**
 * install-hooks.mjs - Fire Allowance Tracker
 *
 * Installs git hooks from scripts/hooks/ into the repository's hooks directory.
 * Run automatically via `npm install` (package.json "prepare" script).
 * Safe to re-run; overwrites stale hooks. Works from the primary checkout and
 * from a linked worktree (hooks are shared via the common gitdir).
 *
 * Usage:
 *   node scripts/install-hooks.mjs
 *   npm install   (runs automatically via "prepare")
 */

import { copyFileSync, chmodSync, existsSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const HOOKS_SRC = join(ROOT, 'scripts', 'hooks')

const HOOKS = ['pre-commit', 'pre-push']

// Ask git where hooks live rather than assuming `.git` is a directory. In a
// linked worktree `.git` is a *file* pointing at the real gitdir, so a
// hard-coded `.git/hooks` fails with ENOTDIR and takes `npm install` down with
// it. `git rev-parse --git-path hooks` resolves to the shared common-dir hooks
// from both the primary checkout and any worktree, and honours a custom
// `core.hooksPath`. Isolated worktrees are the default workflow — CLAUDE.md §3.
let HOOKS_DEST
try {
  HOOKS_DEST = resolve(
    ROOT,
    execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  )
} catch {
  console.log('install-hooks: not a git repo (or git unavailable), skipping.')
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
