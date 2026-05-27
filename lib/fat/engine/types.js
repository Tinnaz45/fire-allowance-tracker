// ─── Entitlement Engine — Typedefs ───────────────────────────────────────────
// Pure JSDoc shapes for the Phase 3 entitlement engine. No runtime exports
// beyond the table constant — all consumers import the typedefs by name.
//
// Contract: ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 2 (boundary), § 3 (output
// shape), § 5 (per-claim generators). The engine NEVER writes to the database.

/** @typedef {import('../models/operationalClaim.js').OperationalClaim} OperationalClaim */
/** @typedef {import('../models/operationalClaim.js').ClaimType}        ClaimType */
/** @typedef {import('../models/claimDetails.js').RecallDetails}        RecallDetails */
/** @typedef {import('../models/claimDetails.js').RetainDetails}        RetainDetails */
/** @typedef {import('../models/claimDetails.js').StandbyDetails}       StandbyDetails */
/** @typedef {import('../models/claimDetails.js').MusterDismissDetails} MusterDismissDetails */
/** @typedef {import('../models/claimDetails.js').DelayedMealDetails}   DelayedMealDetails */
/** @typedef {import('../models/claimDetails.js').SpoiltMealDetails}    SpoiltMealDetails */
/** @typedef {import('../models/rate.js').Rate}                         Rate */
/** @typedef {import('../models/rate.js').RateVersion}                  RateVersion */
/** @typedef {import('../models/claimEntitlement.js').EntitlementUnit}  EntitlementUnit */
/** @typedef {import('../models/claimEntitlement.js').PaymentMethod}    PaymentMethod */
/** @typedef {import('../models/claimEntitlement.js').PaymentStatus}    PaymentStatus */

/**
 * @typedef {Object} ProfileSnapshot
 * @property {string}      id
 * @property {number|null} rostered_station_id
 * @property {string|null} rostered_station_name   // bare name per
 *   project_station_label_canonical_shape (do NOT prefix-strip)
 */

/**
 * @typedef {Object} RateLookupResult
 * @property {Rate}        rate
 * @property {RateVersion} rateVersion
 * @property {number}      value                   // mirror of rateVersion.value for convenience
 */

/**
 * @typedef {Object} StationMatrixHit
 * @property {number} hours                        // FRV Matrix decimal hours
 * @property {string} matrixVersion
 */

/**
 * @callback RateLookup
 * @param {string} code
 * @param {string} claimDate                       // ISO YYYY-MM-DD
 * @returns {RateLookupResult|null}
 */

/**
 * @callback StationMatrixLookup
 * @param {number} fromStationId
 * @param {number} toStationId
 * @param {string} matrixVersion
 * @returns {StationMatrixHit|null}
 */

/**
 * Engine context — the caller-provided lookup surface. The engine reads
 * nothing else; tests inject fakes here.
 *
 * @typedef {Object} EngineContext
 * @property {RateLookup}           rateLookup
 * @property {StationMatrixLookup}  matrixLookup
 * @property {ProfileSnapshot}      profileSnapshot
 */

/**
 * Output row produced by every per-claim generator. Maps 1:1 to a row to
 * be inserted into fat.claim_entitlements after the parent claim insert
 * succeeds. The engine NEVER writes to the database.
 *
 * Invariants (ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 7):
 *   - exactly one of (generated_amount, generated_hours) is non-null
 *   - unit === 'dollars' ⇒ generated_amount non-null, generated_hours null
 *   - unit === 'hours'   ⇒ generated_hours non-null, generated_amount null
 *   - manual_override === false at generation
 *   - edited_amount === edited_hours === edited_note === null at generation
 *   - rule_id and rule_version are non-empty strings
 *   - rate_snapshot is non-null
 *
 * @typedef {Object} EntitlementDraft
 * @property {string}             entitlement_type
 * @property {EntitlementUnit}    unit
 *
 * @property {number|null}        generated_amount
 * @property {number|null}        generated_hours
 * @property {null}               edited_amount
 * @property {null}               edited_hours
 * @property {null}               edited_note
 * @property {false}              manual_override
 *
 * @property {string}             rule_id
 * @property {string}             rule_version
 * @property {string|null}        rule_explanation
 * @property {string|null}        formula_explanation
 *
 * @property {string|null}        rate_id
 * @property {string|null}        rate_version_id
 * @property {object}             rate_snapshot
 *
 * @property {PaymentMethod}      payment_method
 * @property {PaymentStatus}      payment_status
 */

export {}
