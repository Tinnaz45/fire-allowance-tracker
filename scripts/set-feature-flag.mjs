#!/usr/bin/env node
// ─── Per-user Feature Flag admin (CLI) ───────────────────────────────────────
// Enable or disable a single feature for a single user, by email. Backed by the
// normalized fat.user_feature_flags table (canonical migration 19):
//
//   --enable   →  UPSERT (user_id, feature_name)   (row present = enabled)
//   --disable  →  DELETE  the (user_id, feature_name) row (we never retain
//                 disabled rows; absence IS the disabled state)
//
// Usage:
//   node scripts/set-feature-flag.mjs --email you@example.com --feature payments --enable
//   node scripts/set-feature-flag.mjs --email you@example.com --feature payments --disable
//
// Required env:
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY    (service role — RLS allows writes to service_role only)
//
// Flags:
//   --email EMAIL      User to target. Resolved to a user_id via fat.profiles.
//   --feature NAME     Feature key (e.g. payments, admin, ocr, beta).
//   --enable           Grant the feature (upsert).
//   --disable          Revoke the feature (delete).
//   --dry-run          Resolve the user, but skip the database write.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'

import { setUserFeature, clearUserFeature } from '../lib/features/index.js'


// ── CLI parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { enable: false, disable: false, dryRun: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--email')        out.email   = argv[++i]
    else if (a === '--feature') out.feature = argv[++i]
    else if (a === '--enable')  out.enable  = true
    else if (a === '--disable') out.disable = true
    else if (a === '--dry-run') out.dryRun  = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function printHelp() {
  console.log(`
Per-user feature flag admin

  node scripts/set-feature-flag.mjs --email EMAIL --feature NAME (--enable | --disable) [--dry-run]

Required env:
  NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
`)
}


async function main() {
  const args = parseArgs(process.argv)

  if (args.help) { printHelp(); process.exit(0) }
  if (!args.email)   { console.error('Missing --email');   process.exit(2) }
  if (!args.feature) { console.error('Missing --feature'); process.exit(2) }
  if (args.enable === args.disable) {
    // both false OR both true → ambiguous
    console.error('Specify exactly one of --enable or --disable')
    process.exit(2)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(2)
  }

  // Schema-scoped service-role client. `fat` exposes the feature table; the base
  // `public` client is only needed if we ever resolve via auth admin — here we
  // resolve the user via fat.profiles (id = auth.users id).
  const fat = createClient(url, key, { db: { schema: 'fat' } })

  // ── Resolve email → user_id via fat.profiles (profiles.id references auth.users) ──
  const { data: profile, error: profErr } = await fat
    .from('profiles')
    .select('id, email')
    .eq('email', args.email)
    .maybeSingle()

  if (profErr) { console.error('profile lookup failed:', profErr.message); process.exit(1) }
  if (!profile) {
    console.error(`No user found for email ${args.email}`)
    process.exit(1)
  }

  const action = args.enable ? 'enable' : 'disable'
  console.log(`${args.dryRun ? '[dry-run] ' : ''}${action} feature "${args.feature}" for ${args.email} (${profile.id})`)

  if (args.dryRun) { process.exit(0) }

  // setUserFeature/clearUserFeature accept an injected client pair; pass the
  // service-role `fat` client so the shared library performs the write.
  const client = { fat, supabase: fat }
  const { error } = args.enable
    ? await setUserFeature(profile.id, args.feature, { client, updatedBy: profile.id })
    : await clearUserFeature(profile.id, args.feature, { client })

  if (error) { console.error(`${action} failed:`, error.message); process.exit(1) }

  console.log(`✓ ${action}d`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
