// ─── fat.reconciliation_audit (canonical) ────────────────────────────────────
// Append-only log of reconciliation actions. Reconciliation actions MUST NOT
// mutate generated_amount, rate_snapshot, rule_id, or rule_version on
// claim_entitlements. They only mutate payment-state fields and append rows
// here. See PAYMENT_RECONCILIATION_v1.0.md § Audit Trail Requirements.

/**
 * @typedef {Object} ReconciliationAuditEntry
 * @property {string}         id
 * @property {string}         entitlement_id    // → claim_entitlements.id
 * @property {string}         actor_id          // → profiles.id
 * @property {string}         action            // e.g. 'mark_paid', 'mark_outstanding', 'link_payment', 'regress_status'
 * @property {string|null}    prior_status
 * @property {string|null}    new_status
 * @property {string|null}    reason
 * @property {boolean}        automated         // true if produced by an ingestion/matcher
 * @property {string}         created_at
 */

export const RECONCILIATION_AUDIT_TABLE = 'reconciliation_audit'
