// ─── fat.stations (canonical) ────────────────────────────────────────────────
// Stations are first-class records with both a numeric ID and a bare name.
// In-memory shape is (station_id, bare_name). See
// ALLOWANCE_ARCHITECTURE_v1.0.md § Station Model and
// DATABASE_ARCHITECTURE_v1.0.md § 5. Stations and Travel Reference Data.

/**
 * @typedef {Object} Station
 * @property {number}        id              // station number; stable PK
 * @property {string}        name            // bare name
 * @property {string|null}   district        // canonical
 * @property {string|null}   street_address  // canonical
 * @property {number|null}   lat
 * @property {number|null}   lng
 * @property {boolean}       is_active       // canonical name in doc is `active`; existing column is is_active
 * @property {string}        created_at
 * @property {string}        updated_at
 */

export const STATIONS_TABLE = 'stations'
