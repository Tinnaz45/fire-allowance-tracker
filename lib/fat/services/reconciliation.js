// ─── Reconciliation mutation service (canonical) ─────────────────────────────
// Phase 3 reconciliation surface — link / unlink / recompute. Each function is a
// thin, validated wrapper over the atomic Postgres RPC from migration 08, so the
// claim_entitlements mutation, the entitlement_payment_links insert/delete, and
// the single reconciliation_audit row all commit in one transaction (§ 7.4,
// invariant § 12.5). Audit creation is intentionally NOT a standalone JS call —
// it is part of the RPC transaction so no mutation can skip its audit row.
//
// Spec: RECONCILIATION_STATE_ARCHITECTURE_v1.0.md § 9.5 (link/unlink),
// § 9.6 (recompute), § 7.2 (audit actions), PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md
// § 7 Steps C, E.
//
// `actorId` is the profiles.id stamped onto the audit row; the UI passes the
// authenticated user (RLS enforces actor_id = auth.uid()).

import { fat as defaultClient } from '../../supabaseClient.js'
import {
  LINK_KIND_VALUES,
  PAYMENT_STREAM_VALUES,
  DEFAULT_TOLERANCE,
} from '../models/reconciliationConstants.js'

/** @typedef {{ link_id?:string, entitlement_id:string, action:string, status_changed:boolean, prior_status:string|null, new_status:string|null, audit_id:string|null }} ReconciliationResult */

/**
 * Link a payment record to an entitlement (§ 9.5 linkPayment). Validates owner +
 * stream coherence and the per-record allocation cap server-side, inserts the
 * link, and — for status-eligible kinds (auto_match / manual) — recomputes the
 * entitlement status and appends a `link_payment` audit row. A `discrepancy_note`
 * link leaves status unchanged and appends a `note_discrepancy` row instead.
 *
 * @param {object} input
 * @param {string} input.entitlementId
 * @param {string} input.paymentRecordId
 * @param {number} input.allocatedAmount                          >= 0
 * @param {'auto_match'|'manual'|'discrepancy_note'} input.linkKind
 * @param {string} input.actorId                                  fat.profiles.id
 * @param {string|null} [input.note]
 * @param {boolean} [input.automated=false]
 * @param {number} [input.tolerance=0.01]
 * @param {object} [client]
 * @returns {Promise<ReconciliationResult>}
 */
export async function linkPayment(input, client = defaultClient) {
  const {
    entitlementId,
    paymentRecordId,
    allocatedAmount,
    linkKind,
    actorId,
    note = null,
    automated = false,
    tolerance = DEFAULT_TOLERANCE,
  } = input

  if (!entitlementId) throw new Error('linkPayment: entitlementId is required.')
  if (!paymentRecordId) throw new Error('linkPayment: paymentRecordId is required.')
  if (!actorId) throw new Error('linkPayment: actorId is required.')
  if (!LINK_KIND_VALUES.includes(linkKind)) {
    throw new Error(`linkPayment: invalid linkKind '${linkKind}'.`)
  }
  if (!(Number(allocatedAmount) >= 0)) {
    throw new Error(`linkPayment: allocatedAmount must be >= 0 (got ${allocatedAmount}).`)
  }

  const { data, error } = await client.rpc('link_entitlement_payment', {
    p_entitlement_id:    entitlementId,
    p_payment_record_id: paymentRecordId,
    p_allocated_amount:  allocatedAmount,
    p_link_kind:         linkKind,
    p_actor_id:          actorId,
    p_note:              note,
    p_automated:         automated,
    p_tolerance:         tolerance,
  })
  if (error) throw new Error(`linkPayment failed: ${error.message}`)
  return data
}

/**
 * Remove a link (§ 9.5 unlinkPayment). Hard-deletes the link row, recomputes
 * status when the link was status-eligible, and appends one audit row
 * (`unlink_payment`, or `note_discrepancy` if the removed link was a note).
 *
 * @param {object} input
 * @param {string} input.linkId
 * @param {string} input.actorId
 * @param {string|null} [input.reason]
 * @param {number} [input.tolerance=0.01]
 * @param {object} [client]
 * @returns {Promise<ReconciliationResult>}
 */
export async function unlinkPayment(input, client = defaultClient) {
  const { linkId, actorId, reason = null, tolerance = DEFAULT_TOLERANCE } = input
  if (!linkId) throw new Error('unlinkPayment: linkId is required.')
  if (!actorId) throw new Error('unlinkPayment: actorId is required.')

  const { data, error } = await client.rpc('unlink_entitlement_payment', {
    p_link_id:   linkId,
    p_actor_id:  actorId,
    p_reason:    reason,
    p_tolerance: tolerance,
  })
  if (error) throw new Error(`unlinkPayment failed: ${error.message}`)
  return data
}

/**
 * Recompute an entitlement's payment_status from its current status-eligible
 * links (§ 9.6). The single source of truth for terminal determination; writes
 * an audit row only when the status actually changes, with the action mapped
 * from `trigger`. Use for the override-edit path or as a general primitive.
 *
 * @param {object} input
 * @param {string} input.entitlementId
 * @param {string} input.actorId
 * @param {'link_added'|'link_removed'|'override_edit'|'manual'} [input.trigger='manual']
 * @param {string|null} [input.reason]
 * @param {number} [input.tolerance=0.01]
 * @param {object} [client]
 * @returns {Promise<ReconciliationResult>}
 */
export async function recomputeEntitlementStatus(input, client = defaultClient) {
  const { entitlementId, actorId, trigger = 'manual', reason = null, tolerance = DEFAULT_TOLERANCE } = input
  if (!entitlementId) throw new Error('recomputeEntitlementStatus: entitlementId is required.')
  if (!actorId) throw new Error('recomputeEntitlementStatus: actorId is required.')

  const { data, error } = await client.rpc('recompute_entitlement_status', {
    p_entitlement_id: entitlementId,
    p_actor_id:       actorId,
    p_trigger:        trigger,
    p_reason:         reason,
    p_tolerance:      tolerance,
  })
  if (error) throw new Error(`recomputeEntitlementStatus failed: ${error.message}`)
  return data
}

/**
 * Route an unrouted entitlement to a payment stream (§ 9.1 routeEntitlement) —
 * the ONLY path from payment_method NULL to a stream (§ 3.3). Sets the stream's
 * initial status ('pending' / 'outstanding') and appends one `set_payment_method`
 * audit row (prior_status null). Refuses an already-routed entitlement server-side
 * (re-routing is a separate, explicit operator action, § 3.4). Routing is never
 * inferred from match evidence (§ 3.5) — this helper is the deliberate operator act.
 *
 * Closes the OCR architecture's routing-unknown dependency
 * (OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 6.4; PAYMENT_RECORDS_LAYER_DESIGN § 7
 * Step G).
 *
 * @param {object} input
 * @param {string} input.entitlementId
 * @param {'payslip'|'petty_cash'} input.stream
 * @param {string} input.actorId                                  fat.profiles.id
 * @param {string|null} [input.reason]
 * @param {object} [client]
 * @returns {Promise<ReconciliationResult & { payment_method: string }>}
 */
export async function routeEntitlement(input, client = defaultClient) {
  const { entitlementId, stream, actorId, reason = null } = input
  if (!entitlementId) throw new Error('routeEntitlement: entitlementId is required.')
  if (!actorId) throw new Error('routeEntitlement: actorId is required.')
  if (!PAYMENT_STREAM_VALUES.includes(stream)) {
    throw new Error(`routeEntitlement: invalid stream '${stream}'.`)
  }

  const { data, error } = await client.rpc('route_entitlement', {
    p_entitlement_id: entitlementId,
    p_stream:         stream,
    p_actor_id:       actorId,
    p_reason:         reason,
  })
  if (error) throw new Error(`routeEntitlement failed: ${error.message}`)
  return data
}
