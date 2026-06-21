-- ─── 15. Harden claim_entitlements.payment_status (audit P1-1) ────────────────
-- The reconciliation state machine's STORED vocabulary (null → pending → paid for
-- payslip; null → outstanding → claimed for petty_cash; see reconciliationConstants
-- PAYMENT_STATUS / STREAM_STATUSES) was enforced ONLY in the RPC bodies. The column
-- itself was free `text` (01_canonical_foundation § 6 deferred the CHECK), so a
-- direct UPDATE or a future code path could persist an off-vocabulary value
-- undetected — unacceptable for a financial status column.
--
-- This adds the DB-level guard. NULL stays legal (an unrouted entitlement has no
-- status yet; payment_method is likewise nullable). Existing DEV data is only
-- {pending, claimed} so the constraint validates cleanly with no data loss.
-- Mirrors the existing claim_entitlements_payment_method_check / _unit_check.
-- ─────────────────────────────────────────────────────────────────────────────

alter table fat.claim_entitlements
  drop constraint if exists claim_entitlements_payment_status_check;

alter table fat.claim_entitlements
  add constraint claim_entitlements_payment_status_check
  check (
    payment_status is null
    or payment_status in ('pending', 'paid', 'outstanding', 'claimed')
  );
