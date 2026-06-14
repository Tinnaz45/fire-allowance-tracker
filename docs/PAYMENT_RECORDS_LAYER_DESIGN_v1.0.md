# Fire Allowance Tracker — Payment Records Layer: Architecture Review & Implementation Roadmap

Version: v1.0
Status: Design — no implementation
Last Updated: 2026-06-03
Branch: `dev`

Builds on (does not supersede):

- [RECONCILIATION_STATE_ARCHITECTURE_v1.0.md](RECONCILIATION_STATE_ARCHITECTURE_v1.0.md) — the canonical state contract (tables, lifecycle, helpers § 9, invariants § 12)
- [CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md) — transition rules
- [ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md](ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md) — generation-side boundary
- [supabase/canonical/01_canonical_foundation.sql](../supabase/canonical/01_canonical_foundation.sql) — deployed schema

---

## 0. Headline finding

**The Payment Records layer does not need to be designed from scratch. The
schema is already deployed and a full state contract already exists.**

The brief asked to "design payment_records schema, define the lifecycle, define
linkage, define audit." All four already exist as canonical artifacts:

| Asked for | Status | Where |
|-----------|--------|-------|
| `payment_records` schema | **Deployed** in DEV | [01_canonical_foundation.sql:326-336](../supabase/canonical/01_canonical_foundation.sql) |
| Payment state lifecycle | **Specified** | RECONCILIATION_STATE_ARCHITECTURE § 2–3 |
| Entitlement ↔ payment linkage | **Deployed + specified** | `entitlement_payment_links` § 5 |
| Partial / combined / adjustment support | **Specified** | § 5.4–5.5, § 6 |
| Audit requirements | **Deployed + specified** | `reconciliation_audit` § 7 |
| Service contracts | **Specified, NOT implemented** | § 9.1–9.10 |

The genuine gap is the **service layer** (§ 9 helpers) plus a small set of
additive schema hardening constraints (§ 10.1 of the spec). This document is
therefore a *review-and-roadmap*, not a fresh design: it validates the deployed
shape against the live engine output, resolves the decisions that MVP cannot
defer, and sequences the build.

---

## 1. What is already in place (verified against code)

### 1.1 Tables (deployed, empty, RLS-enabled)

Three canonical tables exist in the `fat.*` domain and are wired into RLS
(owner-scoped; audit is actor-scoped):

- `fat.payment_records` — one observed real-world pay line.
  [01_canonical_foundation.sql:326](../supabase/canonical/01_canonical_foundation.sql)
- `fat.entitlement_payment_links` — N:M evidence layer (`auto_match` /
  `manual` / `discrepancy_note`).
  [01_canonical_foundation.sql:341](../supabase/canonical/01_canonical_foundation.sql)
- `fat.reconciliation_audit` — append-only action log.
  [01_canonical_foundation.sql:363](../supabase/canonical/01_canonical_foundation.sql)

The settlement-state columns on `fat.claim_entitlements` — `payment_method`,
`payment_status` — are also live ([:250-252](../supabase/canonical/01_canonical_foundation.sql)).

### 1.2 Models (typed, exported)

- [payment.js](../lib/fat/models/payment.js) — `PaymentRecord`,
  `EntitlementPaymentLink` typedefs + table-name constants.
- [reconciliationAudit.js](../lib/fat/models/reconciliationAudit.js) —
  `ReconciliationAuditEntry` typedef.
- [claimEntitlement.js:14-21](../lib/fat/models/claimEntitlement.js) —
  `PaymentMethod` / `PaymentStatus` stream-coherence typedefs.

### 1.3 Generation already routes payment

The live engine **already emits** routing + initial status, so payment_records
has real upstream data to reconcile against today:

- `excess_travel_standby` → `payslip` / `pending`
  ([standby.js:78-79](../lib/fat/engine/generators/standby.js))
- `standby_dismi` → `payslip` / `pending` ([standby.js:108-109](../lib/fat/engine/generators/standby.js))
- `small_meal` → `petty_cash` / `outstanding` ([standby.js:138-139](../lib/fat/engine/generators/standby.js))

These flow live via `mirrorClaimToCanonical` →
`createCanonicalClaim` ([persistEntitlements.js:157](../lib/fat/engine/persistEntitlements.js)),
called from `ClaimsContext.addClaim` for SB/MD claims.

### 1.4 Unit mix matters for the recomputer

Two of the three Standby entitlement types are **hours-first**
(`generated_amount = NULL`, `generated_hours` populated — migration 02 made
this legal). Only `small_meal` is dollars-first. This is the single most
important fact for MVP, because the terminal-state predicate differs by unit
(see § 4.3).

---

## 2. The gap: what does NOT exist yet

| Missing piece | Impact | Spec ref |
|---------------|--------|----------|
| Service-layer helpers (route / record / link / recompute / mark / regress / note / read-queues) | No way to create a payment record or mark an entitlement paid against canonical | § 9.1–9.10 |
| `reconciliationHelpers.js` pure functions (`terminalStatusFor`, `isTerminal`, `statusEligibleLinks`) | Recomputer + UI have no shared predicate | § 10.2 |
| Action-enum + source/link-kind constants | String typos in audit `action`, `link_kind`, `source` are unguarded | § 10.2 |
| Additive DB CHECK constraints | `gross_amount >= 0`, `allocated_amount >= 0` are app-only | § 10.1 |
| Tolerance value for dollars-first terminal determination | Recomputer parameter undefined | Blocker #4 |
| UI surface | No operator can drive any of the above | out of scope here |

The existing prototype [reconciliationUtils.js](../lib/reconciliation/reconciliationUtils.js)
**cannot be reused**: it operates on prototype tables (`recalls`/`standby`/
`spoilt_meals` with `'Paid'`/`'Pending'` and `'Payslip'`/`'Petty Cash'`),
conflates the operational + entitlement + payment layers, and carries a known
accumulation bug ([:195-200](../lib/reconciliation/reconciliationUtils.js)).
It must be rewritten, not patched.

---

## 3. `payment_records` schema review (validated, with hardening)

The deployed shape is correct and complete for MVP. No structural change is
recommended. Three **additive, non-breaking** hardening items are recommended
to land in a new migration `08_payment_records_hardening.sql`:

```sql
-- 08_payment_records_hardening.sql (recommended, additive only)
alter table fat.payment_records
  add constraint payment_records_gross_amount_nonneg
  check (gross_amount >= 0) not valid;            -- validate after backfill check

alter table fat.entitlement_payment_links
  add constraint epl_allocated_amount_nonneg
  check (allocated_amount >= 0) not valid;

-- Prevent duplicate status-eligible links for the same (entitlement, record).
-- discrepancy_note intentionally excluded (operator may add several).
create unique index if not exists uq_epl_entitlement_record_kind
  on fat.entitlement_payment_links (entitlement_id, payment_record_id, link_kind)
  where link_kind in ('auto_match','manual');
```

Deliberately **deferred** (open canonical blockers, not MVP gates):

- `check (payment_status in (...))` per stream — blocked on the column-split
  TODO (blocker #1). App-layer guard suffices for MVP.
- A `payslip_imports` staging table — only needed once OCR ships (blocker #6).
  The current contract is forward-compatible: the staging table will simply
  write `payment_records` rows on confirm.

---

## 4. Payment state lifecycle (the contract MVP must honour)

### 4.1 Two independent stream machines

```
payslip:     NULL ──route──▶ pending ──link/mark──▶ paid
                               ▲                       │
                               └──── regress/unlink ───┘

petty_cash:  NULL ──route──▶ outstanding ──link/mark──▶ claimed
                               ▲                          │
                               └──── regress/unlink ──────┘
```

Stream coherence is an invariant at every write: `payslip` status ∈
{null, pending, paid}; `petty_cash` ∈ {null, outstanding, claimed}; method NULL
⇒ status NULL. (RECONCILIATION_STATE_ARCHITECTURE § 2.3.)

### 4.2 Routing is deliberate

`payment_method` goes NULL → non-NULL **only** by explicit operator action. The
matcher never infers routing from a payment match — an unmatched line against an
unrouted entitlement surfaces a "needs routing" discrepancy (§ 3.5). For MVP,
Standby/M&D children arrive **pre-routed** by the engine (§ 1.3), so the
needs-routing queue is empty until Recall/Retain/DM/SM generators land.

### 4.3 Terminal determination differs by unit — the MVP-critical rule

```
status_eligible(e) = links where link_kind ∈ ('auto_match','manual')
sum_allocated(e)   = Σ allocated_amount over status_eligible(e)
```

- **dollars-first** (`unit='dollars'`, e.g. `small_meal`):
  `terminal ↔ sum_allocated ≥ effective_amount − tolerance`
- **hours-first** (`unit='hours'`, e.g. `excess_travel_standby`,
  `standby_dismi`): `terminal ↔ COUNT(status_eligible) ≥ 1`
  (the row carries no dollar quantity at generation; the payslip line *is* the
  dollar settlement event, the link is the evidence).
- **km** (transitional): not emitted; recomputer must refuse to mark terminal.

**MVP decision required (blocker #4): set `tolerance = $0.01`** (one cent, to
absorb rounding). This is the minimal defensible default; revisit if FRV payslip
lines routinely round to 5c. Recorded here so the recomputer ships with a value
rather than a TODO.

---

## 5. Linkage model (`entitlement_payment_links`)

One link = "this payment record contributes `allocated_amount` to this
entitlement, under this `link_kind`." Insert/delete only — never updated in
place (change an allocation by delete + re-insert; the audit story lives in
`reconciliation_audit`, not on the link row).

This single N:M table is what delivers every requested capability:

| Requested capability | How the link model delivers it |
|----------------------|--------------------------------|
| **Partial payments** | Multiple records link to one entitlement; terminal only when `sum_allocated ≥ effective − tolerance` (dollars) or any eligible link exists (hours). |
| **Combined payments** | One `payment_records` row links to N entitlements, each with its own `allocated_amount`. Invariant: `Σ allocated_amount per record ≤ gross_amount`; remainder sits in the unallocated queue. |
| **Payroll adjustments** | A correcting line is a new `payment_records` row; over-/under-allocation is captured as a `discrepancy_note` link (not status-eligible) plus a `note_discrepancy` audit row. Retraction of a wrong line is a hard delete + cascade + one `unlink_payment` audit row per former link. |
| **Manual reconciliation** | `link_kind='manual'` links, plus `markPaid`/`markClaimed` for the "I know it's paid, no record yet" exceptional path. |

`discrepancy_note` links are **not** status-eligible — they let the operator
record "I see this, it's related, it should NOT count" without losing the trail.

---

## 6. Audit requirements

Every payment-state mutation goes through one helper that, in a single
transaction: (1) validates the transition is legal for the current
`payment_method`, (2) mutates `claim_entitlements`, (3) inserts/deletes the link
if applicable, (4) appends exactly one `reconciliation_audit` row. No
mutation-without-audit; no audit-without-mutation (except `note_discrepancy`,
which legitimately leaves status unchanged).

Closed action enum for Phase 3 (pin in JS as `RECONCILIATION_ACTIONS`):
`set_payment_method`, `route_change`, `link_payment`, `unlink_payment`,
`mark_paid`, `mark_claimed`, `regress_status`, `note_discrepancy`.

Append-only is app-enforced today (no UPDATE/DELETE against
`reconciliation_audit` from services); a deny-trigger is deferred to the RLS
policy doc (blocker #10).

---

## 7. Implementation plan

Each step is independently shippable and verifiable; later steps depend on
earlier ones.

**Step A — Pure predicate module** (`lib/fat/models/reconciliationHelpers.js`)
No Supabase dependency, parallel to `entitlementHelpers.js`:
`nextPaymentStatusFor(stream)`, `terminalStatusFor(stream)`,
`isTerminal(entitlement, links, {tolerance})`, `statusEligibleLinks(links)`.
Plus constant exports: `RECONCILIATION_ACTIONS`, `LINK_KINDS`,
`PAYMENT_RECORD_SOURCES`. Unit-testable in plain Node. *Lowest risk, unblocks
everything.*

**Step B — Schema hardening migration** (`08_payment_records_hardening.sql`)
The three additive constraints from § 3. Idempotent, `NOT VALID` then validate.

**Step C — Status recomputer** (`recomputeEntitlementStatus`, spec § 9.6)
The single source of truth for terminal determination. Reads entitlement +
eligible links, applies § 4.3, writes status + returns the transition for the
caller to audit. Every other helper calls this.

**Step D — Payment-record writer + reader queues**
`recordPayment` (§ 9.3, insert-only, validates `gross_amount ≥ 0`) and the pure
read helpers `listUnallocatedPayments`, `listPendingPayslip`,
`listOutstandingPettyCash`, `listEntitlementHistory` (§ 9.10). Ingesting a line
is harmless without a link — it just lands in the unallocated queue.

**Step E — Link helpers** (`linkPayment` / `unlinkPayment`, § 9.5)
Owner + stream + allocation-sum validation; calls Step C; appends
`link_payment` / `unlink_payment` (or `note_discrepancy` for discrepancy links).

**Step F — Manual terminal + regress + note** (`markPaid`, `markClaimed`,
`regressStatus`, `noteDiscrepancy`, § 9.7–9.9) and `retractPayment` (§ 9.4,
hard-delete + cascade + per-former-link audit).

**Step G — Routing helpers** (`routeEntitlement`, `reRouteEntitlement`,
§ 9.1–9.2). Lower priority for MVP because SB/MD arrive pre-routed; needed once
Recall/Retain generators (which defer routing) ship.

**Step H — Operator UI surface** (out of scope for this design): four surfaces
from § 8 — per-entitlement reconciliation drawer, needs-routing queue, pending/
outstanding queues, unallocated-payments queue.

Atomicity note: Supabase JS has no client-side multi-statement transaction.
Each helper that mutates + audits must run as a **Postgres RPC**
(`security invoker`, `search_path = fat, pg_temp`) so the mutation and the audit
insert commit together — mirror the existing
`fat.increment_claim_sequence` pattern ([fat-schema.sql:64](../supabase/fat-schema.sql)).
This is a real design constraint, not a detail: doing it client-side would
violate invariant § 12.5 (atomic transitions) on any partial failure.

---

## 8. MVP recommendation

**Scope: manual, payslip-first reconciliation of Standby & M&D entitlements,
end-to-end.** This is the smallest slice that produces operator value against
data the engine already generates, and it is implementable today with zero open
blockers (every blocker gates an *extension*, not this slice).

In MVP:

- Steps A–F (predicate module → schema hardening → recomputer → record writer +
  read queues → link helpers → manual terminal/regress/note + retraction).
- Both streams (`payslip` paid, `petty_cash` claimed) — the small_meal petty-cash
  line is already generated, so excluding it would leave SB reconciliation
  half-done.
- `source = 'manual'` only. Operator types payslip lines and petty-cash
  submissions.
- Tolerance fixed at **$0.01** (§ 4.3).

Out of MVP (deferred, each independently):

- OCR / PDF payslip ingestion and the `payslip_imports` staging table
  (blockers #6) — the `source` enum and `raw_payload` column already
  accommodate it with no schema change.
- Auto-matcher and confidence thresholds (blocker #5). MVP is manual linking
  only; `auto_match` link_kind exists but is unused until the matcher ships.
- Routing helpers Step G (no unrouted entitlements exist until Recall/Retain
  generators land).
- Canonical petty-cash export format (blocker #7), overdue heuristic
  (blocker #8), payment_status column split (blocker #1), RLS deny-triggers
  (blocker #10), sharing-layer cross-owner reconciliation.

MVP exit criteria: an operator can (1) type a payslip line, (2) manually link it
to one or more SB/M&D entitlements with allocations, (3) see the entitlement
flip to `paid`/`claimed` via the recomputer, (4) see every transition in
`reconciliation_audit`, (5) retract a mis-entered line and watch the status
regress correctly — all enforced atomically server-side and owner-scoped by RLS.

---

## 9. Risks & watch-items

1. **Atomicity** — the single biggest correctness risk. Helpers must be RPCs,
   not client-side multi-step writes (§ 7).
2. **Hours-first terminal rule** — easy to get wrong by applying the dollar
   tolerance to hours rows. The recomputer must branch on `unit` (§ 4.3). Two of
   three SB entitlement types are hours-first, so this path is the common case,
   not the edge case.
3. **Prototype/canonical dual-write** — the app still writes prototype tables as
   primary. Reconciliation operates only on canonical. Do not reconcile against
   prototype `payment_status` ('Paid'/'Pending') — that column belongs to the
   old layer and is unrelated.
4. **`small_meal` petty-cash** — the only dollars-first SB row; it is the only
   place the tolerance rule actually fires in MVP.

---

## 10. Cross-references

- [RECONCILIATION_STATE_ARCHITECTURE_v1.0.md](RECONCILIATION_STATE_ARCHITECTURE_v1.0.md) § 9 (helper contracts), § 11 (blockers), § 12 (invariants)
- [supabase/canonical/01_canonical_foundation.sql](../supabase/canonical/01_canonical_foundation.sql) § 8 (payment tables)
- [lib/fat/engine/generators/standby.js](../lib/fat/engine/generators/standby.js) (live routing output)
- [lib/reconciliation/reconciliationUtils.js](../lib/reconciliation/reconciliationUtils.js) (prototype — to be rewritten, not reused)
