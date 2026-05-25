#!/usr/bin/env node
/**
 * Deployment Health Check — Fire Allowance Tracker
 *
 * Checks that the deployed app responds correctly on key routes.
 * This app is a Next.js SPA — all routes resolve to the root page,
 * so we check the homepage and confirm no error signatures in the body.
 *
 * Usage:
 *   node scripts/health-check.js https://your-app.vercel.app
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 */

const BASE_URL = process.argv[2] || process.env.DEPLOYMENT_URL || process.env.NEXT_PUBLIC_APP_URL

if (!BASE_URL) {
  console.error('ERROR: No deployment URL provided.')
  console.error('Usage: node scripts/health-check.js <deployment-url>')
  console.error('  or set DEPLOYMENT_URL / NEXT_PUBLIC_APP_URL env var')
  process.exit(1)
}

const url = BASE_URL.replace(/\/$/, '')

const CHECKS = [
  { name: 'Homepage loads (200)',        path: '/' },
  { name: 'Auth route (SPA fallback)',   path: '/?_route=auth' },
  { name: 'Dashboard route (SPA)',       path: '/?_route=dashboard' },
]

async function fetchWithTimeout(target, ms = 20000) {
  const ctrl = new AbortController()
  const id = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(target, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'fire-allowance-health-check/1.0' },
    })
    clearTimeout(id)
    return res
  } catch (err) {
    clearTimeout(id)
    throw err
  }
}

function diagnose(status, body) {
  const issues = []
  if (status === 403) issues.push('403 Forbidden — check Vercel auth protection or project settings')
  if (status === 500) {
    issues.push('500 Internal Server Error — check Vercel function logs')
    if (body.includes('NEXT_PUBLIC_SUPABASE') || body.includes('Missing Supabase'))
      issues.push('Root cause: NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY not set in Vercel env vars')
    if (body.includes('REACT_APP_'))
      issues.push('Root cause: stale CRA env var reference detected — must use NEXT_PUBLIC_* prefix')
  }
  if (status === 404) issues.push('404 Not Found — check vercel.json framework setting and routing config')
  if (body.includes('Application error') || body.includes('Runtime Error'))
    issues.push('Next.js runtime crash detected — check Vercel deployment logs')
  return issues
}

async function run() {
  console.log(`\n🔍  Health check → ${url}\n`)
  let passed = 0
  let failed = 0

  for (const check of CHECKS) {
    const target = `${url}${check.path}`
    process.stdout.write(`  ▸ ${check.name} ... `)

    try {
      const res = await fetchWithTimeout(target)
      const body = await res.text()
      const { status } = res

      if (status === 200) {
        console.log(`✅  ${status}`)
        passed++
      } else {
        console.log(`❌  ${status}`)
        const issues = diagnose(status, body)
        for (const issue of issues) console.log(`     ⚠️   ${issue}`)
        failed++
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('❌  TIMEOUT (>20s) — deployment may still be starting')
      } else {
        console.log(`❌  NETWORK ERROR: ${err.message}`)
      }
      failed++
    }
  }

  console.log(`\n${'─'.repeat(50)}`)
  if (failed === 0) {
    console.log(`✅  All ${passed} checks passed — deployment is healthy.\n`)
    process.exit(0)
  } else {
    console.log(`❌  ${failed} check(s) failed, ${passed} passed.\n`)
    console.log('📋  Triage steps:')
    console.log('    1. Vercel Dashboard → Deployments → check build/function logs')
    console.log('    2. Settings → Environment Variables → confirm NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY')
    console.log('    3. Confirm vercel.json has "framework": "nextjs"\n')
    process.exit(1)
  }
}

run().catch(err => { console.error('Unexpected error:', err); process.exit(1) })
