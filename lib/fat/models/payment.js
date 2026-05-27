// ─── fat.payment_records / fat.entitlement_payment_links (canonical) ─────────
// Real-world payment facts and N:M links to entitlements. Status transitions
// live on claim_entitlements.payment_status; links are the auditable
// evidence. See DATABASE_ARCHITECTURE_v1.0.md § 7. Payment and Reconciliation.

/** @typedef {'payslip'|'petty_cash'} PaymentStream */
/** @typedef {'manual'|'payslip_screenshot'|'payslip_pdf'|'petty_cash_export'} PaymentRecordSource */

/**
 * @typedef {Object} PaymentRecord
 * @property {string}              id
 * @property {string}              owner_id        // → profiles.id
 * @property {PaymentStream}       stream
 * @property {string}              record_date     // ISO date
 * @property {string|null}         reference       // payslip line code / form ref
 * @property {number}              gross_amount
 * @property {object|null}         raw_payload     // OCR / parsed / export snapshot
 * @property {PaymentRecordSource} source
 * @property {string}              created_at
 */

/** @typedef {'auto_match'|'manual'|'discrepancy_note'} EntitlementPaymentLinkKind */

/**
 * @typedef {Object} EntitlementPaymentLink
 * @property {string}                       id
 * @property {string}                       entitlement_id     // → claim_entitlements.id
 * @property {string}                       payment_record_id  // → payment_records.id
 * @property {number}                       allocated_amount
 * @property {EntitlementPaymentLinkKind}   link_kind
 * @property {string|null}                  note
 * @property {string}                       created_at
 */

export const PAYMENT_RECORDS_TABLE = 'payment_records'
export const ENTITLEMENT_PAYMENT_LINKS_TABLE = 'entitlement_payment_links'
