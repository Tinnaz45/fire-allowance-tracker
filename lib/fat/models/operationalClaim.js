// ─── fat.operational_claims (canonical core) ─────────────────────────────────
// Heterogeneous claim types share this core row; type-specific inputs live
// in 1:1 detail tables (see claimDetails.js).
//
// Static accounting record: station_id_snapshot, station_name_snapshot,
// source_calculation_mode, parent_claim_id, copy_source_owner_id, and
// generated_at are immutable after creation. Only `notes`, `status`, and
// `updated_at` are editable.
//
// See DATABASE_ARCHITECTURE_v1.0.md § 2. Operational Claims, and § 6. Sharing.

/** @typedef {'RC'|'RT'|'SB'|'MD'|'DM'|'SM'} ClaimType */
/** @typedef {'draft'|'submitted'|'archived'} OperationalClaimStatus */
/** @typedef {'frv_matrix'|'google_maps'|'manual'} SourceCalculationMode */

/**
 * @typedef {Object} OperationalClaim
 * @property {string}                       id
 * @property {string}                       owner_id                   // → profiles.id
 * @property {ClaimType}                    claim_type
 * @property {string}                       claim_date                 // ISO date
 * @property {number|null}                  station_id_snapshot
 * @property {string|null}                  station_name_snapshot      // bare name
 * @property {SourceCalculationMode|null}   source_calculation_mode
 * @property {OperationalClaimStatus}       status
 * @property {string}                       generated_at
 * @property {string|null}                  notes
 * @property {string|null}                  parent_claim_id            // provenance only; no live sync
 * @property {string|null}                  copy_source_owner_id       // for shared copies
 * @property {string}                       created_at
 * @property {string}                       updated_at
 */

export const OPERATIONAL_CLAIMS_TABLE = 'operational_claims'
