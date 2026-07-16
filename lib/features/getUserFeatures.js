import { FEATURE_TABLE, resolveClients } from './client.js'

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
