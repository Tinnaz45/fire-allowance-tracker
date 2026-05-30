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
// ─────────────────────────────────────────────────────────────────────────────

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
  return claim.platoon || claim.calculation_inputs?.platoon || null
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
  return null
}
