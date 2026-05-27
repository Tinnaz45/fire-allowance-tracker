# Fire Allowance Tracker — Reconciliation State Architecture

Version: v1.0
Status: Draft — specification for Phase 3 reconciliation surface
Last Updated: 2026-05-26
Branch: `dev`

Companion to:

- [REBUILD_PLAN_v1.0.md](REBUILD_PLAN_v1.0.md)
- [REBUILD_AUDIT_v1.0.md](REBUILD_AUDIT_v1.0.md)
- [SCHEMA_READINESS_v1.0.md](SCHEMA_READINESS_v1.0.md)
- [ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md](ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md)
- [CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md)
- Governance canonical source set:
  `C:\Users\Admin\Apps\governance-system\chatgpt-project-sources\fire-allowance-tracker\`
  — `PAYMENT_RECONCILIATION_v1.0.md`,
  `DATABASE_ARCHITECTURE_v1.0.md`,
  `ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md`,
  `ENTITLEMENT_RULES_v1.0.md`.

---

## Purpose

Specify the **reconciliation state contract** — the third architectural
layer of the canonical model — so that Phase 3 reconciliation services
can be written against a single source of truth.

This document is the reconciliation-side counterpart to
[ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md](ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md)
(the generation-side contract) and
[CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md)
(the lifecycle-and-transitions contract). Where the lifecycle doc
specifies the *transitions*, this doc specifies the *state shape* and the
*service contract* around reconciliation — what each table means, how
the streams behave, what `payment_method = NULL` actually represents,
what each link_kind contributes, and what a discrepancy is.

It is a **specification only**:

- It does NOT implement any reconciliation service.
- It does NOT define payslip OCR / PDF parsing semantics.
- It does NOT define the canonical petty-cash export format.
- It does NOT pre-decide the payslip matching heuristic (threshold,
  fuzzy-match rules, confidence scoring).
- It does NOT invent the `payslip_imports` raw-ingest table — that
  remains an open canonical TODO.

Every speculation is marked **Recommendation:** and clearly distinguished
from canonical decisions. Every open blocker is surfaced explicitly so
Phase 3 step 5 (reconciliation surface) lands without ambiguity.

---

## Non-Goals

- Resolving any canonical reconciliation TODO. Recommended defaults are
  marked **Recommendation:**.
- Specifying Phase 3 service file layout. The contracts below are
  service-shape-agnostic — one module or many; helper or class.
- Specifying UI behaviour beyond the operator-visible action surface
  (the buttons, status chips, and discrepancy queues the UI needs to
  render or trigger).
- Specifying payslip ingestion mechanics (OCR / PDF parsing /
  duplicate detection). Only the *consumer* contract — the shape of
  `payment_records` rows the ingestion subsystem must produce — is in
  scope.
- Defining the canonical petty-cash export column shape. That remains a
  canonical TODO in `PAYMENT_RECONCILIATION_v1.0.md`.
- Specifying RLS policy text. RLS implications of each helper are
  noted; the policy spec lives in a future document
  (`DATABASE_ARCHITECTURE_v1.0.md § TODO`).
- Specifying the overdue-detection heuristic ("how late is late"). Open
  TODO in `PAYMENT_RECONCILIATION_v1.0.md`.

---

## 1. Reconciliation Layer Recap

The canonical model has three layers (see
`ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md § Core Architectural Principle`).
Reconciliation is the third:

```
┌──────────────────────┐
│ Operational Claim    │  what the user did
└──────────┬───────────┘
           │ generation (engine; one-shot, immutable)
           ▼
┌──────────────────────┐
│ Generated Entitlement│  what they were entitled to (snapshot)
└──────────┬───────────┘
           │ reconciliation (this doc; mutates payment-state only)
           ▼
┌──────────────────────┐
│ Payment Record       │  what actually happened (observed real-world pay)
└──────────────────────┘
```

Reconciliation NEVER reaches back to mutate the operational or
entitlement *snapshot* fields. It reads the entitlement snapshot, writes
to the entitlement's *payment-state* columns (`payment_method`,
`payment_status`), inserts/deletes link rows, and appends audit rows.

Source: `PAYMENT_RECONCILIATION_v1.0.md § Future Architecture Guidance`,
`DATABASE_ARCHITECTURE_v1.0.md § 9. Historical Static Accounting Records`.

The mutable surface reconciliation services touch:

| Table                              | Mutable columns                                                                                 |
|------------------------------------|--------------------------------------------------------------------------------------------------|
| `fat.claim_entitlements`           | `payment_method`, `payment_status`, `updated_at`                                                 |
| `fat.payment_records`              | (insert / hard-delete only; never UPDATE in normal use — see § 4.2)                              |
| `fat.entitlement_payment_links`    | (insert / hard-delete only; never UPDATE in place — see § 5.2)                                   |
| `fat.reconciliation_audit`         | (insert only; append-only — see § 6.3)                                                           |

Reconciliation NEVER touches `generated_amount`, `generated_hours`,
`rule_id`, `rule_version`, `rule_explanation`, `formula_explanation`,
`rate_id`, `rate_version_id`, `rate_snapshot`, `generated_at`,
`edited_amount`, `edited_hours`, `edited_note`, `manual_override`. The
last four belong to the **override** subsystem
([CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md § 7](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md))
and are operator-driven, not reconciliation-driven.

---

## 2. Payment Stream Semantics

Two streams. Independent state machines. Independent ingest paths.
Source: `PAYMENT_RECONCILIATION_v1.0.md § Reconciliation Model`.

### 2.1 Payslip stream (`payment_method = 'payslip'`)

| Aspect                | Value / behaviour                                                                                       |
|-----------------------|----------------------------------------------------------------------------------------------------------|
| Real-world settlement | FRV payroll line on the regular pay cycle.                                                              |
| `payment_records.stream` | `'payslip'`                                                                                          |
| Status machine        | `null → pending → paid` (with explicit-action regress `paid → pending`)                                 |
| Initial state at routing | `payment_status = 'pending'`                                                                          |
| Terminal state        | `paid`                                                                                                  |
| Settlement event      | A `payment_records` row with `stream = 'payslip'` is observed and linked to the entitlement.            |
| Ingest sources        | `manual` (operator typed it), `payslip_screenshot` (OCR — subsystem TBD), `payslip_pdf` (parsed — subsystem TBD). |
| Reference field       | `payment_records.reference` carries the payslip line code / identifier.                                 |
| Operator surface      | Reconciliation dashboard; the future "import payslip" UI; manual mark-paid action.                      |

### 2.2 Petty Cash stream (`payment_method = 'petty_cash'`)

| Aspect                | Value / behaviour                                                                                       |
|-----------------------|----------------------------------------------------------------------------------------------------------|
| Real-world settlement | Station petty-cash claim form, reimbursed in cash or by petty-cash transfer.                            |
| `payment_records.stream` | `'petty_cash'`                                                                                       |
| Status machine        | `null → outstanding → claimed` (with explicit-action regress `claimed → outstanding`)                   |
| Initial state at routing | `payment_status = 'outstanding'`                                                                      |
| Terminal state        | `claimed`                                                                                               |
| Settlement event      | The operator confirms the petty-cash form was physically submitted (typically alongside the export).    |
| Ingest sources        | `manual` (operator typed it), `petty_cash_export` (round-tripped from the petty-cash exporter).         |
| Reference field       | `payment_records.reference` carries the petty-cash form reference / ticket number.                      |
| Operator surface      | Reconciliation dashboard; petty-cash export; manual mark-claimed action.                                |

### 2.3 Stream-coherence invariant

The two streams' status values are disjoint. Stored on a single
`payment_status text` column today (`DATABASE_ARCHITECTURE_v1.0.md § 8`),
the coherence is enforced app-side until the canonical TODO on splitting
the column resolves:

| `payment_method`     | Legal `payment_status` values            |
|----------------------|-------------------------------------------|
| `'payslip'`          | `null`, `'pending'`, `'paid'`             |
| `'petty_cash'`       | `null`, `'outstanding'`, `'claimed'`      |
| `NULL`               | `NULL` only                               |

Stream coherence is also the third invariant in
[CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md § 11](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md);
this doc restates it because reconciliation helpers MUST guard against
violating it at every write site.

### 2.4 Why two streams, not one

The two streams differ in three ways that make a unified status model
wrong:

1. **Terminal verb.** Payslip lines are *paid*; petty-cash submissions
   are *claimed*. Conflating the two loses information.
2. **Ingest cadence.** Payslip lines arrive on the FRV pay cycle, often
   in batches via OCR or PDF. Petty-cash submissions are operator-driven
   and bursty.
3. **Confirmation flow.** Payslip *paid* is observed (the line shows
   up). Petty-cash *claimed* is asserted (the form was submitted) — the
   operator confirms the submission, not the matcher.

The two streams therefore use different verbs, different sources, and
different settlement events. Anything in this doc that reads "the
terminal state" is implicitly stream-scoped — `paid` for payslip,
`claimed` for petty_cash. The status recomputer (§ 7.4) is the single
source of truth for "what is the terminal state for this stream?".

---

## 3. `payment_method` Routing Semantics

`payment_method` is the **stream router** — the column that decides
which stream owns an entitlement's settlement. Source:
`PAYMENT_RECONCILIATION_v1.0.md § Payment Method Routing`,
[lib/fat/models/claimEntitlement.js:14](../lib/fat/models/claimEntitlement.js).

```
payment_method ∈ { 'payslip', 'petty_cash', NULL }
```

### 3.1 Three routing postures

| Posture           | Set by           | When                                                                                                    | Initial `payment_status` |
|-------------------|------------------|---------------------------------------------------------------------------------------------------------|---------------------------|
| **Engine-set**    | Entitlement engine | At entitlement generation, per the claim-type routing default. See § 3.2.                              | Stream's initial state (`pending` / `outstanding`). |
| **Operator-set (deferred routing)** | Operator action in the reconciliation surface | When the engine left the entitlement unrouted. See § 3.3.                          | Stream's initial state at the moment routing fires. |
| **Re-routed**     | Operator action  | When an already-routed entitlement is moved to the opposite stream. See § 3.4.                          | New stream's initial state; the old stream's status is overwritten. |

### 3.2 Engine-set routing — per-claim-type defaults

The engine emits `payment_method` according to the claim-type rules in
`ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 5` and the routing table in
`PAYMENT_RECONCILIATION_v1.0.md § Payment Method Routing`:

| Claim type             | Generator default for auto-children                                                                       |
|------------------------|-----------------------------------------------------------------------------------------------------------|
| Recall (RC)            | Auto-children do NOT carry `payment_method` — engine emits `NULL`. Operator routes later.                 |
| Retain (RT)            | Same as Recall — NULL.                                                                                    |
| Standby (SB)           | Excess Travel → `'payslip'`; Standby&Dismi → `'payslip'`; Small Meal Allowance → `'petty_cash'`.          |
| Muster & Dismiss (MD)  | Excess Travel → `'payslip'` (recommended default); Muster&Dismis → `'payslip'` (recommended default).     |
| Delayed Meal (DM)      | Entitlement set still TODO; engine emits `[]`.                                                            |
| Spoilt Meal (SM)       | Entitlement set still TODO; engine emits `[]`.                                                            |

The asymmetry (Standby children pre-routed, Recall/Retain children
deferred) is canonical and intentional. See
[project_standby_entitlement_split](../.claude/memory/project_standby_entitlement_split.md).
M&D default is **Recommendation** per
`ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 5.4`; the canonical doc owns the
final decision.

When the engine sets `payment_method`, it MUST also set the stream's
initial `payment_status`. The engine NEVER emits a terminal state — see
`ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 7 invariant 5`.

### 3.3 Operator-set routing — the only path from `NULL`

For unrouted entitlements (`payment_method IS NULL`), the reconciliation
surface offers an explicit **Route to payslip / petty cash** action.

```
Pre-state:
  payment_method = NULL
  payment_status = NULL

Action: route_to('payslip' | 'petty_cash')

Post-state:
  payment_method = chosen stream
  payment_status = stream's initial state
                   ('pending' for payslip, 'outstanding' for petty_cash)

Audit row:
  action       = 'set_payment_method'
  prior_status = NULL
  new_status   = stream's initial state
  reason       = operator-supplied (typically 'routed to <stream>')
  automated    = false
```

This is the **only** path from `NULL` to non-NULL. Routing is NEVER
inferred automatically — see § 3.5.

### 3.4 Re-routing — between streams

For already-routed entitlements, the operator can switch the stream.
This is rare (operator decided what was a petty-cash line is actually a
payslip line, or vice versa) but legitimate.

```
Pre-state:
  payment_method = 'payslip'                 (example)
  payment_status = 'pending' | 'paid'        (prior status)

Action: route_to('petty_cash')

Post-state:
  payment_method = 'petty_cash'
  payment_status = 'outstanding'             (new stream's initial state)

Audit row:
  action       = 'route_change'
  prior_status = (prior status)
  new_status   = 'outstanding'
  reason       = operator-supplied
  automated    = false
```

Re-routing is the only legitimate path from a stream-scoped status back
to the opposite stream's initial state. Link-row policy: existing
`entitlement_payment_links` rows pointing at the prior stream are not
auto-deleted. Whether the operator deletes them is their choice — the
recommendation is to **delete** prior-stream links during the same
operator action so the audit record makes the regression visible per
[CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md § 3.2](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md).

### 3.5 Routing is NEVER inferred

If a `payment_records` line lands against an unrouted entitlement, the
matcher does NOT silently route. Instead, it surfaces a **"needs
routing"** discrepancy (§ 8.2) and waits for the operator. Mirrors
`PAYMENT_RECONCILIATION_v1.0.md § Discrepancy Handling`.

Why this is strict: routing is a business decision (what stream this
entitlement *belongs* to). Inferring it from a payslip match makes
"matched on payslip" mean "is a payslip line" — which conflates evidence
with policy and loses the operator's "this should have been petty cash"
override pathway.

### 3.6 Permission-scoped routing

Routing actions are owner-scoped today (`auth.uid() = owner_id`
enforced via the `users_manage_own` policy on `fat.claim_entitlements`,
[01_canonical_foundation.sql:467-469](../supabase/canonical/01_canonical_foundation.sql)).
When the sharing layer ships, a shared copy's recipient inherits routing
authority — the routing surface remains owner-only against the *copy's*
owner_id, not the source.

---

## 4. `payment_records` Semantics

A `payment_records` row represents one **observed real-world payment
line**. It is the system's source of truth for "what actually happened
on the pay side." Source: `DATABASE_ARCHITECTURE_v1.0.md § 7`,
[lib/fat/models/payment.js](../lib/fat/models/payment.js).

### 4.1 Row shape (recap)

```
fat.payment_records
  id            uuid PK
  owner_id      uuid → profiles.id
  stream        'payslip' | 'petty_cash'
  record_date   date           (pay date OR petty-cash submission date)
  reference     text NULL      (payslip line code / form ref)
  gross_amount  numeric(12,2)  (amount as observed)
  raw_payload   jsonb NULL     (ingest snapshot — OCR text / parsed line / export row)
  source        'manual' | 'payslip_screenshot' | 'payslip_pdf' | 'petty_cash_export'
  created_at    timestamptz
```

Stream-specific reading:

| Field          | Payslip stream                                                | Petty cash stream                                          |
|----------------|---------------------------------------------------------------|------------------------------------------------------------|
| `record_date`  | The payslip's pay date.                                       | The date the petty-cash form was submitted.                |
| `reference`    | Payslip line code (e.g. payroll code identifying the line).   | Petty-cash form reference / ticket number.                 |
| `gross_amount` | Gross dollar amount of the line as shown on the payslip.      | Dollar amount of the submission.                           |
| `raw_payload`  | OCR'd text / parsed PDF row / `null` for manual entries.      | Export round-trip row / `null` for manual entries.         |

### 4.2 Creation contract

Two paths today:

1. **Operator-typed.** The reconciliation UI exposes "Add payslip line
   / petty-cash submission" forms. `source = 'manual'`. `raw_payload`
   MAY be null.
2. **Subsystem-ingest.** A future payslip-import or
   petty-cash-export-roundtrip subsystem inserts rows on the operator's
   behalf. `source ∈ {'payslip_screenshot','payslip_pdf','petty_cash_export'}`.
   `raw_payload` carries the snapshot (OCR text / parsed PDF row /
   export row).

Both paths MUST go through the **payment-record writer** (§ 9.3) so
that:

- `owner_id` is set from the actor (or, for service_role batches, from
  the user the run is owned by).
- `created_at` is set automatically.
- `gross_amount >= 0` is validated (no DB CHECK today; recommended
  follow-up).
- The row is inserted before any `entitlement_payment_links` row that
  references it (FK enforced —
  [01_canonical_foundation.sql:344](../supabase/canonical/01_canonical_foundation.sql)).

Neither path auto-creates `entitlement_payment_links` rows. Link
creation is a separate operator action (manual match) or a separate
matcher pass (auto-match). The two are deliberately decoupled so that
ingesting an unmatched line is harmless — it just sits in the
"unallocated payments" queue (§ 8.4).

### 4.3 Immutability and retraction

Once written, a `payment_records` row is **immutable** in normal use.
Reconciliation services MUST NOT update any column.

Two narrow exceptions, both subject to the rules in
[CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md § 4.2](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md):

1. **Tagging (future).** A sibling table or a dedicated column may add
   operator tags like "verified" / "disputed" later. These MUST NOT
   shadow `gross_amount` / `reference` / `record_date` / `raw_payload`.
2. **Retraction = hard delete.** If a record was ingested in error
   (OCR misread, duplicate batch, wrong owner), it is hard-deleted.
   Cascade removes all links
   ([01_canonical_foundation.sql:344](../supabase/canonical/01_canonical_foundation.sql)).
   The retraction writer (§ 9.4) MUST append one `unlink_payment`
   `reconciliation_audit` row per formerly-linked entitlement, so each
   entitlement's per-row history reflects the loss of evidence.

The matcher does NOT auto-regress entitlement statuses on retraction —
partial coverage from other linked records may still hold the
entitlement at `paid` / `claimed`. The status recomputer (§ 7.4) is run
once per affected entitlement after the cascade, and only writes a
`regress_status` audit row if the recomputed status differs.

### 4.4 Source provenance — what each `source` means

`source` is the auditable provenance of the row. Reconciliation
helpers MUST set it accurately; the matcher MAY use it to scope rule
behaviour (e.g. require operator confirmation for OCR-sourced lines).

| `source`             | Meaning                                                                                                  | Created by                                          |
|----------------------|----------------------------------------------------------------------------------------------------------|------------------------------------------------------|
| `manual`             | Operator typed the row in.                                                                               | Operator action in the reconciliation UI.            |
| `payslip_screenshot` | OCR run produced this row from a payslip screenshot upload.                                              | Payslip ingestion subsystem (TBD; out of Phase 3).   |
| `payslip_pdf`        | Structured-PDF parser produced this row from a payslip PDF upload.                                       | Payslip ingestion subsystem (TBD).                   |
| `petty_cash_export`  | The petty-cash exporter rendered a submission, and the operator confirmed it was submitted — the row is the round-trip evidence. | Petty-cash exporter (Phase 3 step 5).                |

### 4.5 Open blocker — `payslip_imports` raw-ingest staging

A single payslip upload (screenshot / PDF) may parse into multiple
`payment_records` rows. The canonical TODO
(`PAYMENT_RECONCILIATION_v1.0.md § Payslip Verification (Future)`,
`DATABASE_ARCHITECTURE_v1.0.md § TODO`) is whether to add a
`payslip_imports` staging table with its own lifecycle (drafted →
parsed → confirmed) that produces `payment_records` rows on confirmation.

This doc does NOT pre-decide that. Until it ships:

- `payment_records` is the entry point for every observed line.
- The `source` column is the only provenance trail.
- `raw_payload` carries the per-line OCR / parsed snapshot.

When `payslip_imports` lands, this doc gains a § 4.6 specifying its
relationship with `payment_records`. The current contract is
forward-compatible: the staging table will simply write
`payment_records` rows on confirm, with no schema change to
`payment_records` itself.

### 4.6 RLS implications

Today: `payment_records.owner_id` is owner-only via `users_manage_own`
([01_canonical_foundation.sql:471-475](../supabase/canonical/01_canonical_foundation.sql)).
A future batch payslip-import service running as `service_role` may
insert rows on behalf of any user (using `auth.role() = 'service_role'`
escape via the service-role bypass). The user-facing reconciliation
surface always reads own rows.

---

## 5. `entitlement_payment_links` Semantics

The N:M evidence layer. One link row = "this payment record contributes
this much to this entitlement, under this kind of attestation." Source:
`DATABASE_ARCHITECTURE_v1.0.md § 7`,
[lib/fat/models/payment.js](../lib/fat/models/payment.js).

### 5.1 Row shape (recap)

```
fat.entitlement_payment_links
  id                  uuid PK
  entitlement_id      uuid → claim_entitlements.id   (cascade delete)
  payment_record_id   uuid → payment_records.id      (cascade delete)
  allocated_amount    numeric(12,4)                  (>= 0; no DB CHECK today)
  link_kind           'auto_match' | 'manual' | 'discrepancy_note'
  note                text NULL
  created_at          timestamptz
```

Both FK columns are indexed (FK columns are not auto-indexed in
Postgres —
[01_canonical_foundation.sql:351-355](../supabase/canonical/01_canonical_foundation.sql)).

### 5.2 Lifecycle — insert / delete only

```
(matcher / operator) ──insert──▶ entitlement_payment_links
                                       │
                                       │ (delete on retraction
                                       │  or operator replacement)
                                       ▼
                                  (gone — cascade-or-explicit)
```

Links are **never updated in place**. To change an allocation, delete
the link and insert a new one. Row churn is acceptable — each row is
small, indexes are narrow, and the audit story is intact because the
*status transition* the change provoked is recorded in
`reconciliation_audit`, not on the link row itself.

Cascade rules (schema-enforced):

- Delete a `claim_entitlements` row → cascade delete its links.
- Delete a `payment_records` row → cascade delete its links.
- Delete an `operational_claims` row → cascade through entitlements
  through links.

### 5.3 `link_kind` taxonomy

The single column that distinguishes "evidence of payment" from
"informational note about a related line." Source:
`DATABASE_ARCHITECTURE_v1.0.md § 7`,
`PAYMENT_RECONCILIATION_v1.0.md § Discrepancy Handling`,
[lib/fat/models/payment.js:22](../lib/fat/models/payment.js).

| `link_kind`         | Created by                                  | Contributes to `paid` / `claimed`? | `allocated_amount` semantics                                                                                                       | `note` usage                                                                            |
|---------------------|---------------------------------------------|------------------------------------|------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| `auto_match`        | Matcher service (automated)                 | **Yes**                            | The matcher's allocation of the payment line to this entitlement. For partial coverage, the matcher splits the line across N entitlements such that `SUM(allocated_amount) <= payment_record.gross_amount`. | Matcher's confidence score / rule trace.                                                |
| `manual`            | Operator action in the reconciliation UI    | **Yes**                            | The operator's allocation. Same constraint as `auto_match`.                                                                        | Operator's reason / context.                                                            |
| `discrepancy_note`  | Operator                                    | **No**                             | Informational — typically `0` or a partial value the operator records for transparency. Must NOT count toward terminal-state determination. | The discrepancy description (e.g. "underpaid by $5", "wrong line code, kept for reference"). |

`auto_match` and `manual` are **status-eligible** links. They are the
only kinds the status recomputer counts toward `paid` / `claimed`.
`discrepancy_note` links exist precisely so the operator can record "I
see this line, it's related, but it should NOT count" without losing
the audit trail of the observation.

### 5.4 Allocation semantics

For each `payment_records` row that is linked:

```
sum(allocated_amount across all links from this record) ≤ gross_amount
```

This invariant is **app-layer enforced** today. There is no DB CHECK.
The matcher and the operator manual-link helper MUST refuse a link
that would push the sum over `gross_amount`.

Why `≤` and not `=`: a payment line may legitimately have un-allocated
remainder (e.g. a payslip line that covered N entitlements plus a small
unrelated adjustment the operator hasn't yet decided how to model).
The remainder shows up in the "unallocated payments" queue (§ 8.4).

### 5.5 Status-recompute predicate (terminal-state determination)

The single source of truth for "should this entitlement be marked
paid/claimed?". Source: `PAYMENT_RECONCILIATION_v1.0.md § Status
Lifecycle`,
[CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md § 5.1](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md).

```
status_eligible_links(e) = links where link_kind ∈ ('auto_match','manual')
sum_allocated(e)         = SUM(allocated_amount for status_eligible_links)
effective_amount(e)      = e.edited_amount ?? e.generated_amount
effective_hours(e)       = e.edited_hours  ?? e.generated_hours
```

Terminal-state determination (per stream):

- **Dollars-first entitlement** (`unit = 'dollars'`):
  ```
  is_terminal(e) ↔ sum_allocated(e) >= effective_amount(e) − tolerance
  ```
  Tolerance is a Phase 3 reconciliation-surface decision; see § 11
  blocker #4.
- **Hours-first entitlement** (`unit = 'hours'`):
  ```
  is_terminal(e) ↔ COUNT(status_eligible_links(e)) >= 1
  ```
  Rationale: hours-first rows carry no dollar quantity at generation.
  The payslip line is the dollar settlement event; the link is the
  evidence. Hours-first link rows MAY have `allocated_amount = 0`
  because the entitlement carries no dollar quantity to allocate
  against. (Recommendation: store the dollar amount from the payslip
  line on the link row anyway — it makes future audits cheaper without
  changing semantics.)
- **`km` unit (transitional)**: not currently emitted by the engine.
  Reserved. If/when emitted, the recomputer MUST refuse to mark
  terminal pending a canonical rule.

If `is_terminal(e)`, transition to the stream's terminal state
(`paid` / `claimed`). If `e` was previously terminal and is no longer,
the recomputer transitions back to `pending` / `outstanding` and
appends a `regress_status` audit row. See § 7.4 for the helper
contract.

### 5.6 Invariants

1. `entitlement.owner_id == payment_record.owner_id` for any link the
   user-facing matcher or manual-link surface creates. Cross-owner
   links are reserved for the sharing layer and MUST NOT be created
   today.
2. `entitlement.payment_method == payment_record.stream`. A payslip
   `payment_records` row MUST NOT be linked to a petty_cash-routed
   entitlement, and vice versa. (App-layer guard; no DB CHECK.)
3. `allocated_amount >= 0`. (App-layer today; recommended follow-up
   DB CHECK — see § 10.1.)
4. `SUM(allocated_amount)` over the links from a single `payment_records`
   row ≤ `gross_amount`. (App-layer; expensive to express as a DB
   CHECK; recommend trigger if it becomes a problem.)
5. Deleting all status-eligible links from a terminal-state entitlement
   triggers a recompute. The recomputer either confirms the transition
   away from terminal (writes `regress_status`) or leaves the state
   alone (no audit row written). The matcher MUST NOT silently regress
   on its own — it goes through the recomputer (§ 7.4).

---

## 6. Discrepancy States

What it means for a reconciliation step to "go wrong" — and what the
system records when it does. Source:
`PAYMENT_RECONCILIATION_v1.0.md § Discrepancy Handling`.

### 6.1 Discrepancy taxonomy

The canonical doc lists three operator outcomes when a payslip line
doesn't cleanly match. This doc lifts them out into a taxonomy
that's exhaustive across both streams.

| Discrepancy type                | Cause                                                                                                | Storage representation                                                                                                | Audit action          |
|---------------------------------|------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|------------------------|
| **Unmatched payment line**      | A `payment_records` row exists but has no `entitlement_payment_links` rows of any kind.              | The `payment_records` row stands alone. Surface as "unallocated payments" (§ 8.4). No link row, no audit row.          | (none until linked)    |
| **Routing-unknown match**       | A payment line is observed against an entitlement with `payment_method = NULL`.                      | The matcher does NOT create a link. It surfaces a "needs routing" discrepancy (§ 8.2). The operator routes, then matches. | (none until routed)    |
| **Underpayment**                | `sum_allocated < effective_amount − tolerance` after the operator has reviewed.                      | Entitlement stays `pending` / `outstanding`. Operator MAY add a `discrepancy_note` link with the partial allocation. | `note_discrepancy` (when the note link is added) |
| **Overpayment**                 | A payment line exceeds the entitlement's effective amount.                                           | Allocate up to `effective_amount`; remainder stays unallocated on the `payment_records` row. Operator MAY add a `discrepancy_note` link recording the over-allocation observation. | `note_discrepancy`     |
| **Wrong-line attribution**      | A payment line looks related but isn't (different rule, different period).                           | The operator MAY add a `discrepancy_note` link to record the false positive.                                          | `note_discrepancy`     |
| **Overdue (expected, missing)** | An entitlement remains `pending` past its expected pay cycle.                                        | Status unchanged. UI surfaces it via an overdue heuristic (TODO).                                                     | (none — UI-only)       |
| **Payroll error**               | Operator concludes the line is a payroll mistake (FRV's, not the operator's).                       | `discrepancy_note` link + an entitlement-level note (free-text in `note` on the link). Optional `payment_records` retraction if appropriate. | `note_discrepancy`     |

Note: the system does NOT auto-create entitlements for unmatched
payslip lines — explicit in
`PAYMENT_RECONCILIATION_v1.0.md § Discrepancy Handling`. An unmatched
line stays in the "unallocated payments" queue until an operator
decides what to do with it.

### 6.2 What this doc deliberately does NOT define

The following are **out of scope** for this contract and remain
canonical TODOs:

- The OCR/import duplicate-detection rule.
- The exact "looks related" heuristic the matcher uses to nominate a
  payslip line for a given entitlement.
- The confidence-threshold rule that decides when an `auto_match` link
  is automatically created vs. surfaced as a manual review queue.
- The dollar tolerance for "close enough to terminal" (§ 5.5).
- The overdue-detection heuristic (how late is "late" per claim type
  / stream).
- The discrepancy-resolution UI's queue order.

This doc specifies the **storage representation** of each discrepancy
(which table, which `link_kind`, which audit `action`). The matching
heuristic, threshold, and resolution UI live elsewhere.

### 6.3 Discrepancy state is queryable historically

Per `PAYMENT_RECONCILIATION_v1.0.md § Future Architecture Guidance` —
"discrepancy tracking should be queryable historically." The
representation above satisfies that: every discrepancy lands in one of
three places, all of which are queryable by date range:

1. `payment_records` rows (unmatched lines — query by `record_date`).
2. `entitlement_payment_links` rows with `link_kind =
   'discrepancy_note'` — query by `created_at` joined to entitlement /
   record.
3. `reconciliation_audit` rows with
   `action ∈ ('note_discrepancy','regress_status','unlink_payment')`
   — query by `created_at` joined to entitlement.

"What did this pay cycle look like?" is then a join across
`payment_records.record_date` (the pay cycle) and the link/audit rows
keyed off it.

---

## 7. `reconciliation_audit` Event Contract

Append-only event log. Source:
`DATABASE_ARCHITECTURE_v1.0.md § 7`,
`PAYMENT_RECONCILIATION_v1.0.md § Audit Trail Requirements`,
[lib/fat/models/reconciliationAudit.js](../lib/fat/models/reconciliationAudit.js),
[CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md § 6](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md).

### 7.1 Row shape (recap)

```
fat.reconciliation_audit
  id              uuid PK
  entitlement_id  uuid → claim_entitlements.id   (cascade delete)
  actor_id        uuid → profiles.id             (cascade delete)
  action          text                           (enum below)
  prior_status    text NULL
  new_status      text NULL
  reason          text NULL
  automated       boolean (default false)
  created_at      timestamptz
```

Indexed `(entitlement_id, created_at desc)` for the per-entitlement
history view
([01_canonical_foundation.sql:375-376](../supabase/canonical/01_canonical_foundation.sql)).

### 7.2 Canonical `action` enum

The `action` column is `text` with no DB CHECK today. The values below
are the **canonical enum** the reconciliation surface MUST emit; the
list is closed for Phase 3.

| `action`                | Triggered by                                                                                                | `prior_status`     | `new_status`              | `automated` typical |
|-------------------------|-------------------------------------------------------------------------------------------------------------|--------------------|----------------------------|---------------------|
| `set_payment_method`    | Operator routes an unrouted entitlement (§ 3.3).                                                            | `null`             | `'pending'` / `'outstanding'` | false              |
| `route_change`          | Operator re-routes an entitlement between streams (§ 3.4).                                                  | prior status       | new stream's initial state | false              |
| `link_payment`          | Auto-matcher OR operator links a `payment_records` line to an entitlement.                                  | prior status       | recomputed status          | true / false        |
| `unlink_payment`        | Operator deletes a link OR a `payment_records` row is retracted (per § 4.3, one row per former-link).        | prior status       | recomputed status          | false / true        |
| `mark_paid`             | Operator manually marks a payslip entitlement paid (no link required — exceptional path).                   | `'pending'`        | `'paid'`                   | false              |
| `mark_claimed`          | Operator manually marks a petty-cash entitlement claimed (typically alongside an export confirmation).      | `'outstanding'`    | `'claimed'`                | false              |
| `regress_status`        | Operator explicitly regresses a terminal entitlement OR the recomputer regresses on link-set drop.          | `'paid'` / `'claimed'` | `'pending'` / `'outstanding'` | false / true        |
| `note_discrepancy`      | Operator records a `discrepancy_note` link OR records a free-text discrepancy without a link change.        | (unchanged)        | (unchanged)                | false              |

`automated` distinguishes matcher-originated actions from operator
actions. The `reason` column carries the operator's free-text note (for
manual actions) or the matcher's rule trace (for automated actions).

### 7.3 What MUST NOT trigger an audit row

Drawn from
[CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md § 6.2](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md);
restated here so the reconciliation services have a single checklist.

- Engine-side INSERT of a new entitlement. (Initial state captured by
  `claim_entitlements.generated_at`.)
- Manual edits to `edited_amount` / `edited_hours` / `edited_note` /
  `manual_override`. (Override-edit history is a separate audit
  concern; recommendation is a sibling `entitlement_edit_audit` table
  when needed — see lifecycle § 7.4.)
- `operational_claims.status` transitions (draft → submitted →
  archived).
- `payment_records` row INSERT. (The record's own `created_at` and
  `source` are the audit. Retraction, by contrast, DOES write
  `unlink_payment` audit rows — once per formerly-linked entitlement.)
- Mere READ of an entitlement, link, or payment record.

### 7.4 Atomic-mutation rule

Every payment-state mutation MUST go through a single reconciliation
helper that, in one transaction:

1. Validates the transition is legal under the current
   `payment_method` (per § 2.3).
2. Performs the column mutation on `claim_entitlements`.
3. Inserts/deletes the `entitlement_payment_links` row if applicable.
4. Inserts the matching `reconciliation_audit` row.

No mutation path is allowed to skip the audit row. No audit row is
allowed without a corresponding mutation, except `note_discrepancy`
which legitimately leaves status unchanged.

This is invariant #3 in
[CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md § 11](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md).
It MUST be enforced at the service layer; a future DB trigger may
enforce it once the policy spec lands.

### 7.5 Append-only enforcement and RLS

App-layer invariant today:

- Reconciliation services MUST NOT issue UPDATE or DELETE against
  `fat.reconciliation_audit`.
- A future trigger or RLS update-deny policy may enforce it once the
  policy spec doc ships (`DATABASE_ARCHITECTURE_v1.0.md § TODO`).

Read scope today: actor-scoped via the `users_manage_own` policy
keyed off `actor_id`
([01_canonical_foundation.sql:480-485](../supabase/canonical/01_canonical_foundation.sql)).
Open TODO: whether the entitlement *owner* should also be able to read
audit rows where `actor_id != owner_id` (relevant once sharing ships).
Phase 3 step 5 does NOT need this resolved.

---

## 8. Operator Surfaces (Reconciliation Service Surfaces)

The reconciliation service has four distinct operator surfaces. Each
surface is backed by one or more of the helpers in § 9. None of them
are UI specifications — they are the **state queries** the UI needs to
render.

### 8.1 Per-entitlement reconciliation view

```
Input:  entitlement_id
Output: {
  entitlement,                           // claim_entitlements row
  effective_amount,                      // helper § 4 of engine contracts
  effective_hours,                       // helper § 4 of engine contracts
  links: [...],                          // entitlement_payment_links rows
  status_eligible_sum,                   // computed per § 5.5
  audit_history: [...],                  // reconciliation_audit rows, desc
  derived_status_recommendation,         // 'pending'|'paid'|'outstanding'|'claimed'|null
}
```

Backed by: § 9.5 read helpers. Backs the "details drawer" /
"reconciliation row" UI.

### 8.2 Needs-routing queue

Entitlements where `payment_method IS NULL`, sorted by claim date.
Owner-only. Backs the "you have N unrouted entitlements" banner and
the bulk-route UI.

### 8.3 Pending / outstanding queues (per stream)

Two queues, one per stream:

- **Pending payslip**: `payment_method = 'payslip' AND payment_status =
  'pending'`.
- **Outstanding petty cash**: `payment_method = 'petty_cash' AND
  payment_status = 'outstanding'`.

Backs the per-stream "to be reconciled" lists and (eventually) the
overdue surface.

### 8.4 Unallocated payments queue

Payment records with no status-eligible links — i.e. payment lines that
have not yet been allocated to any entitlement. Owner-only.

```
Predicate:
  payment_records p
  WHERE NOT EXISTS (
    SELECT 1 FROM entitlement_payment_links l
    WHERE l.payment_record_id = p.id
      AND l.link_kind IN ('auto_match','manual')
  )
  AND p.owner_id = auth.uid()
```

Backs the "you have N unmatched payment lines" banner. Includes
unmatched payslip lines (both manual and import-sourced) and unmatched
petty-cash submissions.

---

## 9. Service-Layer Contracts (Phase 3 Reconciliation Helpers)

These are the new responsibilities Phase 3 step 5 MUST implement based
on this spec. None of them are implementable from the current prototype
[lib/reconciliation/reconciliationUtils.js](../lib/reconciliation/reconciliationUtils.js)
which conflates the three layers (operational + entitlement + payment
state).

### 9.1 Routing helper — `routeEntitlement`

```ts
routeEntitlement({
  entitlement_id,
  stream: 'payslip' | 'petty_cash',
  reason?: string,
}) → ReconciliationResult
```

Behaviour:

- Reads the entitlement; refuses if `payment_method` is already
  non-null (operator must call § 9.2 `reRouteEntitlement` instead, so
  the action is explicit).
- Sets `payment_method = stream`.
- Sets `payment_status` to the stream's initial state.
- Appends `set_payment_method` audit row with `prior_status = null`,
  `new_status = initial state`, `reason`, `automated = false`.
- Returns the new entitlement state.

Single transaction.

### 9.2 Re-routing helper — `reRouteEntitlement`

```ts
reRouteEntitlement({
  entitlement_id,
  to_stream: 'payslip' | 'petty_cash',
  reason?: string,
  delete_prior_stream_links?: boolean,  // default true
}) → ReconciliationResult
```

Behaviour:

- Reads the entitlement; refuses if `payment_method = to_stream` (no-op).
- Optionally deletes prior-stream status-eligible links (default
  true) — for each deletion, append an `unlink_payment` audit row.
- Sets `payment_method = to_stream`.
- Sets `payment_status` to the new stream's initial state.
- Appends `route_change` audit row.
- Returns the new entitlement state.

Single transaction across all link deletions + status flip + audit
rows.

### 9.3 Payment-record writer — `recordPayment`

```ts
recordPayment({
  stream: 'payslip' | 'petty_cash',
  record_date: string,
  reference?: string,
  gross_amount: number,
  raw_payload?: object,
  source: 'manual' | 'payslip_screenshot' | 'payslip_pdf' | 'petty_cash_export',
  owner_id?: string,    // defaults to auth.uid()
}) → PaymentRecord
```

Behaviour:

- Validates `gross_amount >= 0`.
- Inserts the `payment_records` row.
- Returns the inserted row. Does NOT create any links.

Single statement. The caller (matcher / manual link helper) is
responsible for any subsequent linking.

### 9.4 Payment-record retraction — `retractPayment`

```ts
retractPayment({
  payment_record_id,
  reason?: string,
}) → { entitlements_recomputed: number, audit_rows_written: number }
```

Behaviour:

- Reads the link set for the record (before delete).
- Hard-deletes the `payment_records` row (cascades the link rows).
- For each formerly-linked entitlement:
  - Recomputes status via § 9.6.
  - Appends one `unlink_payment` audit row with the entitlement's
    pre-cascade status and the recomputed post-cascade status.
- Returns counters.

Single transaction.

### 9.5 Link helpers — `linkPayment` / `unlinkPayment`

```ts
linkPayment({
  entitlement_id,
  payment_record_id,
  allocated_amount: number,
  link_kind: 'auto_match' | 'manual' | 'discrepancy_note',
  note?: string,
  automated?: boolean,
}) → ReconciliationResult

unlinkPayment({
  link_id,
  reason?: string,
}) → ReconciliationResult
```

`linkPayment` behaviour:

- Validates owner coherence (entitlement.owner_id ==
  payment_record.owner_id == auth.uid() for the user-facing path).
- Validates stream coherence (entitlement.payment_method ==
  payment_record.stream). Refuses if the entitlement is unrouted —
  caller must route first (§ 3.5).
- Validates allocation: `allocated_amount >= 0`; refuses if
  `SUM(allocated_amount on record) + new > gross_amount`.
- Inserts the link row.
- If `link_kind ∈ ('auto_match','manual')`: recomputes status via
  § 9.6 and appends a `link_payment` audit row with the recomputed
  transition.
- If `link_kind = 'discrepancy_note'`: appends a `note_discrepancy`
  audit row with status unchanged.

`unlinkPayment` behaviour:

- Reads the link's `link_kind` and `entitlement_id` before delete.
- Hard-deletes the link.
- If the link was status-eligible: recomputes status via § 9.6 and
  appends an `unlink_payment` audit row.
- If the link was `discrepancy_note`: appends a `note_discrepancy`
  audit row recording the removal of the note (no status change).

Both helpers run in a single transaction.

### 9.6 Status recomputer — `recomputeEntitlementStatus`

```ts
recomputeEntitlementStatus({
  entitlement_id,
  trigger: 'link_added' | 'link_removed' | 'override_edit' | 'manual',
  actor_id: string,
}) → { changed: boolean, prior_status, new_status, audit_row_id?: string }
```

Behaviour:

- Reads the entitlement and its current status-eligible link set.
- Applies the per-stream predicate (§ 5.5).
- If the computed status differs from the stored status:
  - Writes the new status.
  - Appends an audit row whose `action` is decided by `trigger`:
    - `link_added` → `link_payment` (already written by caller; the
      recomputer does NOT double-write — instead it returns the
      recomputed transition so the caller fills in `new_status`).
    - `link_removed` → `unlink_payment` (caller writes — same rule).
    - `override_edit` → `regress_status` (the recomputer writes this
      row directly because the override-edit path doesn't otherwise
      touch `reconciliation_audit`).
    - `manual` → `mark_paid` / `mark_claimed` (operator explicitly
      marked terminal) or `regress_status` (operator explicitly
      regressed); caller specifies which.
- Returns the transition.

The recomputer is the **single source of truth** for "should this
entitlement be terminal?" — matcher, operator UI, override path, and
retraction path all invoke it. Each caller decides which audit
`action` to record, but the *status decision* is centralised here.

### 9.7 Mark-terminal helpers — `markPaid` / `markClaimed`

```ts
markPaid({
  entitlement_id,
  reason?: string,
}) → ReconciliationResult

markClaimed({
  entitlement_id,
  reason?: string,
}) → ReconciliationResult
```

Behaviour:

- Refuses if the entitlement's `payment_method` doesn't match the
  helper (`markPaid` requires `payslip`; `markClaimed` requires
  `petty_cash`).
- Refuses if the entitlement is unrouted.
- Sets `payment_status = 'paid'` / `'claimed'`.
- Appends `mark_paid` / `mark_claimed` audit row.

Does NOT create any link rows. The exceptional "I know it's paid but I
don't have a payment record yet" path. The status recomputer treats
manually-marked-terminal entitlements as terminal; subsequent matcher
runs that find evidence MAY add `auto_match` links without regressing
the status (the entitlement was already terminal; the new evidence is
additive).

### 9.8 Regress helper — `regressStatus`

```ts
regressStatus({
  entitlement_id,
  reason?: string,
  delete_links?: boolean,  // default false
}) → ReconciliationResult
```

Behaviour:

- Refuses if the entitlement is not in a terminal state.
- Sets `payment_status` to the stream's initial state.
- If `delete_links = true`: deletes all status-eligible links
  (each generates an `unlink_payment` audit row).
- Appends a `regress_status` audit row.

The operator-driven escape hatch when a terminal state was reached in
error. The recommended `delete_links` posture varies — see
[CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md § 3.2](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md);
the default is `false` so the operator must make the explicit choice.

### 9.9 Discrepancy note helper — `noteDiscrepancy`

```ts
noteDiscrepancy({
  entitlement_id,
  payment_record_id?: string,  // optional — pure free-text discrepancies don't link
  allocated_amount?: number,   // default 0
  note: string,
}) → ReconciliationResult
```

Behaviour:

- If `payment_record_id` is set: inserts a `discrepancy_note`
  `entitlement_payment_links` row.
- Appends a `note_discrepancy` audit row with the note text in
  `reason`. Status unchanged.

Used for both line-attached and free-text discrepancies (e.g. "expected
this entitlement on the 26 May pay cycle, didn't appear, following up").

### 9.10 Read-only queue helpers

```ts
listNeedsRouting(owner_id) → ClaimEntitlement[]
listPendingPayslip(owner_id) → ClaimEntitlement[]
listOutstandingPettyCash(owner_id) → ClaimEntitlement[]
listUnallocatedPayments(owner_id) → PaymentRecord[]
listEntitlementHistory(entitlement_id) → {
  entitlement, links, audit_history, derived_status
}
```

Pure reads. No mutation. Backs the surfaces in § 8.

---

## 10. Required Schema / Model / Service Changes Before Phase 3

This document is spec-only — no code changes here. The list below is
the prerequisite delta that Phase 3 step 5 (reconciliation surface)
depends on. None of these are blockers for Phase 1/2 sign-off (already
shipped).

### 10.1 Schema follow-ups (additive, deferred to a new canonical migration file)

| Change                                                                                  | Why                                                                                          | Gating decision                          |
|-----------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|-------------------------------------------|
| `check (allocated_amount >= 0)` on `fat.entitlement_payment_links`                      | Mirrors the matrix integrity posture; today nothing prevents a negative allocation.          | Land alongside the tolerance rule.       |
| `check (payment_status in (...))` constrained per `payment_method`                      | App-layer guarded today; DB-side guard once the stream-split TODO resolves.                  | Open canonical TODO #2.                  |
| `check (gross_amount >= 0)` on `fat.payment_records`                                    | Today no DB CHECK; the writer (§ 9.3) enforces it but a defence-in-depth check is cheap.     | Land alongside link CHECK above.         |
| Optional unique index on `(entitlement_id, payment_record_id, link_kind)` in `entitlement_payment_links` | Prevents a duplicate auto_match/manual pair per entitlement-record pair. Open: whether `discrepancy_note` should also be uniqued; recommend not. | Land if duplicate-link bugs surface during Phase 3 step 5. |

None of these block Phase 3 step 5 — every constraint above is
app-layer enforceable by the helpers in § 9.

### 10.2 Model layer (`lib/fat/models/`)

- [payment.js](../lib/fat/models/payment.js): no shape change. The
  typedefs already mirror the canonical schema. Consider adding a
  `PAYMENT_RECORDS_SOURCES` and `LINK_KINDS` constant export for the
  helpers to import from a single source of truth — strictly optional.
- [reconciliationAudit.js](../lib/fat/models/reconciliationAudit.js):
  recommended addition — export a `RECONCILIATION_ACTIONS` constant
  enumerating the values in § 7.2 so the reconciliation helpers can
  import a single source of truth. Today the column is `text` and the
  comment is a free-form jsdoc example; pinning the closed set in JS
  prevents typos in action strings.
- [claimEntitlement.js](../lib/fat/models/claimEntitlement.js): no
  shape change. The PaymentStatus / PaymentMethod typedefs already
  capture the stream coherence rule
  ([claimEntitlement.js:14-21](../lib/fat/models/claimEntitlement.js)).
- New helper file recommendation: `lib/fat/models/reconciliationHelpers.js`
  with pure functions `nextPaymentStatusFor(stream)`,
  `terminalStatusFor(stream)`, `isTerminal(status, stream)`, and
  `statusEligibleLinks(links)`. Pure JS, no Supabase dependency —
  parallel to `entitlementHelpers.js`. Land when Phase 3 step 5
  begins.

### 10.3 Service-layer contracts (recap from § 9)

The Phase 3 reconciliation surface MUST implement, in a single module
(or coordinated module set), the helpers § 9.1 – § 9.10. Each helper:

- Runs in a single Supabase transaction (or equivalent atomicity
  primitive).
- Reads the entitlement under RLS — the user-facing path never bypasses
  owner-only enforcement.
- Validates the transition is legal under the current `payment_method`
  before any write.
- Appends exactly the audit row(s) listed in § 7.2 — no more, no less.
- Returns a structured result the caller can render without an extra
  read round-trip.

The current prototype helpers in
[lib/reconciliation/reconciliationUtils.js](../lib/reconciliation/reconciliationUtils.js)
(`deriveGroupPaymentStatus`, `calcNormalizedSummary`,
`buildPettyCashReconciliationCSV`) conflate the three layers and CANNOT
be patched into this contract. They must be rewritten.

### 10.4 Out-of-scope service work (named so Phase 3 PR review can confirm)

- **Payslip ingestion subsystem.** OCR / PDF parsing of payslip
  uploads into `payment_records` rows. The *consumer contract* (the
  row shape and source enum values it must produce) is fixed by § 4.
  The ingestion mechanics are separate.
- **`payslip_imports` staging table.** Out of scope for this contract;
  forward-compatible — see § 4.5.
- **Canonical petty-cash export format.** Column shape is a separate
  canonical TODO. The *roundtrip path* (export confirmed → write
  `payment_records` row with `source = 'petty_cash_export'`) is in
  scope; the export columns themselves are not.
- **Tolerance / threshold rule.** Specified at § 5.5 as a parameter
  the recomputer accepts. The numeric value is a Phase 3 step 5
  decision; this contract does NOT pre-set it.
- **Overdue-detection heuristic.** UI-layer; out of scope.
- **Sharing-layer reconciliation.** The contract works owner-only; a
  shared-copy recipient reconciles the copy's entitlements against
  their own payments. Phase 3 step 8.

---

## 11. Open Blockers Carried by This Spec

Restated explicitly so Phase 3 step 5 PR authors can scan one list.
Source column points to the canonical TODO that owns the resolution.

| # | Blocker                                                                       | Affects                                          | Canonical source                                                            |
|---|-------------------------------------------------------------------------------|---------------------------------------------------|------------------------------------------------------------------------------|
| 1 | `claim_entitlements.payment_status` — split per stream or single enum?        | Reconciliation surface, recomputer guard         | `DATABASE_ARCHITECTURE_v1.0.md § TODO`                                       |
| 2 | M&D auto-child payment routing default                                        | Engine + reconciliation routing posture           | `PAYMENT_RECONCILIATION_v1.0.md § Payment Method Routing`                    |
| 3 | DM / SM auto-child payment routing defaults                                   | Engine + reconciliation routing posture           | `PAYMENT_RECONCILIATION_v1.0.md § Payment Method Routing`                    |
| 4 | Tolerance / threshold for `paid` / `claimed` determination                    | Status recomputer (§ 5.5, § 9.6)                  | New canonical TODO — surface in next `PAYMENT_RECONCILIATION_v1.0.md` revision |
| 5 | Matcher confidence threshold for auto-creating `auto_match` vs manual review  | Matcher (out of scope here)                       | `PAYMENT_RECONCILIATION_v1.0.md § TODO`                                      |
| 6 | `payslip_imports` raw-ingest staging table                                    | Payslip ingestion subsystem                       | `PAYMENT_RECONCILIATION_v1.0.md § TODO`                                      |
| 7 | Petty-cash export format (column shape)                                       | Petty-cash exporter                               | `PAYMENT_RECONCILIATION_v1.0.md § TODO`                                      |
| 8 | Overdue-detection heuristic                                                   | Overdue surface (UI)                              | `PAYMENT_RECONCILIATION_v1.0.md § TODO`                                      |
| 9 | RLS read scope for `reconciliation_audit` once sharing ships                  | Audit history view in shared-copy context         | `DATABASE_ARCHITECTURE_v1.0.md § TODO`, lifecycle § 6.4                      |
| 10 | RLS policy spec doc                                                           | Every reconciliation surface                     | `DATABASE_ARCHITECTURE_v1.0.md § TODO`                                       |

This contract is implementable today for **payslip-only Standby & M&D
reconciliation** end-to-end with manual entry + manual matching. Each
blocker above gates one specific extension — none gate the spec
itself.

---

## 12. Invariants the Phase 3 Reconciliation Implementation MUST Satisfy

Stated explicitly so the Phase 3 test bench can assert them. Companion
to `ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 7` and
[CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md § 11](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md).

1. **Snapshot immutability.** No reconciliation helper mutates
   `generated_amount`, `generated_hours`, `rule_id`, `rule_version`,
   `rule_explanation`, `formula_explanation`, `rate_id`,
   `rate_version_id`, `rate_snapshot`, `generated_at` on
   `claim_entitlements`. No reconciliation helper mutates the
   listed immutable columns on `operational_claims`.
2. **Override-isolation.** No reconciliation helper writes
   `edited_amount`, `edited_hours`, `edited_note`, or
   `manual_override`. Those are the override subsystem's surface and
   are mutated only by claim-edit helpers.
3. **Stream coherence at every write.** § 2.3 holds at all times —
   `payment_status` values are valid only for their stream;
   `payment_method = NULL` ⇒ `payment_status = NULL`.
4. **Stream coherence at link creation.** § 5.6 invariant 2 —
   `entitlement.payment_method == payment_record.stream` for every
   `link_payment` action.
5. **Atomic transitions.** § 7.4 — every payment-state mutation is
   accompanied by exactly one `reconciliation_audit` row in the same
   transaction. No row-mutation-without-audit, no
   audit-row-without-mutation (except `note_discrepancy`).
6. **Routing is deliberate.** § 3.5 — `payment_method` goes from
   `NULL` to non-NULL only via an explicit operator action. No
   helper infers routing from match evidence.
7. **No silent regress.** § 5.5 — a terminal entitlement transitions
   back to its initial state only via explicit operator action
   (`regress_status`, `unlink_payment`, override that re-raises
   payable above the link total triggering recompute) or via
   `retractPayment` cascade. The matcher does NOT regress silently.
8. **Audit log is append-only.** § 7.5 — no UPDATE or DELETE against
   `fat.reconciliation_audit` from reconciliation services.
9. **Owner coherence.** § 5.6 invariant 1 — the user-facing surfaces
   only create links where
   `entitlement.owner_id == payment_record.owner_id == auth.uid()`.
   Cross-owner links are a sharing-layer concern and are forbidden
   today.
10. **Payment record immutability.** § 4.3 — once written, a
    `payment_records` row's columns are never updated. Retraction is
    hard-delete with cascade and a corresponding audit row per
    formerly-linked entitlement.
11. **Allocation sum guard.** § 5.4 —
    `SUM(allocated_amount per record) ≤ gross_amount`. App-layer
    enforced.

---

## 13. Cross-References

- [REBUILD_PLAN_v1.0.md](REBUILD_PLAN_v1.0.md) — phased plan + change control
- [REBUILD_AUDIT_v1.0.md](REBUILD_AUDIT_v1.0.md) — full gap audit + sequencing
- [SCHEMA_READINESS_v1.0.md](SCHEMA_READINESS_v1.0.md) — Phase 1 verification gate
- [ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md](ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md) — Phase 3 engine boundary spec
- [CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md) — Phase 3 lifecycle/state-machine contract
- [supabase/canonical/01_canonical_foundation.sql](../supabase/canonical/01_canonical_foundation.sql) — Phase 1 schema
- [lib/fat/models/](../lib/fat/models) — Phase 2 typed models
- Governance canonical source set:
  `C:\Users\Admin\Apps\governance-system\chatgpt-project-sources\fire-allowance-tracker\`
