// ─── Reconciliation constants (canonical, single source of truth) ────────────
// Pure constant exports — no Supabase dependency. Pinning these closed sets in
// JS prevents string typos in audit `action`, link `link_kind`, and payment
// `source` values that the column types leave un-guarded (the canonical schema
// keeps `payment_status` / `action` as free `text` pending the stream-split
// TODO — see 01_canonical_foundation.sql § 6, § 8).
//
// Spec: RECONCILIATION_STATE_ARCHITECTURE_v1.0.md § 7.2 (action enum),
// § 5.3 (link_kind taxonomy), § 4.4 (source provenance), § 2 (streams),
// PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md § 4.3 (tolerance), § 7 Step A.

// ── Payment streams (claim_entitlements.payment_method / payment_records.stream) ─
/** @typedef {'payslip'|'petty_cash'} PaymentStream */
export const PAYMENT_STREAMS = Object.freeze({
  PAYSLIP: 'payslip',
  PETTY_CASH: 'petty_cash',
})
export const PAYMENT_STREAM_VALUES = Object.freeze(['payslip', 'petty_cash'])

// ── Canonical STORED payment_status values (claim_entitlements.payment_status) ─
// Stream-scoped and disjoint (§ 2.3). These are the only values ever written
// to the column. The richer "partial" states the operator surface needs are
// DERIVED at read time (see DERIVED_STATUS below) — they are NOT stored.
//   payslip    → null → pending → paid          (regress paid → pending)
//   petty_cash → null → outstanding → claimed   (regress claimed → outstanding)
export const PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  OUTSTANDING: 'outstanding',
  CLAIMED: 'claimed',
})

// Legal STORED status values per stream (§ 2.3 stream-coherence invariant).
export const STREAM_STATUSES = Object.freeze({
  payslip: Object.freeze({ initial: 'pending', terminal: 'paid' }),
  petty_cash: Object.freeze({ initial: 'outstanding', terminal: 'claimed' }),
})

// ── DERIVED display statuses (computed, never stored) ────────────────────────
// The operator-facing reconciliation surface distinguishes "nothing yet",
// "some allocation but not enough", and "settled". The canonical STORED column
// only carries the binary initial/terminal value (§ 2.3); partial-ness is
// derived from the status-eligible link sum vs the effective amount (§ 5.5).
// These six labels are the display vocabulary:
//   payslip    : pending      → partially_paid       → paid
//   petty_cash : outstanding  → partially_reimbursed → reimbursed
// `reimbursed` is the display label for the STORED terminal `claimed`.
export const DERIVED_STATUS = Object.freeze({
  PENDING: 'pending',
  PARTIALLY_PAID: 'partially_paid',
  PAID: 'paid',
  OUTSTANDING: 'outstanding',
  PARTIALLY_REIMBURSED: 'partially_reimbursed',
  REIMBURSED: 'reimbursed',
})
export const DERIVED_STATUS_VALUES = Object.freeze([
  'pending', 'partially_paid', 'paid',
  'outstanding', 'partially_reimbursed', 'reimbursed',
])

// Per-stream derived ladder (initial → partial → terminal).
export const STREAM_DERIVED_STATUSES = Object.freeze({
  payslip: Object.freeze({
    initial: 'pending',
    partial: 'partially_paid',
    terminal: 'paid',
  }),
  petty_cash: Object.freeze({
    initial: 'outstanding',
    partial: 'partially_reimbursed',
    terminal: 'reimbursed',
  }),
})

// Maps a DERIVED display status back to the canonical STORED value the
// recomputer would persist (partial states collapse to the stream's initial
// stored value, since the column has no partial state).
export const DERIVED_TO_STORED = Object.freeze({
  pending: 'pending',
  partially_paid: 'pending',
  paid: 'paid',
  outstanding: 'outstanding',
  partially_reimbursed: 'outstanding',
  reimbursed: 'claimed',
})

// ── reconciliation_audit.action — closed enum for Phase 3 (§ 7.2) ────────────
export const RECONCILIATION_ACTIONS = Object.freeze({
  SET_PAYMENT_METHOD: 'set_payment_method',
  ROUTE_CHANGE: 'route_change',
  LINK_PAYMENT: 'link_payment',
  UNLINK_PAYMENT: 'unlink_payment',
  MARK_PAID: 'mark_paid',
  MARK_CLAIMED: 'mark_claimed',
  REGRESS_STATUS: 'regress_status',
  NOTE_DISCREPANCY: 'note_discrepancy',
})
export const RECONCILIATION_ACTION_VALUES = Object.freeze([
  'set_payment_method', 'route_change', 'link_payment', 'unlink_payment',
  'mark_paid', 'mark_claimed', 'regress_status', 'note_discrepancy',
])

// ── entitlement_payment_links.link_kind taxonomy (§ 5.3) ─────────────────────
/** @typedef {'auto_match'|'manual'|'discrepancy_note'} LinkKind */
export const LINK_KINDS = Object.freeze({
  AUTO_MATCH: 'auto_match',
  MANUAL: 'manual',
  DISCREPANCY_NOTE: 'discrepancy_note',
})
export const LINK_KIND_VALUES = Object.freeze(['auto_match', 'manual', 'discrepancy_note'])

// Only these link kinds count toward terminal-state determination (§ 5.5).
// `discrepancy_note` is intentionally excluded — it records "I see this, it's
// related, it should NOT count" without losing the trail.
export const STATUS_ELIGIBLE_LINK_KINDS = Object.freeze(['auto_match', 'manual'])

// ── payment_records.source provenance (§ 4.4) ────────────────────────────────
/** @typedef {'manual'|'payslip_screenshot'|'payslip_pdf'|'petty_cash_export'} PaymentRecordSource */
export const PAYMENT_RECORD_SOURCES = Object.freeze({
  MANUAL: 'manual',
  PAYSLIP_SCREENSHOT: 'payslip_screenshot',
  PAYSLIP_PDF: 'payslip_pdf',
  PETTY_CASH_EXPORT: 'petty_cash_export',
})
export const PAYMENT_RECORD_SOURCE_VALUES = Object.freeze([
  'manual', 'payslip_screenshot', 'payslip_pdf', 'petty_cash_export',
])

// ── Terminal-determination tolerance (§ 4.3 / blocker #4) ────────────────────
// Dollars-first entitlements are terminal when sum_allocated ≥ effective − TOL.
// One cent absorbs payslip rounding; the single defensible MVP default.
export const DEFAULT_TOLERANCE = 0.01

// Entitlement unit discriminator (mirrors claim_entitlements.unit).
export const ENTITLEMENT_UNITS = Object.freeze({
  DOLLARS: 'dollars',
  HOURS: 'hours',
  KM: 'km',
})
