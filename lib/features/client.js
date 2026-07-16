// ─── Per-user feature flags — internal client resolution ─────────────────────
// Shared plumbing for the per-user feature layer. NOT part of the public API —
// import the feature functions from ./index.js (the module's single public entry
// point) instead.
//
// Persistence model lives in the normalized fat.user_feature_flags table
// (canonical migration 19): "row presence IS the boolean".
//   row (user_id, feature_name) exists  →  feature ENABLED for that user
//   no row                              →  feature DISABLED for that user
//
// The feature helpers touch Supabase, so they are async and require a client. To
// keep them import-pure (importable with no Supabase env vars present, e.g. in
// unit tests), the shared client is loaded LAZILY here only when a caller doesn't
// inject one. Callers that already hold a client (server routes, the admin CLI's
// service-role client, tests) should pass it in.
// ─────────────────────────────────────────────────────────────────────────────

export const FEATURE_TABLE = 'user_feature_flags'

/**
 * Resolve the { supabase, fat } client pair. Returns the injected client when
 * provided; otherwise lazily imports the shared browser/SSR client. Kept lazy so
 * importing the feature modules never requires Supabase env vars.
 * @param {{ supabase?: any, fat?: any }} [injected]
 * @returns {Promise<{ supabase: any, fat: any }>}
 */
export async function resolveClients(injected) {
  if (injected && injected.fat) {
    return { supabase: injected.supabase || injected.fat, fat: injected.fat }
  }
  const mod = await import('../supabaseClient.js')
  return { supabase: mod.supabase, fat: mod.fat }
}
