// ─── Travel Display Formatting ───────────────────────────────────────────────
// Single source of truth for how travel DISTANCES and TIMES are rendered to the
// user anywhere in the app. Centralising these rules means a screen never has
// to re-implement the rounding policy and they can never silently drift apart.
//
// Global display rules (informational display only — these NEVER feed back into
// entitlement calculations, which keep their own raw precision):
//   - Travel distances round UP to the next whole kilometre   (Math.ceil km).
//   - Travel times      round UP to the next whole minute      (Math.ceil min).
//   - When a travel time is shown alongside hours, the hours round UP to the
//     next 0.25 h using the same ceiling-to-15-minutes rule the entitlement
//     engine uses elsewhere (Math.ceil(minutes / 15) * 0.25).
//
// Every function tolerates null / NaN / non-positive inputs and returns null so
// callers can render a neutral placeholder (e.g. "—") without guarding first.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Round a distance in km UP to the next whole kilometre.
 * @param {number|string|null} km
 * @returns {number|null} whole kilometres, or null when not a positive number
 */
export function roundUpKm(km) {
  const n = Number(km)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.ceil(n)
}

/**
 * Format a one-way (or any) travel distance for display, rounded up to the
 * next whole kilometre. e.g. 12.1 → "13 km".
 * @param {number|string|null} km
 * @returns {string|null}
 */
export function formatTravelDistanceKm(km) {
  const n = roundUpKm(km)
  return n == null ? null : `${n} km`
}

/**
 * Round a duration in seconds UP to the next whole minute.
 * @param {number|string|null} seconds
 * @returns {number|null} whole minutes, or null when not a positive number
 */
export function roundUpMinutes(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.ceil(n / 60)
}

/**
 * Format a travel time (given in seconds) for display, rounded up to the next
 * whole minute. Under an hour reads as "23 min"; an hour or more reads as
 * "1 hr 5 min" (or "2 hr" when the minutes round to a whole hour).
 * @param {number|string|null} seconds
 * @returns {string|null}
 */
export function formatTravelTime(seconds) {
  const mins = roundUpMinutes(seconds)
  if (mins == null) return null
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`
}

/**
 * Round a whole-minute duration UP to the next quarter hour (0.25 h). This is
 * the same ceiling-to-15-minutes rule the entitlement engine applies elsewhere
 * (see lib/calculations/engine.js: Math.ceil(elapsed / 15) * 0.25), reused here
 * purely for an informational display. e.g. 59 → 1, 60 → 1, 61 → 1.25.
 * @param {number|string|null} minutes
 * @returns {number|null} hours in 0.25 steps, or null for invalid input
 */
export function roundUpToQuarterHour(minutes) {
  const n = Number(minutes)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.ceil(n / 15) * 0.25
}

/**
 * Format a travel time (given in seconds) for the One-Way Travel Time display,
 * showing the rounded-up minutes AND the quarter-hour-rounded hours alongside.
 * e.g. 59 min → "59 min (1.00 hr)"; 65 min → "1 hr 5 min (1.25 hr)".
 * @param {number|string|null} seconds
 * @returns {string|null}
 */
export function formatTravelTimeWithHours(seconds) {
  const base = formatTravelTime(seconds)
  if (base == null) return null
  const hours = roundUpToQuarterHour(roundUpMinutes(seconds))
  return `${base} (${hours.toFixed(2)} hr)`
}
