// ─── Feature flags ────────────────────────────────────────────────────────────
// Centralised, SSR-safe feature gates. Each resolver is a PURE function of
// NEXT_PUBLIC_* env vars (and NODE_ENV) only — no `window`, no React — so it
// evaluates identically on the server and the client (no hydration mismatch) and
// can be imported from any client component, page, or server route.
//
// ── Payments / Reconciliation feature ────────────────────────────────────────
// The recovered Payments + payslip-reconciliation surface (the `/payments` and
// `/payments/imports` routes and the Payments nav tab) depends on canonical /
// reconciliation / payslip backend that is applied in DEV but NOT yet in PROD.
// Until the PROD schema rollout (fat-parity phases 3–6) completes, it must stay
// hidden from production users.
//
// Resolution order for isPaymentsEnabled():
//   1. Explicit override — NEXT_PUBLIC_PAYMENTS_ENABLED = true|1|on  / false|0|off
//   2. Local dev server   — NODE_ENV !== 'production'                → ON (localhost)
//   3. DEV deployment     — NEXT_PUBLIC_SUPABASE_URL targets DEV ref → ON
//   4. Anything else (PROD / unknown target)                        → OFF
//      (fail-safe: the feature is never exposed unless positively enabled)
// ─────────────────────────────────────────────────────────────────────────────

// DEV (Testing) Supabase project ref — the same identifier the DEV-only test
// scripts guard on. PROD (Live) is `wgcqzamuspuqpedqasbc`.
const DEV_SUPABASE_REF = 'kctctvpobbizhkiqkgqw'

/**
 * Parse a tri-state boolean env flag. Returns true/false for recognised values,
 * or undefined when unset/blank/unrecognised so the caller falls through to its
 * environment defaults.
 * @param {string|undefined} raw
 * @returns {boolean|undefined}
 */
function parseBoolFlag(raw) {
  if (raw == null) return undefined
  const v = String(raw).trim().toLowerCase()
  if (v === '') return undefined
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(v)) return true
  if (['0', 'false', 'off', 'no', 'disabled'].includes(v)) return false
  return undefined
}

/**
 * Is the Payments / Reconciliation feature enabled in this environment?
 * SSR-safe and deterministic (env-only). See the resolution order above.
 * @returns {boolean}
 */
export function isPaymentsEnabled() {
  // 1. Explicit override always wins (set NEXT_PUBLIC_PAYMENTS_ENABLED in any env).
  const explicit = parseBoolFlag(process.env.NEXT_PUBLIC_PAYMENTS_ENABLED)
  if (explicit !== undefined) return explicit

  // 2. Local dev server (`npm run dev`) → enabled.
  if (process.env.NODE_ENV !== 'production') return true

  // 3. Built/deployed: enable only when pointed at the DEV Supabase project.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (url.includes(DEV_SUPABASE_REF)) return true

  // 4. PROD (or any unrecognised target) → disabled, fail-safe.
  return false
}


// ─── Per-user feature flags ─────────────────────────────────────────────────
// Backed by the normalized fat.user_feature_flags table (canonical migration
// 19). The persistence model is "row presence IS the boolean":
//
//     row (user_id, feature_name) exists  →  feature ENABLED for that user
//     no row                              →  feature DISABLED for that user
//
// The application keeps consuming the SAME object shape it always has — e.g.
//   { payments: true, admin: true, ocr: true, beta: true }
// getUserFeatures() reconstructs exactly that object from the rows.
//
// These helpers touch Supabase, so — unlike isPaymentsEnabled() above — they are
// async and require a client. To keep THIS module SSR-safe and import-pure (the
// env resolvers must stay importable with no Supabase env vars present, e.g. in
// unit tests), the shared client is loaded LAZILY via dynamic import only when a
// caller doesn't inject one. Callers that already hold a client (server routes,
// the admin CLI's service-role client, tests) should pass it in.
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE_TABLE = 'user_feature_flags'

/**
 * Resolve the { supabase, fat } client pair. Returns the injected client when
 * provided; otherwise lazily imports the shared browser/SSR client. Kept lazy so
 * importing this module never requires Supabase env vars.
 * @param {{ supabase?: any, fat?: any }} [injected]
 * @returns {Promise<{ supabase: any, fat: any }>}
 */
async function resolveClients(injected) {
  if (injected && injected.fat) {
    return { supabase: injected.supabase || injected.fat, fat: injected.fat }
  }
  const mod = await import('./supabaseClient.js')
  return { supabase: mod.supabase, fat: mod.fat }
}

/**
 * Pure object-shape check — is `name` enabled in an already-loaded features
 * object? Row presence reconstructs to `true`, so a feature is enabled iff its
 * key is strictly `true`. Null/undefined features object → false (fail-safe).
 * @param {Record<string, boolean>|null|undefined} features
 * @param {string} name
 * @returns {boolean}
 */
export function featureEnabled(features, name) {
  return Boolean(features) && features[name] === true
}

/**
 * Load every enabled feature for a user and reconstruct the canonical object
 * shape ({ payments: true, ... }). One key per row; value is always `true`
 * because a row's mere existence means "enabled". A user with no rows → {}.
 *
 * @param {object} [opts]
 * @param {string} [opts.userId]  Explicit user id. When omitted, the
 *   authenticated user is resolved via supabase.auth.getUser().
 * @param {{ supabase?: any, fat?: any }} [opts.client]  Injected client pair.
 * @returns {Promise<Record<string, true>>}
 */
export async function getUserFeatures(opts = {}) {
  const { supabase, fat } = await resolveClients(opts.client)

  let userId = opts.userId
  if (!userId) {
    const { data: { user } = {}, error } = await supabase.auth.getUser()
    if (error || !user) return {}
    userId = user.id
  }

  const { data, error } = await fat
    .from(FEATURE_TABLE)
    .select('feature_name')
    .eq('user_id', userId)

  if (error || !data) return {}

  const features = {}
  for (const row of data) features[row.feature_name] = true
  return features
}

/**
 * Does the feature gate open for the current request? Behaviour is the
 * conjunction of THREE conditions (all must hold):
 *   1. the existing global feature flag is enabled (isPaymentsEnabled), AND
 *   2. an authenticated user exists, AND
 *   3. a matching (user_id, feature_name) row exists.
 * Any failure → false (fail-safe).
 *
 * @param {string} name  Feature key to check.
 * @param {object} [opts]
 * @param {{ supabase?: any, fat?: any }} [opts.client]  Injected client pair.
 * @returns {Promise<boolean>}
 */
export async function hasFeature(name, opts = {}) {
  // 1. Global gate — never expose a per-user feature when the global flag is off.
  if (!isPaymentsEnabled()) return false

  const { supabase, fat } = await resolveClients(opts.client)

  // 2. Authenticated user required.
  const { data: { user } = {}, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return false

  // 3. Matching row → enabled. No row → disabled.
  const { data, error } = await fat
    .from(FEATURE_TABLE)
    .select('feature_name')
    .eq('user_id', user.id)
    .eq('feature_name', name)
    .maybeSingle()

  if (error || !data) return false
  return true
}

/**
 * Enable a feature for a user — UPSERT (user_id, feature_name). Idempotent: a
 * second enable of the same pair refreshes updated_at/updated_by without
 * creating a duplicate (the composite PK is the conflict target). Requires a
 * service-role client (RLS permits writes to service_role only).
 *
 * @param {string} userId
 * @param {string} name
 * @param {object} [opts]
 * @param {string} [opts.updatedBy]  Actor id recorded on the row (audit).
 * @param {{ supabase?: any, fat?: any }} [opts.client]  Injected client pair.
 * @returns {Promise<{ error: any }>}
 */
export async function setUserFeature(userId, name, opts = {}) {
  const { fat } = await resolveClients(opts.client)
  const row = { user_id: userId, feature_name: name, updated_at: new Date().toISOString() }
  if (opts.updatedBy) row.updated_by = opts.updatedBy
  const { error } = await fat
    .from(FEATURE_TABLE)
    .upsert(row, { onConflict: 'user_id,feature_name' })
  return { error }
}

/**
 * Disable a feature for a user — DELETE the row. We do NOT retain disabled rows;
 * absence is the disabled state. Idempotent: deleting a non-existent row is a
 * no-op success. Requires a service-role client.
 *
 * @param {string} userId
 * @param {string} name
 * @param {object} [opts]
 * @param {{ supabase?: any, fat?: any }} [opts.client]  Injected client pair.
 * @returns {Promise<{ error: any }>}
 */
export async function clearUserFeature(userId, name, opts = {}) {
  const { fat } = await resolveClients(opts.client)
  const { error } = await fat
    .from(FEATURE_TABLE)
    .delete()
    .eq('user_id', userId)
    .eq('feature_name', name)
  return { error }
}
