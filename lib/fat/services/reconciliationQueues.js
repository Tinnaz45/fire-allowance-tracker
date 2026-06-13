// ─── Reconciliation queue service (canonical, read-only) ─────────────────────
// Phase 3 reconciliation surface — the state queries that back the four operator
// surfaces (§ 8): needs-routing, pending payslip, outstanding petty cash,
// unallocated payments, plus the per-entitlement history drawer (§ 8.1 / § 9.10).
// Pure reads; no mutation. All owner-scoped under RLS.
//
// Spec: RECONCILIATION_STATE_ARCHITECTURE_v1.0.md § 8 (surfaces), § 9.10 (read
// helpers), § 5.5 (derived status). The derived display status is computed with
// the shared predicate (reconciliationHelpers.evaluateDerivedStatus) so the
// queue badges agree with the server-persisted status.

import { fat as defaultClient } from '../../supabaseClient.js'
import { CLAIM_ENTITLEMENTS_TABLE } from '../models/claimEntitlement.js'
import {
  PAYMENT_RECORDS_TABLE,
  ENTITLEMENT_PAYMENT_LINKS_TABLE,
} from '../models/payment.js'
import { RECONCILIATION_AUDIT_TABLE } from '../models/reconciliationAudit.js'
import {
  PAYMENT_STREAMS,
  PAYMENT_STATUS,
  STATUS_ELIGIBLE_LINK_KINDS,
  DEFAULT_TOLERANCE,
} from '../models/reconciliationConstants.js'
import { evaluateDerivedStatus } from '../models/reconciliationHelpers.js'

const ENTITLEMENT_COLS =
  'id, claim_id, owner_id, entitlement_type, unit, generated_amount, generated_hours, ' +
  'edited_amount, edited_hours, payment_method, payment_status, generated_at'

/**
 * Entitlements awaiting routing (§ 8.2): payment_method IS NULL. Owner-scoped,
 * oldest claim first so the operator clears the backlog in order.
 *
 * @param {string} ownerId
 * @param {object} [client]
 * @returns {Promise<object[]>}
 */
export async function listNeedsRouting(ownerId, client = defaultClient) {
  if (!ownerId) throw new Error('listNeedsRouting: ownerId is required.')
  const { data, error } = await client
    .from(CLAIM_ENTITLEMENTS_TABLE)
    .select(ENTITLEMENT_COLS)
    .eq('owner_id', ownerId)
    .is('payment_method', null)
    .order('generated_at', { ascending: true })
  if (error) throw new Error(`listNeedsRouting failed: ${error.message}`)
  return data ?? []
}

/**
 * Pending payslip queue (§ 8.3): payment_method='payslip' AND status='pending'.
 *
 * @param {string} ownerId
 * @param {object} [client]
 * @returns {Promise<object[]>}
 */
export async function listPendingPayslip(ownerId, client = defaultClient) {
  if (!ownerId) throw new Error('listPendingPayslip: ownerId is required.')
  const { data, error } = await client
    .from(CLAIM_ENTITLEMENTS_TABLE)
    .select(ENTITLEMENT_COLS)
    .eq('owner_id', ownerId)
    .eq('payment_method', PAYMENT_STREAMS.PAYSLIP)
    .eq('payment_status', PAYMENT_STATUS.PENDING)
    .order('generated_at', { ascending: true })
  if (error) throw new Error(`listPendingPayslip failed: ${error.message}`)
  return data ?? []
}

/**
 * Outstanding petty-cash queue (§ 8.3): payment_method='petty_cash' AND
 * status='outstanding'.
 *
 * @param {string} ownerId
 * @param {object} [client]
 * @returns {Promise<object[]>}
 */
export async function listOutstandingPettyCash(ownerId, client = defaultClient) {
  if (!ownerId) throw new Error('listOutstandingPettyCash: ownerId is required.')
  const { data, error } = await client
    .from(CLAIM_ENTITLEMENTS_TABLE)
    .select(ENTITLEMENT_COLS)
    .eq('owner_id', ownerId)
    .eq('payment_method', PAYMENT_STREAMS.PETTY_CASH)
    .eq('payment_status', PAYMENT_STATUS.OUTSTANDING)
    .order('generated_at', { ascending: true })
  if (error) throw new Error(`listOutstandingPettyCash failed: ${error.message}`)
  return data ?? []
}

/**
 * Unallocated-payments queue (§ 8.4): payment records with no status-eligible
 * (auto_match / manual) link. Embeds the link kinds and filters in JS — the MVP
 * volume is small and PostgREST has no NOT-EXISTS operator. discrepancy_note
 * links do NOT make a record "allocated".
 *
 * @param {string} ownerId
 * @param {object} [client]
 * @returns {Promise<object[]>}
 */
export async function listUnallocatedPayments(ownerId, client = defaultClient) {
  if (!ownerId) throw new Error('listUnallocatedPayments: ownerId is required.')
  const { data, error } = await client
    .from(PAYMENT_RECORDS_TABLE)
    .select(`*, ${ENTITLEMENT_PAYMENT_LINKS_TABLE}(link_kind)`)
    .eq('owner_id', ownerId)
    .order('record_date', { ascending: false })
  if (error) throw new Error(`listUnallocatedPayments failed: ${error.message}`)

  return (data ?? [])
    .filter((rec) => {
      const links = rec[ENTITLEMENT_PAYMENT_LINKS_TABLE] ?? []
      return !links.some((l) => STATUS_ELIGIBLE_LINK_KINDS.includes(l.link_kind))
    })
    .map(({ [ENTITLEMENT_PAYMENT_LINKS_TABLE]: _links, ...rec }) => rec)
}

/**
 * Per-entitlement reconciliation view (§ 8.1 / § 9.10 listEntitlementHistory):
 * the entitlement, its links, its audit trail (newest first), and the derived
 * display status computed from the current status-eligible link set.
 *
 * @param {string} entitlementId
 * @param {{ tolerance?: number }} [opts]
 * @param {object} [client]
 * @returns {Promise<{ entitlement: object|null, links: object[], audit_history: object[], derived_status: string|null }>}
 */
export async function listEntitlementHistory(entitlementId, opts = {}, client = defaultClient) {
  if (!entitlementId) throw new Error('listEntitlementHistory: entitlementId is required.')
  const { tolerance = DEFAULT_TOLERANCE } = opts

  const [entRes, linkRes, auditRes] = await Promise.all([
    client.from(CLAIM_ENTITLEMENTS_TABLE).select('*').eq('id', entitlementId).maybeSingle(),
    client.from(ENTITLEMENT_PAYMENT_LINKS_TABLE).select('*').eq('entitlement_id', entitlementId)
      .order('created_at', { ascending: true }),
    client.from(RECONCILIATION_AUDIT_TABLE).select('*').eq('entitlement_id', entitlementId)
      .order('created_at', { ascending: false }),
  ])

  if (entRes.error) throw new Error(`listEntitlementHistory (entitlement) failed: ${entRes.error.message}`)
  if (linkRes.error) throw new Error(`listEntitlementHistory (links) failed: ${linkRes.error.message}`)
  if (auditRes.error) throw new Error(`listEntitlementHistory (audit) failed: ${auditRes.error.message}`)

  const entitlement = entRes.data ?? null
  const links = linkRes.data ?? []
  const derived_status = entitlement ? evaluateDerivedStatus(entitlement, links, { tolerance }) : null

  return { entitlement, links, audit_history: auditRes.data ?? [], derived_status }
}
