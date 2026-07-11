import { isPaymentsEnabled } from '../featureFlags.js'
import { FEATURE_TABLE, resolveClients } from './client.js'

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
 * Does the feature gate open for the current request? Behaviour is the
 * conjunction of THREE conditions (all must hold):
 *   1. the existing global feature flag is enabled (isPaymentsEnabled), AND
 *   2. an authenticated user exists, AND
 *   3. a matching (user_id, feature_name) row exists.
 * Any failure → false (fail-safe).
 *
 * @param {string} name  Feature key to check.
 * @param {object} [opts]
 * @param {string} [opts.userId]  Pre-resolved user id. Server-side callers that
 *   have already authenticated the request pass it (mirroring getUserFeatures) to
 *   skip a second auth round-trip; browser callers omit it and the authenticated
 *   user is resolved from the session.
 * @param {{ supabase?: any, fat?: any }} [opts.client]  Injected client pair.
 * @returns {Promise<boolean>}
 */
export async function hasFeature(name, opts = {}) {
  // 1. Global gate — never expose a per-user feature when the global flag is off.
  if (!isPaymentsEnabled()) return false

  const { supabase, fat } = await resolveClients(opts.client)

  // 2. Authenticated user required (resolved from the session unless supplied).
  let userId = opts.userId
  if (!userId) {
    const { data: { user } = {}, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return false
    userId = user.id
  }

  // 3. Matching row → enabled. No row → disabled.
  const { data, error } = await fat
    .from(FEATURE_TABLE)
    .select('feature_name')
    .eq('user_id', userId)
    .eq('feature_name', name)
    .maybeSingle()

  if (error || !data) return false
  return true
}
