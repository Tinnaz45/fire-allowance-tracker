// ─── Payment-record service (canonical) ──────────────────────────────────────
// Phase 3 reconciliation surface — the writer + readers for fat.payment_records.
// A payment_records row is one observed real-world pay line (§ 4). Creation goes
// through the create_payment_record RPC so gross_amount / stream / source are
// validated server-side; reads are plain owner-scoped selects under RLS.
//
// Spec: RECONCILIATION_STATE_ARCHITECTURE_v1.0.md § 4 (record semantics),
// § 9.3 (recordPayment), PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md § 7 Step D.
//
// The fat client passed in MUST be schema-scoped to `fat` (lib/supabaseClient.js
// → `fat`). owner_id / actor identity comes from the caller; the UI passes the
// authenticated user, RLS enforces owner-only.

import { fat as defaultClient } from '../../supabaseClient.js'
import { PAYMENT_RECORDS_TABLE } from '../models/payment.js'
import {
  PAYMENT_STREAM_VALUES,
  PAYMENT_RECORD_SOURCE_VALUES,
  DEFAULT_TOLERANCE,
} from '../models/reconciliationConstants.js'

/**
 * Create one observed payment line (§ 9.3). Insert-only — never creates links;
 * an unmatched line just lands in the unallocated-payments queue (§ 8.4).
 *
 * @param {object} input
 * @param {string} input.ownerId                       fat.profiles.id (= auth.uid() for the user path)
 * @param {'payslip'|'petty_cash'} input.stream
 * @param {string} input.recordDate                    ISO 'YYYY-MM-DD'
 * @param {number} input.grossAmount                   >= 0
 * @param {'manual'|'payslip_screenshot'|'payslip_pdf'|'petty_cash_export'} [input.source='manual']
 * @param {string|null} [input.reference]              payslip line code / petty-cash form ref
 * @param {object|null} [input.rawPayload]             OCR / parsed / export snapshot
 * @param {object} [client]                            fat-scoped client (injectable for tests)
 * @returns {Promise<import('../models/payment.js').PaymentRecord>}
 */
export async function recordPayment(input, client = defaultClient) {
  const {
    ownerId,
    stream,
    recordDate,
    grossAmount,
    source = 'manual',
    reference = null,
    rawPayload = null,
  } = input

  if (!ownerId) throw new Error('recordPayment: ownerId is required.')
  if (!PAYMENT_STREAM_VALUES.includes(stream)) {
    throw new Error(`recordPayment: invalid stream '${stream}'.`)
  }
  if (!recordDate) throw new Error('recordPayment: recordDate is required.')
  if (!(Number(grossAmount) >= 0)) {
    throw new Error(`recordPayment: grossAmount must be >= 0 (got ${grossAmount}).`)
  }
  if (!PAYMENT_RECORD_SOURCE_VALUES.includes(source)) {
    throw new Error(`recordPayment: invalid source '${source}'.`)
  }

  const { data, error } = await client.rpc('create_payment_record', {
    p_owner_id:     ownerId,
    p_stream:       stream,
    p_record_date:  recordDate,
    p_gross_amount: grossAmount,
    p_source:       source,
    p_reference:    reference,
    p_raw_payload:  rawPayload,
  })
  if (error) throw new Error(`recordPayment failed: ${error.message}`)
  return data
}

/**
 * Retract one observed payment line (§ 9.4 retractPayment) — the reverse of
 * recordPayment. Hard-deletes the payment_records row (the FK cascade removes its
 * links, § 4.3 / § 5.2), then recomputes status and appends one `unlink_payment`
 * audit row for each DISTINCT formerly-linked entitlement. The recompute re-derives
 * each entitlement's status from its REMAINING links — partial coverage from other
 * records may still hold it terminal, so the matcher never auto-regresses (§ 4.3).
 * An unallocated record (no links) is deleted with no recompute and no audit row.
 *
 * Used to correct an OCR misread / duplicate batch / wrong-owner ingest, and is the
 * reverse bridge the OCR architecture depends on
 * (OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 6.5; PAYMENT_RECORDS_LAYER_DESIGN § 7
 * Step F). Atomic server-side: the delete + every recompute + every audit row
 * commit in one transaction.
 *
 * @param {object} input
 * @param {string} input.paymentRecordId
 * @param {string} input.actorId                       fat.profiles.id stamped on each audit row
 * @param {string|null} [input.reason]
 * @param {number} [input.tolerance=0.01]
 * @param {object} [client]
 * @returns {Promise<{ payment_record_id: string, entitlements_recomputed: number, audit_rows_written: number }>}
 */
export async function retractPayment(input, client = defaultClient) {
  const { paymentRecordId, actorId, reason = null, tolerance = DEFAULT_TOLERANCE } = input
  if (!paymentRecordId) throw new Error('retractPayment: paymentRecordId is required.')
  if (!actorId) throw new Error('retractPayment: actorId is required.')

  const { data, error } = await client.rpc('retract_payment', {
    p_payment_record_id: paymentRecordId,
    p_actor_id:          actorId,
    p_reason:            reason,
    p_tolerance:         tolerance,
  })
  if (error) throw new Error(`retractPayment failed: ${error.message}`)
  return data
}

/**
 * Read a single payment record by id (owner-scoped under RLS).
 *
 * @param {string} paymentRecordId
 * @param {object} [client]
 * @returns {Promise<import('../models/payment.js').PaymentRecord|null>}
 */
export async function getPaymentRecord(paymentRecordId, client = defaultClient) {
  if (!paymentRecordId) throw new Error('getPaymentRecord: paymentRecordId is required.')
  const { data, error } = await client
    .from(PAYMENT_RECORDS_TABLE)
    .select('*')
    .eq('id', paymentRecordId)
    .maybeSingle()
  if (error) throw new Error(`getPaymentRecord failed: ${error.message}`)
  return data ?? null
}

/**
 * List payment records for an owner, newest first. Optionally filter by stream.
 *
 * @param {string} ownerId
 * @param {{ stream?: 'payslip'|'petty_cash' }} [opts]
 * @param {object} [client]
 * @returns {Promise<import('../models/payment.js').PaymentRecord[]>}
 */
export async function listPaymentRecords(ownerId, opts = {}, client = defaultClient) {
  if (!ownerId) throw new Error('listPaymentRecords: ownerId is required.')
  let query = client
    .from(PAYMENT_RECORDS_TABLE)
    .select('*')
    .eq('owner_id', ownerId)
    .order('record_date', { ascending: false })
    .order('created_at', { ascending: false })
  if (opts.stream) query = query.eq('stream', opts.stream)

  const { data, error } = await query
  if (error) throw new Error(`listPaymentRecords failed: ${error.message}`)
  return data ?? []
}
