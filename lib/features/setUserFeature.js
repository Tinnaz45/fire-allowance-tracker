import { FEATURE_TABLE, resolveClients } from './client.js'

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
