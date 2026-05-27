// ─── Claim-Type Detail Tables (canonical) ────────────────────────────────────
// One row per parent operational_claim, joined 1:1 on `claim_id`. Detail
// tables hold ONLY type-specific input fields — never recomputed outputs
// (those live on claim_entitlements).
//
// Forward-only: new claim types add new detail tables. Existing detail
// tables MUST NOT be widened to model unrelated claim types.
//
// See DATABASE_ARCHITECTURE_v1.0.md § 2. Operational Claims (Detail Tables).

/**
 * @typedef {Object} RecallDetails
 * @property {string}        claim_id
 * @property {number|null}   recall_station_id
 * @property {string|null}   recall_start_at
 * @property {string|null}   recall_end_at
 * @property {number|null}   travel_distance_km    // Google Maps; manual override allowed
 * @property {'google_maps'|'manual'|null} travel_source
 * @property {boolean|null}  meal_break_taken
 */

/**
 * @typedef {Object} RetainDetails
 * @property {string}        claim_id
 * @property {string|null}   retain_start_at
 * @property {string|null}   retain_end_at
 * @property {boolean|null}  meal_break_taken
 */

/**
 * @typedef {Object} StandbyDetails
 * @property {string}        claim_id
 * @property {number|null}   standby_station_id
 * @property {string|null}   standby_start_at
 * @property {string|null}   standby_end_at
 * @property {number|null}   matrix_distance_km    // FRV Matrix only
 * @property {number|null}   matrix_hours          // FRV Matrix Index sheet decimal hours
 * @property {string|null}   matrix_version
 */

/**
 * @typedef {Object} MusterDismissDetails
 * @property {string}        claim_id
 * @property {number|null}   md_station_id
 * @property {string|null}   md_event_at
 * @property {number|null}   matrix_distance_km
 * @property {number|null}   matrix_hours
 * @property {string|null}   matrix_version
 */

/**
 * @typedef {Object} DelayedMealDetails
 * @property {string}        claim_id
 * @property {string|null}   meal_window_start_at
 * @property {string|null}   meal_window_end_at
 * @property {string|null}   actual_meal_at        // NULL if no meal was taken
 */

/**
 * @typedef {Object} SpoiltMealDetails
 * @property {string}        claim_id
 * @property {string|null}   meal_provisioned_at
 * @property {string|null}   spoilt_reason         // free-text
 */

export const DETAIL_TABLE_BY_CLAIM_TYPE = {
  RC: 'recall_details',
  RT: 'retain_details',
  SB: 'standby_details',
  MD: 'muster_dismiss_details',
  DM: 'delayed_meal_details',
  SM: 'spoilt_meal_details',
}
