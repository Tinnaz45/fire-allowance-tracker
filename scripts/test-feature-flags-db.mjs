// Unit tests for the per-user feature layer in lib/featureFlags.js:
//   getUserFeatures / setUserFeature / clearUserFeature / hasFeature / featureEnabled
//
// Backed by the normalized fat.user_feature_flags model ("row presence IS the
// boolean"). No network/DB: a tiny in-memory fake Supabase client implements the
// exact subset of the query builder the feature layer uses, so this runs fully
// offline against the REAL library code. Run: node scripts/test-feature-flags-db.mjs
//
// Coverage (per spec): enable, disable, duplicate enable, duplicate disable,
// multiple users, multiple features, and missing-row == disabled.

import {
  getUserFeatures,
  setUserFeature,
  clearUserFeature,
  hasFeature,
  featureEnabled,
} from '../lib/featureFlags.js'

// ── In-memory fake Supabase client ───────────────────────────────────────────
// Models one table (user_feature_flags) as an array of rows. The builder is a
// thenable that accumulates .eq() filters and resolves to { data, error } —
// mirroring @supabase/supabase-js for select / upsert / delete / maybeSingle.

function makeStore() {
  return { user_feature_flags: [] }
}

class Query {
  constructor(store, table) {
    this.store = store
    this.table = table
    this._op = 'select'
    this._filters = []
    this._single = false
    this._row = null
  }
  select() { this._op = this._op === 'select' ? 'select' : this._op; return this }
  eq(col, val) { this._filters.push([col, val]); return this }
  maybeSingle() { this._single = true; return this }
  upsert(row) { this._op = 'upsert'; this._row = row; return this }
  delete() { this._op = 'delete'; return this }

  _match(r) { return this._filters.every(([c, v]) => r[c] === v) }

  _execute() {
    const rows = this.store[this.table]
    if (this._op === 'select') {
      const hits = rows.filter((r) => this._match(r))
      if (this._single) return { data: hits[0] ? { ...hits[0] } : null, error: null }
      return { data: hits.map((r) => ({ ...r })), error: null }
    }
    if (this._op === 'upsert') {
      const r = this._row
      const idx = rows.findIndex(
        (x) => x.user_id === r.user_id && x.feature_name === r.feature_name,
      )
      if (idx >= 0) rows[idx] = { ...rows[idx], ...r }
      else rows.push({ ...r })
      return { error: null }
    }
    if (this._op === 'delete') {
      this.store[this.table] = rows.filter((r) => !this._match(r))
      return { error: null }
    }
    return { data: null, error: null }
  }
  then(resolve, reject) { return Promise.resolve(this._execute()).then(resolve, reject) }
}

function makeClient(store, user) {
  const fat = { from: (t) => new Query(store, t) }
  const supabase = {
    from: (t) => new Query(store, t),
    auth: { getUser: async () => ({ data: { user: user || null }, error: null }) },
  }
  return { fat, supabase }
}

// ── Harness ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0
function expect(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  const ok = g === w
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(60)} got=${g}  want=${w}`)
  if (ok) pass++; else fail++
}

const USER_A = '11111111-1111-1111-1111-111111111111'
const USER_B = '22222222-2222-2222-2222-222222222222'

await (async function run() {
  // ── featureEnabled() — pure object-shape check ──────────────────────────────
  expect('featureEnabled: key true → true', featureEnabled({ payments: true }, 'payments'), true)
  expect('featureEnabled: missing key → false', featureEnabled({ payments: true }, 'admin'), false)
  expect('featureEnabled: null object → false', featureEnabled(null, 'payments'), false)

  // ── enable feature ──────────────────────────────────────────────────────────
  {
    const store = makeStore()
    const client = makeClient(store, { id: USER_A })
    await setUserFeature(USER_A, 'payments', { client })
    expect('enable: row created', store.user_feature_flags.length, 1)
    expect('enable: getUserFeatures reconstructs object',
      await getUserFeatures({ userId: USER_A, client }), { payments: true })
  }

  // ── disable feature (delete, no retained row) ───────────────────────────────
  {
    const store = makeStore()
    const client = makeClient(store, { id: USER_A })
    await setUserFeature(USER_A, 'payments', { client })
    await clearUserFeature(USER_A, 'payments', { client })
    expect('disable: row deleted (none retained)', store.user_feature_flags.length, 0)
    expect('disable: getUserFeatures empty', await getUserFeatures({ userId: USER_A, client }), {})
  }

  // ── duplicate enable (idempotent upsert) ────────────────────────────────────
  {
    const store = makeStore()
    const client = makeClient(store, { id: USER_A })
    await setUserFeature(USER_A, 'payments', { client })
    await setUserFeature(USER_A, 'payments', { client })
    expect('duplicate enable: still exactly one row', store.user_feature_flags.length, 1)
    expect('duplicate enable: object unchanged',
      await getUserFeatures({ userId: USER_A, client }), { payments: true })
  }

  // ── duplicate disable (idempotent delete) ───────────────────────────────────
  {
    const store = makeStore()
    const client = makeClient(store, { id: USER_A })
    await setUserFeature(USER_A, 'payments', { client })
    await clearUserFeature(USER_A, 'payments', { client })
    const second = await clearUserFeature(USER_A, 'payments', { client }) // no row → no-op
    expect('duplicate disable: no error', second.error, null)
    expect('duplicate disable: still zero rows', store.user_feature_flags.length, 0)
  }

  // ── multiple users (isolation) ──────────────────────────────────────────────
  {
    const store = makeStore()
    const clientA = makeClient(store, { id: USER_A })
    const clientB = makeClient(store, { id: USER_B })
    await setUserFeature(USER_A, 'payments', { client: clientA })
    await setUserFeature(USER_B, 'admin', { client: clientB })
    expect('multi-user: A sees only own', await getUserFeatures({ userId: USER_A, client: clientA }), { payments: true })
    expect('multi-user: B sees only own', await getUserFeatures({ userId: USER_B, client: clientB }), { admin: true })
  }

  // ── multiple features for one user ──────────────────────────────────────────
  {
    const store = makeStore()
    const client = makeClient(store, { id: USER_A })
    await setUserFeature(USER_A, 'payments', { client })
    await setUserFeature(USER_A, 'admin', { client })
    await setUserFeature(USER_A, 'ocr', { client })
    expect('multi-feature: all reconstructed',
      await getUserFeatures({ userId: USER_A, client }),
      { payments: true, admin: true, ocr: true })
  }

  // ── missing row == disabled ─────────────────────────────────────────────────
  {
    const store = makeStore()
    const client = makeClient(store, { id: USER_A })
    expect('missing: getUserFeatures empty', await getUserFeatures({ userId: USER_A, client }), {})
    process.env.NODE_ENV = 'development' // global flag ON via dev resolver
    expect('missing: hasFeature false', await hasFeature('payments', { client }), false)
  }

  // ── hasFeature: global gate AND auth AND row ────────────────────────────────
  {
    const store = makeStore()
    const client = makeClient(store, { id: USER_A })
    await setUserFeature(USER_A, 'payments', { client })

    process.env.NODE_ENV = 'development' // global ON
    expect('hasFeature: global ON + auth + row → true', await hasFeature('payments', { client }), true)
    expect('hasFeature: row absent → false', await hasFeature('admin', { client }), false)

    // Global flag forced OFF overrides everything (condition 1).
    process.env.NEXT_PUBLIC_PAYMENTS_ENABLED = 'off'
    expect('hasFeature: global OFF → false even with row', await hasFeature('payments', { client }), false)
    delete process.env.NEXT_PUBLIC_PAYMENTS_ENABLED

    // No authenticated user (condition 2).
    const anon = makeClient(store, null)
    process.env.NODE_ENV = 'development'
    expect('hasFeature: no auth user → false', await hasFeature('payments', { client: anon }), false)
  }

  console.log()
  console.log(`Total: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
})()
