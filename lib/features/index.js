// ─── Per-user feature flags — public API ─────────────────────────────────────
// The per-user feature layer, backed by the normalized fat.user_feature_flags
// table (canonical migration 19). Import from here:
//
//   import { hasFeature, getUserFeatures } from '@/lib/features'
//
// This is the per-USER feature layer. The GLOBAL, env-only feature gates
// (isPaymentsEnabled) live in lib/featureFlags.js and have a separate
// responsibility — do not conflate the two.
// ─────────────────────────────────────────────────────────────────────────────

export { featureEnabled, hasFeature } from './hasFeature.js'
export { getUserFeatures } from './getUserFeatures.js'
export { setUserFeature } from './setUserFeature.js'
export { clearUserFeature } from './clearUserFeature.js'
