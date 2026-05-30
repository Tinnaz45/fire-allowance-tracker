// ─── Claim metadata resolvers (shift / platoon) ───────────────────────────────
// Shared, JSX-free helpers for reading the operational shift type and FRV platoon
// off a claim row or a grouped-view entry.
//
// STORAGE SHAPE (see ClaimsContext row builders + fat-schema.sql):
//   - Every claim table (recalls / retain / standby / spoilt_meals) carries a
//     top-level `shift` ('Day'|'Night') and `platoon` ('A'..'D') column.
//   - The same values are mirrored into calculation_inputs.{shift,platoon} for
//     historical reproducibility. recalls rows historically populated only the
//     calculation_inputs copy, so we fall back to it.
//   - platoon is auto-derived from date + shift via resolveOperationalPlatoon at
//     claim creation; it is metadata only and never affects amounts/payment.
//
// HISTORICAL FALLBACK:
//   - Claims created before platoon auto-stamping shipped carry a shift but no
//     stored platoon (neither the column nor the calculation_inputs copy). The
//     FRV rotation is fully deterministic from date + shift, so when no platoon
//     is stored we re-derive it via resolveOperationalPlatoon — the same source
//     of truth used at claim creation. This is display-only: nothing is written
//     back, amounts and payment are untouched.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveOperationalPlatoon } from '@/lib/platoon/resolveOperationalPlatoon'

/**
 * Resolve a single claim's shift type.
 * @param {object} claim
 * @returns {'Day'|'Night'|null}
 */
export function resolveClaimShift(claim) {
  if (!claim) return null
  return claim.shift || claim.calculation_inputs?.shift || null
}

/**
 * Resolve a single claim's operational FRV platoon.
 * @param {object} claim
 * @returns {'A'|'B'|'C'|'D'|null}
 */
export function resolveClaimPlatoon(claim) {
  if (!claim) return null
  const stored = claim.platoon || claim.calculation_inputs?.platoon
  if (stored) return stored
  // Historical fallback: re-derive deterministically from the claim's date +
  // shift when no platoon was stamped at creation. Returns null if the shift is
  // missing/unknown (resolver only resolves Day/Night) or the date is unparseable.
  const date = claim.date || claim.calculation_inputs?.date || null
  return resolveOperationalPlatoon(date, resolveClaimShift(claim))
}

/**
 * Resolve the shift type for a grouped-view entry by scanning its children.
 * All rows in a claim group share one shift; we return the first defined value.
 * @param {{ children?: object[] }} entry
 * @returns {'Day'|'Night'|null}
 */
export function resolveGroupShift(entry) {
  for (const child of entry?.children || []) {
    const s = resolveClaimShift(child)
    if (s) return s
  }
  return null
}

/**
 * Resolve the operational platoon for a grouped-view entry by scanning children.
 * @param {{ children?: object[] }} entry
 * @returns {'A'|'B'|'C'|'D'|null}
 */
export function resolveGroupPlatoon(entry) {
  for (const child of entry?.children || []) {
    const p = resolveClaimPlatoon(child)
    if (p) return p
  }
  // Group-level historical fallback: derive from the canonical event date
  // (group.incident_date) + the group's shift when no child carried a platoon.
  const date = entry?.group?.incident_date || null
  return resolveOperationalPlatoon(date, resolveGroupShift(entry))
}

// ─── Station-context resolvers ─────────────────────────────────────────────────
// Read the operational station context captured on a claim. Shape per type:
//   recalls        → { rostered, dest, destRole: 'Recall' }
//   standby / md   → { rostered, dest, destRole: 'Standby'|'M&D' }
//   spoilt/delayed → { rostered: null, dest: operational stn, destRole: 'Operational' }
// Labels fall back to the calculation_inputs snapshot for older standby/meal rows
// that pre-date the dedicated columns. Returns null when no station context
// exists (e.g. retain, or legacy rows) so callers can omit the line entirely.

/**
 * @param {object} claim
 * @returns {{ rostered: string|null, dest: string|null, destRole: string }|null}
 */
export function resolveClaimStations(claim) {
  if (!claim) return null
  const ai = claim.calculation_inputs || {}
  const ct = claim.claimType

  if (ct === 'recalls') {
    const rostered = claim.rostered_stn_label || null
    const dest     = claim.recall_stn_label   || null
    if (!rostered && !dest) return null
    return { rostered, dest, destRole: 'Recall' }
  }
  if (ct === 'standby' || ct === 'md') {
    const rostered = claim.rostered_stn_label || ai.rosteredStn || null
    const dest     = claim.standby_stn_label  || ai.standbyStn  || null
    if (!rostered && !dest) return null
    return { rostered, dest, destRole: ct === 'md' ? 'M&D' : 'Standby' }
  }
  if (ct === 'spoilt' || ct === 'delayed_meal') {
    const op = claim.operational_stn_label || ai.operationalStn || null
    if (!op) return null
    return { rostered: null, dest: op, destRole: 'Operational' }
  }
  return null
}

/**
 * Resolve station context for a grouped-view entry by scanning its children for
 * the operational row that carries the captured station labels.
 * @param {{ children?: object[] }} entry
 * @returns {{ rostered: string|null, dest: string|null, destRole: string }|null}
 */
export function resolveGroupStations(entry) {
  for (const child of entry?.children || []) {
    const s = resolveClaimStations(child)
    if (s) return s
  }
  return null
}
