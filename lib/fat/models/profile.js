// ─── fat.profiles (canonical) ────────────────────────────────────────────────
// One row per user. Joined to auth.users by id (FK). Existing prototype
// columns (email, first_name, last_name) are preserved by the rebuild
// foundation; canonical columns are added by `alter table` in
// supabase/canonical/01_canonical_foundation.sql.
//
// `rostered_station_label` is intentionally absent. Per the canonical
// architecture, the in-memory shape is (station_id, bare_name) and
// rostered_station_label is write-only / never hydrated. Do not reintroduce
// prefix-stripping at read time.
//
// See DATABASE_ARCHITECTURE_v1.0.md § 1. Users and Profiles.

/**
 * @typedef {Object} Profile
 * @property {string}        id                    // uuid, = auth.users.id
 * @property {string}        email                 // existing identity column
 * @property {string}        first_name            // existing identity column
 * @property {string}        last_name             // existing identity column
 * @property {string|null}   display_name          // canonical: free-form
 * @property {number|null}   rostered_station_id   // → fat.stations.id; affects future claims only
 * @property {string|null}   home_location_label   // bare label (station-shape conventions)
 * @property {number|null}   home_lat              // optional geocode cache
 * @property {number|null}   home_lng              // optional geocode cache
 * @property {string}        created_at            // timestamptz iso
 * @property {string}        updated_at            // timestamptz iso
 */

export const PROFILES_TABLE = 'profiles'
