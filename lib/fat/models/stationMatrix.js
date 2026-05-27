// ─── Station distance + time matrices (canonical) ────────────────────────────
// Sparse station↔station matrices from the FRV Matrix. Versioning is at the
// row level via `matrix_version` so multiple matrix releases can coexist.
// The time matrix stores DECIMAL HOURS — the engine is responsible for
// converting matrix hours to payable dollars
// (ENTITLEMENT_RULES_v1.0.md § FRV Matrix Hours → Payable Bridge).

/**
 * @typedef {Object} StationDistanceMatrixRow
 * @property {number} from_station_id
 * @property {number} to_station_id
 * @property {string} matrix_version
 * @property {number} distance_km
 */

/**
 * @typedef {Object} StationTimeMatrixRow
 * @property {number} from_station_id
 * @property {number} to_station_id
 * @property {string} matrix_version
 * @property {number} hours        // 0.25-hour increments expected
 */

export const STATION_DISTANCE_MATRIX_TABLE = 'station_distance_matrix'
export const STATION_TIME_MATRIX_TABLE = 'station_time_matrix'
