// ─── Distance Cache Persistence ───────────────────────────────────────────────
// Supabase read/write layer for:
//   - fat.home_address      (geocoded home coordinates, version tracking)
//   - fat.station_distances (cached confirmed distances, staleness tracking)
//
// All operations are user-isolated via Supabase RLS (user_id = auth.uid()).
// This module never triggers recalculation — it only persists/retrieves data.
// ─────────────────────────────────────────────────────────────────────────────

import { fat } from '@/lib/supabaseClient'

// ─── Address normalisation ────────────────────────────────────────────────────
// Used as the "hash" — a consistent fingerprint for change detection.
// Lowercased, whitespace-collapsed, trimmed.

export function normaliseAddress(address) {
  if (!address) return ''
  return address.toLowerCase().replace(/\s+/g, ' ').trim()
}

// ─── Home Address ─────────────────────────────────────────────────────────────

/**
 * Load the geocoded home address record for a user.
 * Returns null if no record exists yet.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getHomeAddress(userId) {
  const { data, error } = await fat
    .from('home_address')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('[addressCache] getHomeAddress error:', error)
    return null
  }
  return data || null
}

/**
 * Save (upsert) a geocoded home address record.
 * Increments address_version if the address_hash has changed.
 * @param {string} userId
 * @param {string} addressText  Raw address string from profile
 * @param {number|null} lat
 * @param {number|null} lng
 * @param {string} geocodeStatus  'ok' | 'failed' | 'pending'
 * @returns {Promise<object>}  The saved row
 */
export async function saveHomeAddress(userId, addressText, lat, lng, geocodeStatus) {
  const hash = normaliseAddress(addressText)

  // Get existing record to detect version changes
  const existing = await getHomeAddress(userId)
  const addressChanged = existing && existing.address_hash !== hash
  const newVersion = existing
    ? (addressChanged ? existing.address_version + 1 : existing.address_version)
    : 1

  const row = {
    user_id:         userId,
    address_text:    addressText,
    address_hash:    hash,
    lat:             lat ?? null,
    lng:             lng ?? null,
    geocoded_at:     geocodeStatus === 'ok' ? new Date().toISOString() : null,
    geocode_status:  geocodeStatus,
    address_version: newVersion,
    updated_at:      new Date().toISOString(),
  }

  const { data, error } = await fat
    .from('home_address')
    .upsert(row, { onConflict: 'user_id' })
    .select()
    .single()

  if (error) {
    console.error('[addressCache] saveHomeAddress error:', error)
    throw new Error('Failed to save geocoded home address.')
  }

  return { data, addressChanged, newVersion }
}

// ─── Station Distances ────────────────────────────────────────────────────────

/**
 * Get the cached distance record for a user + station pair.
 * Returns null if no record exists.
 * @param {string} userId
 * @param {number} stationId
 * @returns {Promise<object|null>}
 */
export async function getStationDistance(userId, stationId) {
  const { data, error } = await fat
    .from('station_distances')
    .select('*')
    .eq('user_id', userId)
    .eq('station_id', stationId)
    .maybeSingle()

  if (error) {
    console.error('[addressCache] getStationDistance error:', error)
    return null
  }
  return data || null
}

/**
 * Upsert a station distance estimate (before user confirmation).
 * Does NOT set confirmed_distance_km — that requires explicit user action.
 * @param {string} userId
 * @param {number} stationId
 * @param {string} homeAddressHash
 * @param {number} homeAddressVersion
 * @param {number} estimatedDistanceKm
 * @param {number|null} stationLat
 * @param {number|null} stationLng
 */
export async function saveDistanceEstimate(
  userId,
  stationId,
  homeAddressHash,
  homeAddressVersion,
  estimatedDistanceKm,
  stationLat,
  stationLng
) {
  const row = {
    user_id:               userId,
    station_id:            stationId,
    home_address_hash:     homeAddressHash,
    home_address_version:  homeAddressVersion,
    estimated_distance_km: estimatedDistanceKm,
    // Explicitly clear any previous confirmed distance — user must re-confirm
    // after every recalculate. Without this, a stale confirmed_distance_km would
    // silently persist on the next component mount and skip re-confirmation.
    confirmed_distance_km: null,
    confirmation_source:   null,
    confirmed_at:          null,
    station_lat:           stationLat ?? null,
    station_lng:           stationLng ?? null,
    station_geocoded_at:   stationLat ? new Date().toISOString() : null,
    is_stale:              false,
    stale_reason:          null,
    updated_at:            new Date().toISOString(),
  }

  const { error } = await fat
    .from('station_distances')
    .upsert(row, { onConflict: 'user_id,station_id' })

  if (error) {
    console.error('[addressCache] saveDistanceEstimate error:', error)
    // Non-fatal — estimate was calculated; persist failure shouldn't block UI
  }
}

/**
 * Persist a user-confirmed station distance.
 * @param {string} userId
 * @param {number} stationId
 * @param {string} homeAddressHash
 * @param {number} homeAddressVersion
 * @param {number} estimatedDistanceKm
 * @param {number} confirmedDistanceKm
 * @param {'auto'|'manual'} confirmationSource
 * @param {number|null} stationLat
 * @param {number|null} stationLng
 */
export async function saveConfirmedDistance(
  userId,
  stationId,
  homeAddressHash,
  homeAddressVersion,
  estimatedDistanceKm,
  confirmedDistanceKm,
  confirmationSource,
  stationLat,
  stationLng
) {
  const row = {
    user_id:               userId,
    station_id:            stationId,
    home_address_hash:     homeAddressHash,
    home_address_version:  homeAddressVersion,
    estimated_distance_km: estimatedDistanceKm,
    confirmed_distance_km: confirmedDistanceKm,
    confirmation_source:   confirmationSource,
    confirmed_at:          new Date().toISOString(),
    station_lat:           stationLat ?? null,
    station_lng:           stationLng ?? null,
    station_geocoded_at:   stationLat ? new Date().toISOString() : null,
    is_stale:              false,
    stale_reason:          null,
    updated_at:            new Date().toISOString(),
  }

  const { error } = await fat
    .from('station_distances')
    .upsert(row, { onConflict: 'user_id,station_id' })

  if (error) {
    console.error('[addressCache] saveConfirmedDistance error:', error)
    throw new Error('Failed to save confirmed station distance.')
  }
}

/**
 * Mark ALL cached station distances for a user as stale.
 * Called when the user updates their home address.
 * Does NOT touch existing submitted claims — those are immutable.
 * @param {string} userId
 * @param {string} reason  e.g. 'home_address_changed'
 */
export async function markAllDistancesStale(userId, reason = 'home_address_changed') {
  const { error } = await fat
    .from('station_distances')
    .update({
      is_stale:    true,
      stale_reason: reason,
      updated_at:  new Date().toISOString(),
    })
    .eq('user_id', userId)

  if (error) {
    console.error('[addressCache] markAllDistancesStale error:', error)
    // Non-fatal — staleness marking failure is recoverable at next use
  }
}
