// ─── fat.rates / fat.rate_versions (canonical) ───────────────────────────────
// Canonical configurable allowance values + append-only version history.
// New claims snapshot the version that applies on claim_date into
// claim_entitlements.rate_snapshot at generation time. Historical claims
// NEVER re-query rates. See DATABASE_ARCHITECTURE_v1.0.md § 4. Rates.

/** @typedef {'dollars'|'dollars_per_km'|'hours'} RateUnit */

/**
 * @typedef {Object} Rate
 * @property {string}      id
 * @property {string}      code               // e.g. 'small_meal', 'travel_per_km'
 * @property {string}      display_name
 * @property {RateUnit}    unit
 * @property {string|null} active_version_id  // → rate_versions.id
 * @property {string}      created_at
 */

/**
 * @typedef {Object} RateVersion
 * @property {string} id
 * @property {string} rate_id          // → rates.id
 * @property {string} version_label    // e.g. '2026-07-01-eba'
 * @property {number} value
 * @property {string} effective_from   // ISO date (YYYY-MM-DD)
 * @property {string} created_at
 * @property {string|null} created_by  // → profiles.id
 */

export const RATES_TABLE = 'rates'
export const RATE_VERSIONS_TABLE = 'rate_versions'
