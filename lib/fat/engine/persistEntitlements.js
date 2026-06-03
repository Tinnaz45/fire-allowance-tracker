// ─── Entitlement Engine — generation + persistence (claim writer) ────────────
// Phase 3 service layer. Runs the pure engine (lib/fat/engine/index.js) over a
// persisted operational claim + its detail row, then writes the resulting rows
// into fat.claim_entitlements. The pure engine owns the math; this module owns
// the transaction boundary, provenance stamping, invariant assertion, and
// idempotency (regeneration protection).
//
// Static-snapshot philosophy (contracts § 1): ONE generation per claim. The
// engine is invoked once at claim-create time and never re-runs. Re-invoking
// this function for a claim that already has entitlements is a no-op.
//
// The Supabase client passed in MUST be scoped to the `fat` schema.
//
// Out of scope here (per the canonical architecture): payment_records,
// reconciliation, and the hours→dollars bridge. Hours-first rows persist with
// generated_amount = NULL; the payable dollar value is a payment-layer concern.

import { generateEntitlements } from './index.js'
import { buildEngineContext, resolveActiveMatrixVersion } from './context.js'

const ENTITLEMENTS_TABLE = 'claim_entitlements'

const DETAIL_TABLE_BY_CLAIM_TYPE = {
  SB: 'standby_details',
  MD: 'muster_dismiss_details',
}

const DEST_STATION_FIELD_BY_CLAIM_TYPE = {
  SB: 'standby_station_id',
  MD: 'md_station_id',
}

/**
 * Assert the § 7 invariants on an engine draft before it is persisted. This is
 * the generation-time audit guard — a malformed draft is a bug, not data.
 *
 * @param {object} d  — EntitlementDraft
 * @param {number} i  — index in the batch (for error messages)
 */
function assertDraftInvariant(d, i) {
  const where = `draft[${i}] (${d?.entitlement_type ?? 'unknown'})`
  const hasAmount = d.generated_amount != null
  const hasHours = d.generated_hours != null
  if (hasAmount === hasHours) {
    throw new Error(`${where}: exactly one of generated_amount / generated_hours must be set.`)
  }
  if (d.unit === 'dollars' && !hasAmount) throw new Error(`${where}: unit 'dollars' requires generated_amount.`)
  if (d.unit === 'hours' && !hasHours) throw new Error(`${where}: unit 'hours' requires generated_hours.`)
  if (!d.rule_id || !d.rule_version) throw new Error(`${where}: rule_id and rule_version are required.`)
  if (d.rate_snapshot == null) throw new Error(`${where}: rate_snapshot is required (audit replay).`)
  if (d.manual_override !== false) throw new Error(`${where}: manual_override must be false at generation.`)
  if (d.edited_amount != null || d.edited_hours != null || d.edited_note != null) {
    throw new Error(`${where}: edited_* fields must be null at generation.`)
  }
}

/** Compact, audit-friendly summary of a generation batch. */
function summarise(rows) {
  return {
    count: rows.length,
    rows: rows.map((r) => ({
      entitlement_type: r.entitlement_type,
      unit:             r.unit,
      generated_amount: r.generated_amount ?? null,
      generated_hours:  r.generated_hours ?? null,
      rule_id:          r.rule_id,
      payment_method:   r.payment_method ?? null,
      payment_status:   r.payment_status ?? null,
      has_rate_snapshot: r.rate_snapshot != null,
    })),
  }
}

/**
 * Generate and persist entitlements for an already-inserted operational claim.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} fatClient — fat-scoped
 * @param {object} args
 * @param {object} args.claim    — the persisted operational_claims row (needs id, claim_type, claim_date)
 * @param {object} args.details  — the 1:1 detail row (canonical snake_case fields the generator reads)
 * @param {string} args.ownerId  — fat.profiles.id (denormalised onto each entitlement)
 * @returns {Promise<{skipped:boolean, claim_id:string, inserted:object[], existing?:object[], summary?:object, reason?:string}>}
 */
export async function generateAndPersistEntitlements(fatClient, { claim, details, ownerId }) {
  if (!claim?.id) throw new Error('generateAndPersistEntitlements: claim.id is required (insert the parent claim first).')
  if (!claim?.claim_type) throw new Error('generateAndPersistEntitlements: claim.claim_type is required.')
  if (!claim?.claim_date) throw new Error('generateAndPersistEntitlements: claim.claim_date is required.')
  if (!ownerId) throw new Error('generateAndPersistEntitlements: ownerId is required.')

  // ── 1. Regeneration protection / no-duplicate guard ────────────────────────
  const { data: existing, error: exErr } = await fatClient
    .from(ENTITLEMENTS_TABLE)
    .select('id, entitlement_type, unit, generated_amount, generated_hours, rule_id')
    .eq('claim_id', claim.id)
  if (exErr) throw new Error(`entitlement existence check: ${exErr.message}`)
  if (existing && existing.length > 0) {
    console.log(`[entitlements] claim ${claim.id} already has ${existing.length} entitlement(s) — skipping regeneration.`)
    return { skipped: true, reason: 'entitlements already exist for this claim', claim_id: claim.id, existing, inserted: [] }
  }

  // ── 2. Build context (prefetch) + run the pure engine ──────────────────────
  const destField = DEST_STATION_FIELD_BY_CLAIM_TYPE[claim.claim_type]
  const destStationId = destField ? (details?.[destField] ?? null) : null

  const ctx = await buildEngineContext(fatClient, {
    ownerId,
    claimDate:     claim.claim_date,
    matrixVersion: details?.matrix_version ?? null,
    destStationId,
  })

  const drafts = generateEntitlements(claim, details, ctx)

  // ── 3. Assert invariants + stamp provenance (claim_id, owner_id) ───────────
  const rows = drafts.map((d, i) => {
    assertDraftInvariant(d, i)
    return { ...d, claim_id: claim.id, owner_id: ownerId }
  })

  if (rows.length === 0) {
    console.log(`[entitlements] claim ${claim.id} (${claim.claim_type}) generated 0 entitlements (no triggers fired / lookups missing).`)
    return { skipped: false, claim_id: claim.id, inserted: [], summary: summarise([]) }
  }

  // ── 4. Persist ─────────────────────────────────────────────────────────────
  const { data: inserted, error: insErr } = await fatClient
    .from(ENTITLEMENTS_TABLE)
    .insert(rows)
    .select()
  if (insErr) throw new Error(`claim_entitlements insert failed: ${insErr.message}`)

  const summary = summarise(inserted || [])
  console.log(`[entitlements] claim ${claim.id} (${claim.claim_type}) generated ${summary.count}:`,
    summary.rows.map((r) => `${r.entitlement_type}[${r.unit}]`).join(', '))

  return { skipped: false, claim_id: claim.id, inserted: inserted || [], summary }
}

/**
 * High-level canonical claim writer: inserts the operational_claims row + its
 * 1:1 detail row, then generates + persists entitlements in one call. This is
 * the Phase-3 service entry point for creating a Standby / M&D claim against the
 * canonical schema.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} fatClient — fat-scoped
 * @param {object} input
 * @param {string} input.ownerId
 * @param {'SB'|'MD'} input.claimType
 * @param {string} input.claimDate                — ISO 'YYYY-MM-DD'
 * @param {number|null} [input.stationIdSnapshot] — rostered station at creation (provenance)
 * @param {string|null} [input.stationNameSnapshot]
 * @param {'frv_matrix'|'google_maps'|'manual'} [input.sourceCalculationMode='frv_matrix']
 * @param {string|null} [input.notes]
 * @param {object} input.details                  — detail-table fields (snake_case, sans claim_id)
 * @returns {Promise<{claim:object, persist:object}>}
 */
export async function createCanonicalClaim(fatClient, input) {
  const {
    ownerId,
    claimType,
    claimDate,
    stationIdSnapshot = null,
    stationNameSnapshot = null,
    sourceCalculationMode = 'frv_matrix',
    notes = null,
    details = {},
  } = input

  const detailTable = DETAIL_TABLE_BY_CLAIM_TYPE[claimType]
  if (!detailTable) {
    throw new Error(`createCanonicalClaim: unsupported claim_type '${claimType}' (expected SB or MD).`)
  }

  // 1. Parent operational_claims row. Snapshot + mode are set by the caller per
  //    contracts § 2 (the engine never reads live profile state).
  const { data: claim, error: cErr } = await fatClient
    .from('operational_claims')
    .insert({
      owner_id:                ownerId,
      claim_type:              claimType,
      claim_date:              claimDate,
      station_id_snapshot:     stationIdSnapshot,
      station_name_snapshot:   stationNameSnapshot,
      source_calculation_mode: sourceCalculationMode,
      status:                  'submitted',
      notes,
    })
    .select()
    .single()
  if (cErr) throw new Error(`operational_claims insert failed: ${cErr.message}`)

  // 2. Detail row (1:1, keyed by claim_id).
  const { error: dErr } = await fatClient
    .from(detailTable)
    .insert({ ...details, claim_id: claim.id })
  if (dErr) throw new Error(`${detailTable} insert failed: ${dErr.message}`)

  // 3. Generate + persist entitlements.
  const persist = await generateAndPersistEntitlements(fatClient, {
    claim,
    details,
    ownerId,
  })

  return { claim, persist }
}

export { resolveActiveMatrixVersion }
