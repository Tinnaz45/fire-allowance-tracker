# Reconciliation Layer — retractPayment + routeEntitlement Validation Report

Version: v1.0
Status: Built & validated in DEV
Last Updated: 2026-06-04
Branch: `dev`

Closes the two remaining cross-layer dependencies the OCR Payslip Import
architecture identified:

- [OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md](OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md)
  § 6.4 (routing-unknown lines need `routeEntitlement`), § 6.5 (reverse bridge
  needs `retractPayment`), § 11 cross-layer dependency note.
- [RECONCILIATION_STATE_ARCHITECTURE_v1.0.md](RECONCILIATION_STATE_ARCHITECTURE_v1.0.md)
  § 9.1 (`routeEntitlement`), § 9.4 (`retractPayment`), § 7.2 (audit actions),
  § 12 (invariants).
- `PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md` § 7 Steps F (`retractPayment`) + G
  (`routeEntitlement`).

---

## 1. What was built

| Layer | Artifact | Notes |
|-------|----------|-------|
| Schema (RPC) | `fat.route_entitlement(p_entitlement_id, p_stream, p_actor_id, p_reason)` | § 9.1. NULL → stream only; refuses already-routed. |
| Schema (RPC) | `fat.retract_payment(p_payment_record_id, p_actor_id, p_reason, p_tolerance)` | § 9.4. Hard-delete + cascade + per-entitlement recompute & audit. |
| Migration | [supabase/canonical/09_reconciliation_retract_route.sql](../supabase/canonical/09_reconciliation_retract_route.sql) | Applied to DEV as `canonical_09_reconciliation_retract_route`. Additive, idempotent. |
| Service | `routeEntitlement()` in [lib/fat/services/reconciliation.js](../lib/fat/services/reconciliation.js) | Thin validated wrapper over the RPC. |
| Service | `retractPayment()` in [lib/fat/services/paymentRecords.js](../lib/fat/services/paymentRecords.js) | The reverse of `recordPayment`. |
| Test | [scripts/test-retract-route.mjs](../scripts/test-retract-route.mjs) | 27 assertions, DEV-only, self-cleaning. |

No new audit actions were needed — both RPCs emit values already in the closed
§ 7.2 enum: `route_entitlement` → `set_payment_method`, `retract_payment` →
`unlink_payment` (one per DISTINCT formerly-linked entitlement). Both are already
present in `RECONCILIATION_ACTIONS`
([reconciliationConstants.js](../lib/fat/models/reconciliationConstants.js)).

---

## 2. Design decisions (conforming to the existing architecture — no redesign)

- **Both helpers are Postgres RPCs**, `SECURITY INVOKER`, `search_path = fat,
  pg_temp` — identical posture to migration 08, so owner-only RLS guards the
  authenticated path and `service_role` bypasses as designed. The atomic-mutation
  rule (§ 7.4 / invariant § 12.5) holds: each RPC's mutation(s) **and** audit
  row(s) commit in one transaction.
- **`retract_payment` composes the migration-08 internals verbatim**
  (`fat._reconc_recompute`, `fat._reconc_write_audit`) — it introduces **zero**
  new reconciliation semantics, exactly as the OCR architecture promised (§ 7
  "the OCR layer introduces zero new reconciliation semantics").
- **DISTINCT formerly-linked entitlements.** A record settling several
  entitlements (combined payment) or holding both an `auto_match` and a
  `discrepancy_note` link to one entitlement collapses to **one** recompute + one
  `unlink_payment` audit row per distinct entitlement (§ 4.3 / § 6.3).
- **No auto-regress.** `retract_payment` recomputes from the *remaining* links —
  partial coverage from other records can still hold an entitlement terminal; the
  recomputer (not the retraction) decides (§ 4.3, invariant § 12.7). A
  `regress_status` is only persisted when the remaining links no longer satisfy
  the terminal predicate.
- **`route_entitlement` is NULL → stream only.** Already-routed entitlements are
  refused server-side so re-routing stays a separate, explicit operator action
  (§ 3.4); routing is never inferred (§ 3.5 / invariant § 12.6).
- **`automated = false`** on the retraction's `unlink_payment` rows — retraction
  is operator-initiated, matching the single-link `unlink_entitlement_payment`
  precedent (08 § 6).

---

## 3. Validation results

### 3.1 New behaviour — `scripts/test-retract-route.mjs`

`PASS: 27 passed, 0 failed` against DEV (`kctctvpobbizhkiqkgqw`).

**route** (§ 9.1)
- unrouted entitlement surfaces in the needs-routing queue;
- `routeEntitlement` returns `set_payment_method` / `pending`, `prior_status =
  null`, writes an audit row, persists `payslip`/`pending`;
- routed entitlement leaves needs-routing, enters the pending-payslip queue;
- refuses an already-routed entitlement; rejects an invalid stream (JS guard).

**retract** (§ 9.4)
- link → `paid`, then retract: record hard-deleted, links cascade-removed,
  entitlement regressed `paid → pending`, exactly **1** recompute + **1**
  `unlink_payment` audit row; derived status back to `pending`;
- unallocated record retract → **0** recomputes, **0** audit rows;
- combined record settling 2 entitlements (+ a discrepancy_note on one) → exactly
  **2** distinct recomputes + **2** audit rows; both regress to `pending`;
- rejects a missing record id.

**link / unlink preserved**
- `linkPayment` flips pending → paid; `unlinkPayment` regresses paid → pending
  and writes an `unlink_payment` audit row.

### 3.2 Regression — existing suite preserved

`scripts/test-reconciliation-service.mjs` → `PASS: 37 passed, 0 failed`
(unchanged). link, unlink, recompute, queue reads, and the negative guards all
still behave.

### 3.3 Deployment & security checks

- Both functions deployed: `SECURITY INVOKER`, granted to `authenticated` +
  `service_role` only (no `anon`/`public`).
- `get_advisors(security)` after the migration surfaces **no** advisory referencing
  `retract_payment` or `route_entitlement` (both pin `search_path` and are
  `SECURITY INVOKER`). All listed warnings are pre-existing and unrelated.

---

## 4. Invariants honoured

| Invariant (§ 12) | How |
|------------------|-----|
| 1 Snapshot immutability | Neither RPC touches `generated_*` / rule / rate columns. |
| 2 Override isolation | Neither writes `edited_*` / `manual_override`. |
| 3 Stream coherence | `route_entitlement` writes only a stream's legal initial status. |
| 5 Atomic transitions | Each RPC's mutation(s) + audit row(s) in one transaction. |
| 6 Routing deliberate | `route_entitlement` is the explicit NULL→stream act; refuses re-route. |
| 7 No silent regress | `retract_payment` regresses only via the recomputer on the remaining links. |
| 8 Append-only audit | Only INSERTs into `reconciliation_audit`. |
| 10 Record immutability | Retraction is hard-delete + cascade + audit, never an in-place update. |

---

## 5. Follow-ups (unchanged scope — out of this slice)

- OCR producer layer (staging tables, parser adapter, confirm bridge) — design
  only; this report unblocks its § 6.4 / § 6.5 dependencies but builds none of it.
- `reRouteEntitlement` (§ 9.2 / § 3.4) remains unbuilt — not an OCR dependency.
- Migration numbering: the OCR design proposed `09_payslip_import_staging.sql`;
  since this reconciliation completion took the `09` slot, the OCR staging
  migration moves to `10` when built.
