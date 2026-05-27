// ─── FAT Canonical Models (v1.0) ─────────────────────────────────────────────
// JSDoc typedefs for the canonical `fat.*` schema introduced by
// supabase/canonical/01_canonical_foundation.sql. These mirror table shape
// only — no runtime behavior. Cf. governance-system canonical docs:
//   DATABASE_ARCHITECTURE_v1.0.md, ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md.
//
// Phase 3 service code will import these for query result typing. The
// existing prototype tables (fat.recalls / retain / standby / spoilt_meals /
// claim_groups / user_rates / financial_years / claim_sequences) are NOT
// modelled here — they are being displaced.

export * from './profile.js'
export * from './station.js'
export * from './rate.js'
export * from './operationalClaim.js'
export * from './claimDetails.js'
export * from './claimEntitlement.js'
export * from './stationMatrix.js'
export * from './payment.js'
export * from './reconciliationAudit.js'
export {
  effectiveAmount,
  effectiveHours,
  effectivePayable,
  isManualOverride,
} from './entitlementHelpers.js'
