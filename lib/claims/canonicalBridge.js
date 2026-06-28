'use client'

// ─── Prototype → Canonical claim bridge ──────────────────────────────────────
// Mirrors a successfully-created prototype Standby / Muster & Dismiss claim into
// the canonical entitlement schema (fat.operational_claims + the *_details table
// + fat.claim_entitlements) by invoking the validated Phase-3 service layer
// (lib/fat/engine/persistEntitlements.js → createCanonicalClaim).
//
// DESIGN CONTRACT — this module must NEVER throw:
//   - It is called from ClaimsContext.addClaim AFTER the prototype write has
//     fully succeeded. Canonical generation is purely additive and runs in
//     parallel; a canonical failure must not roll back or block the live claim.
//   - All errors are caught here, logged, and surfaced as a result object. The
//     caller treats the result as advisory diagnostics only.
//
// SCOPE: Standby (SB) + Muster & Dismiss (MD) only — the two claim types the
// canonical engine has generators + seeded rates/matrix for. Every other claim
// type is a no-op (returns { mirrored: false }).
//
// Identity mapping: the prototype `userId` is auth.users.id, which is also
// fat.profiles.id (profile.js § Profile.id = auth.users.id). So userId IS the
// canonical ownerId — no translation needed, and RLS (auth.uid() = owner_id)
// is satisfied for the user creating their own claim.
//
// Station mapping: identity is EXPLICIT. ClaimsContext passes the resolved
// station ids (fields.rosteredStnId / fields.standbyStnId); the id is validated
// against fat.stations before use so it can never produce a dangling FK
// (station_id_snapshot / *_station_id). For legacy callers that supply only a
// label, parseStationInput is kept as a fallback — but the visible label is no
// longer the source of identity.
//
// NOTE on the excess-travel "from" station: the canonical engine
// (buildEngineContext) reads the rostered station from fat.profiles.
// rostered_station_id — NOT from the per-claim rostered label captured here.
// Excess-travel entitlements therefore generate only when that profile column
// is populated; the fixed standby_dismi / muster_dismis (and small_meal)
// entitlements generate regardless. See REPORT for the documented divergence.

// Relative imports (not the '@/' alias) so this module also loads under plain
// Node for the DEV integration test (scripts/test-canonical-bridge.mjs).
import { fat } from '../supabaseClient.js'
import {
  createCanonicalClaim,
  resolveActiveMatrixVersion,
} from '../fat/engine/persistEntitlements.js'
import { parseStationInput } from '../distance/stationParser.js'

// Prototype claimType → canonical claim_type code.
const CANONICAL_CLAIM_TYPE = { standby: 'SB', md: 'MD' }

const LOG = '[canonical-bridge]'

/**
 * Compose a timestamptz string from a YYYY-MM-DD date and a free-form 24hr time
 * ("HH:MM" or "HHMM"). Returns null when no usable time is supplied. No timezone
 * suffix is appended so the value is read in the same local frame the engine's
 * small-meal trigger uses (standby.js § hasSmallMealTrigger → getHours()).
 *
 * @param {string} date      ISO 'YYYY-MM-DD'
 * @param {string|null} time 24hr clock, "HH:MM" or "HHMM"
 * @returns {string|null}
 */
function composeTimestamp(date, time) {
  if (!date) return null
  const digits = String(time ?? '').replace(/\D/g, '')
  if (!digits) return null
  const padded = digits.padStart(4, '0').slice(0, 4)
  const hh = padded.slice(0, 2)
  const mm = padded.slice(2, 4)
  const h = parseInt(hh, 10)
  const m = parseInt(mm, 10)
  if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return null
  return `${date}T${hh}:${mm}:00`
}

/**
 * Resolve a station to a validated fat.stations row using its EXPLICIT id.
 * The id is preferred; `label` is only consulted as a legacy fallback (older
 * callers that pass a "FS43 - Deer Park" label and no id). Confirms the station
 * exists. Returns { id, name } or { id: null, name: null } when unresolved.
 *
 * @param {number|string|null} explicitId
 * @param {string|null} label  legacy fallback only
 * @param {object} client      fat-scoped Supabase client
 * @returns {Promise<{ id: number|null, name: string|null }>}
 */
async function resolveStation(explicitId, label, client) {
  let id = null
  if (explicitId != null && explicitId !== '') {
    const n = Number(explicitId)
    if (Number.isFinite(n)) id = n
  }
  // Legacy fallback: derive the id from a canonical label only when no explicit
  // id was supplied. New callers always pass the id.
  if (id == null) id = parseStationInput(label).id
  if (id == null) return { id: null, name: null }
  const { data, error } = await client
    .from('stations')
    .select('id, name')
    .eq('id', id)
    .maybeSingle()
  if (error || !data) return { id: null, name: null }
  return { id: data.id, name: data.name ?? null }
}

/**
 * Mirror a prototype Standby / M&D claim into the canonical schema.
 *
 * Non-throwing: returns a result object describing what happened. The caller in
 * ClaimsContext.addClaim treats this as fire-and-forget diagnostics.
 *
 * @param {object} args
 * @param {string} args.userId       auth.users.id (= fat.profiles.id = ownerId)
 * @param {'standby'|'md'} args.claimType
 * @param {string} args.date         ISO 'YYYY-MM-DD'
 * @param {object} args.fields       resolved form fields (rosteredStn, standbyStn, arrivedTime, …)
 * @param {object} [args.breakdown]  prototype calc breakdown (advisory only here)
 * @param {object|null} [args.routingMeta] travel routing provenance (matrix version/hours)
 * @param {object} [args.client]     fat-scoped Supabase client (defaults to the app client; injectable for tests)
 * @returns {Promise<{mirrored:boolean, reason?:string, error?:string, claimId?:string, entitlements?:number, summary?:object}>}
 */
export async function mirrorClaimToCanonical({ userId, claimType, date, fields = {}, breakdown = null, routingMeta = null, client = fat }) {
  const canonicalType = CANONICAL_CLAIM_TYPE[claimType]
  if (!canonicalType) return { mirrored: false, reason: `unsupported claim type '${claimType}'` }
  if (!userId) return { mirrored: false, reason: 'missing userId (ownerId)' }
  if (!date)   return { mirrored: false, reason: 'missing claim date' }

  try {
    // ── Resolve stations (rostered = snapshot/provenance; dest = excess-travel target) ─
    // Explicit ids are the source of truth; the *Stn labels are only a legacy
    // fallback for callers that don't pass ids.
    const rostered = await resolveStation(fields.rosteredStnId, fields.rosteredStn, client)
    const dest     = await resolveStation(fields.standbyStnId, fields.standbyStn, client)

    // ── Pin the active FRV hours matrix version ───────────────────────────────
    // Prefer the version the travel subsystem already resolved for this claim;
    // otherwise resolve the active hours version. Either may be absent — excess
    // travel simply won't fire (the fixed-hours entitlements still generate).
    let matrixVersion = routingMeta?.standby?.matrixVersionId ?? null
    if (matrixVersion == null) {
      try {
        matrixVersion = await resolveActiveMatrixVersion(client)
      } catch (mvErr) {
        console.warn(`${LOG} could not resolve active matrix version (excess travel will be skipped):`, mvErr?.message)
        matrixVersion = null
      }
    }
    matrixVersion = matrixVersion != null ? String(matrixVersion) : null

    const matrixHours = routingMeta?.standby?.matrixHours ?? null

    // ── Build the 1:1 detail row (canonical snake_case) ───────────────────────
    const details = canonicalType === 'SB'
      ? {
          standby_station_id: dest.id,
          standby_start_at:   composeTimestamp(date, fields.arrivedTime),
          matrix_hours:       matrixHours,
          matrix_version:     matrixVersion,
        }
      : {
          md_station_id:  dest.id,
          md_event_at:    composeTimestamp(date, fields.arrivedTime),
          matrix_hours:   matrixHours,
          matrix_version: matrixVersion,
        }

    console.log(`${LOG} mirroring ${canonicalType} claim`, {
      ownerId: userId,
      claimDate: date,
      stationIdSnapshot: rostered.id,
      destStationId: dest.id,
      matrixVersion,
    })

    // ── Create canonical claim + generate + persist entitlements ──────────────
    const { claim, persist } = await createCanonicalClaim(client, {
      ownerId:               userId,
      claimType:             canonicalType,
      claimDate:             date,
      stationIdSnapshot:     rostered.id,
      stationNameSnapshot:   rostered.name,
      sourceCalculationMode: 'frv_matrix',
      details,
    })

    const entitlements = persist?.inserted?.length ?? 0
    console.log(`${LOG} ✓ ${canonicalType} canonical claim ${claim.id} → ${entitlements} entitlement(s)`,
      persist?.summary?.rows?.map((r) => `${r.entitlement_type}[${r.unit}]`).join(', ') || '')

    return {
      mirrored: true,
      claimId: claim.id,
      entitlements,
      summary: persist?.summary ?? null,
    }
  } catch (err) {
    // Non-fatal by contract: log and report, never propagate.
    console.warn(`${LOG} ✗ canonical mirror failed (non-fatal) for ${claimType} on ${date}:`, err?.message || err)
    return { mirrored: false, error: err?.message || String(err) }
  }
}
