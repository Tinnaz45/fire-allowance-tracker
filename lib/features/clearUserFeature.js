import { FEATURE_TABLE, resolveClients } from './client.js'

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
