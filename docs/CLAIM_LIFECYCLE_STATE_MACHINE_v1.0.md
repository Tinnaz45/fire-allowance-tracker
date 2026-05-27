# Fire Allowance Tracker — Claim Lifecycle & State-Machine Contract

Version: v1.0
Status: Draft — specification for Phase 3 service migration
Last Updated: 2026-05-26
Branch: `dev`

Companion to:

- [REBUILD_PLAN_v1.0.md](REBUILD_PLAN_v1.0.md)
- [REBUILD_AUDIT_v1.0.md](REBUILD_AUDIT_v1.0.md)
- [SCHEMA_READINESS_v1.0.md](SCHEMA_READINESS_v1.0.md)
- [ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md](ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md)
- Governance canonical source set:
  `C:\Users\Admin\Apps\governance-system\chatgpt-project-sources\fire-allowance-tracker\`
  — `ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md`,
  `DATABASE_ARCHITECTURE_v1.0.md`, `CLAIM_TYPES_v1.0.md`,
  `ENTITLEMENT_RULES_v1.0.md`, `PAYMENT_RECONCILIATION_v1.0.md`.

---

## Purpose

Specify the **lifecycle contract** for every row in the canonical claim
stack, so that Phase 3 services can be written without re-deriving the
state model from scratch:

- `fat.operational_claims` (claim-level lifecycle)
- `fat.claim_entitlements` (per-entitlement payment lifecycle, per stream)
- `fat.payment_records` (observed real-world payment lines)
- `fat.entitlement_payment_links` (the N:M evidence layer)
- `fat.reconciliation_audit` (append-only history of state changes)
- Manual override state on `claim_entitlements.edited_*` / `manual_override`
- Delete / archive / void behaviour at every layer

It is a **specification only**:

- It does NOT implement any state-machine code.
- It does NOT migrate any service or UI code.
- It does NOT pre-decide unresolved business rules (void state, soft vs
  hard delete, FK enforcement on `parent_claim_id`, etc.) — every open
  TODO from the canonical docs and
  [SCHEMA_READINESS_v1.0.md § Deferred Blockers](SCHEMA_READINESS_v1.0.md)
  remains a TODO here, surfaced explicitly so Phase 3 PRs land without
  ambiguity.

Its job is to make the lifecycle contract explicit enough that the Phase
3 claim writer, reconciliation surface, and audit hooks can be built
against a single source of truth.

---

## Non-Goals

- Resolving any open canonical TODO. Recommended defaults are marked
  with **Recommendation:** and clearly distinguished from canonical
  decisions.
- Specifying Phase 3 service file layout.
- Specifying UI behaviour beyond the user-visible state-machine surface
  (the labels, allowed transitions, and audit entries the UI needs to
  render or trigger).
- Specifying payslip ingestion mechanics (the parsing / OCR / matcher
  subsystem). Only the entitlement-side terminal contract is in scope.
- Specifying RLS policy text. RLS implications of each transition are
  noted; the policy spec itself lives in a future document
  (`DATABASE_ARCHITECTURE_v1.0.md § TODO`).

---

## 1. Layered Lifecycle Recap

The canonical model has three independent lifecycles, one per layer.
They MUST NOT be conflated. See
`ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md § Core Architectural Principle` and
`PAYMENT_RECONCILIATION_v1.0.md § Status Lifecycle`.

```
┌──────────────────────┐
│ Operational Claim    │  status: draft → submitted → archived
│ (one per event)      │  (open TODO: void)
└──────────┬───────────┘
           │ 1:N
           ▼
┌──────────────────────┐
│ Generated Entitlement│  payment_method: null → payslip | petty_cash
│ (one per payable     │  payment_status (payslip):
│  outcome)            │    null → pending → paid    (+ regress)
│                      │  payment_status (petty_cash):
│                      │    null → outstanding → claimed (+ regress)
└──────────┬───────────┘
           │ N:M via entitlement_payment_links
           ▼
┌──────────────────────┐
│ Payment Record       │  append-on-observation, retraction discouraged
│ (one per real-world  │  (open TODO: payslip_imports raw-ingest table)
│  pay line / form)    │
└──────────────────────┘

(orthogonal) reconciliation_audit ← append-only on every
                                    payment-state change
                                    (entitlement layer only)
```

Editability invariant: snapshot columns
(`generated_amount`, `generated_hours`, `rule_id`, `rule_version`,
`rule_explanation`, `formula_explanation`, `rate_id`, `rate_version_id`,
`rate_snapshot`, `generated_at` on the entitlement;
`station_id_snapshot`, `station_name_snapshot`,
`source_calculation_mode`, `generated_at`, `parent_claim_id`,
`copy_source_owner_id` on the claim) are write-once and never touched
by any lifecycle transition below. See
`DATABASE_ARCHITECTURE_v1.0.md § 9. Historical Static Accounting Records`.

---

## 2. Operational Claim Lifecycle (`fat.operational_claims.status`)

Canonical enum
([01_canonical_foundation.sql:126](../supabase/canonical/01_canonical_foundation.sql)):

```
status ∈ { 'draft', 'submitted', 'archived' }   -- default 'draft'
```

### State semantics

| State        | Meaning                                                                                       | Visible in UI by default? |
|--------------|-----------------------------------------------------------------------------------------------|---------------------------|
| `draft`      | Operator is still composing the claim; entitlements may or may not yet be generated.          | Yes (in "new claim" surfaces) |
| `submitted`  | Operator has confirmed the claim. Entitlements have been generated. Payment lifecycle on the entitlements is live. | Yes (in dashboard / reconciliation) |
| `archived`   | Operator has marked the claim as no longer requiring active reconciliation work (typically all entitlements reconciled, or claim withdrawn after submission). | No by default — surfaced via "show archived" toggle |

### Allowed transitions

```
                     (operator confirm)
draft  ──────────────────────────────────▶  submitted
  │                                            │
  │                                            │ (operator archive)
  │                                            ▼
  │                                        archived
  │                                            │
  │  (operator un-archive)                     │
  └────────────────◀───────────────────────────┘
         submitted ◀── archived  (allowed)

                     (operator discard during composition)
draft  ──────────────▶ (hard delete — see § 7 Delete / Archive / Void)
```

- `draft → submitted` is one-shot at claim-write time when the operator
  hits "Save". The claim writer service performs the transition atomically
  with the parent INSERT, child detail INSERT, and N entitlement INSERTs
  (see `ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 2. Engine Boundary`).
- `submitted → archived` and `archived → submitted` are operator-driven
  and reversible. They do NOT cascade to entitlement payment status —
  payment lifecycle is independent.
- `draft → archived` is not allowed; a draft is either submitted or
  discarded.
- **No retrograde to `draft`** once a claim is submitted. The engine
  output is immutable; the only way to "edit" a submitted claim is to
  manually override entitlements (§ 6), correct `notes`, or — if the
  business rule eventually allows it — void the claim and create a new
  one. See § 7.

### Editable vs immutable fields per state

| Field                       | `draft`    | `submitted` | `archived` |
|-----------------------------|------------|-------------|------------|
| `claim_type`                | immutable* | immutable   | immutable  |
| `claim_date`                | editable   | immutable   | immutable  |
| `station_id_snapshot`       | editable** | immutable   | immutable  |
| `station_name_snapshot`     | editable** | immutable   | immutable  |
| `source_calculation_mode`   | editable   | immutable   | immutable  |
| `notes`                     | editable   | editable    | editable   |
| `parent_claim_id`           | immutable  | immutable   | immutable  |
| `copy_source_owner_id`      | immutable  | immutable   | immutable  |
| `generated_at`              | immutable  | immutable   | immutable  |
| `status`                    | transition only | transition only | transition only |

\* `claim_type` is set at INSERT and never changes. To "change the type"
   the operator must discard the draft and start a new claim.
\** Snapshot fields are only editable during `draft` because the engine
   hasn't yet read them. Once entitlements are generated against the
   snapshot, the snapshot is frozen.

Detail-row editability follows the same rule: editable while the
operator is still composing the parent (`draft`); frozen once
`submitted`. The detail row's `*_at` / station / distance / matrix
fields are the engine's inputs and re-reading them after submission
would silently invalidate generated entitlements.

### Side-effects per transition

| Transition              | Required side-effects                                                                                                       |
|-------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `(insert) → draft`      | Insert `operational_claims` row (`status='draft'`) + detail row. No entitlements yet. No audit row.                          |
| `draft → submitted`     | Engine runs (per `ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md`); claim writer inserts N `claim_entitlements` rows. Atomic with the status flip. No audit row (entitlement creation is captured by `claim_entitlements.generated_at` itself; the audit log is reconciliation-scoped). |
| `submitted → archived`  | Touch `updated_at`. No entitlement mutation. No audit row.                                                                   |
| `archived → submitted`  | Touch `updated_at`. No entitlement mutation. No audit row.                                                                   |
| `(any) → (delete)`      | See § 7. Either hard-delete (cascades through entitlements) or soft-delete (open TODO).                                      |

### Open blocker — `void` state

`DATABASE_ARCHITECTURE_v1.0.md § TODO` and
[REBUILD_AUDIT_v1.0.md § Open Architecture Questions item 1](REBUILD_AUDIT_v1.0.md)
ask whether `operational_claims.status` needs a `void` state distinct
from `archived`.

**Recommendation (NOT canonical):** treat `void` as a future addition,
not a blocker for Phase 3. Until then:

- Use `archived` for *administratively-closed-but-historically-valid*
  claims.
- Use hard-delete (during `draft`) or the future `void` state for
  *should-never-have-existed* claims.
- Do NOT overload `archived` with both meanings — the audit trail and
  reconciliation summaries depend on this distinction.

The canonical decision must land on
`DATABASE_ARCHITECTURE_v1.0.md` before the claim writer ships a void
action. Phase 3 step 4 (claim writer UX) is the gating step.

---

## 3. Entitlement Payment Lifecycle
(`fat.claim_entitlements.payment_method`, `payment_status`)

Two **stream-scoped** state machines, one per `payment_method`. Source:
`PAYMENT_RECONCILIATION_v1.0.md § Status Lifecycle`,
`DATABASE_ARCHITECTURE_v1.0.md § 8. Status Enums`.

### 3.1 Stream identifier — `payment_method`

```
payment_method ∈ { 'payslip', 'petty_cash', NULL }
```

- `NULL` means the routing has not yet been decided. Some claim types
  (Standby; M&D per the recommended default in
  `ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 5.4`) set this at creation;
  Recall and Retain children defer it
  ([project_standby_entitlement_split](../.claude/memory/project_standby_entitlement_split.md),
  `PAYMENT_RECONCILIATION_v1.0.md § Payment Method Routing`).
- `payment_method` is **set-once at routing decision**. Re-routing
  (e.g. an operator decides a petty-cash item will actually be a
  payslip line) is a deliberate user action: it resets
  `payment_status` to the new stream's initial value and writes a
  `route_change` reconciliation audit row. Re-routing is rare and is
  the only legitimate path from a stream-scoped status back to the
  opposite stream.
- Open TODO (`DATABASE_ARCHITECTURE_v1.0.md § TODO`): whether to split
  `payment_status` into two columns per stream rather than a single
  enum. Phase 3 step 5 (reconciliation surface) is the gating step;
  resolving the TODO must land the `CHECK` constraint described in
  `DATABASE_ARCHITECTURE_v1.0.md § 8`. Until resolved, `payment_status`
  remains a `text` column with no DB-side CHECK and app-layer
  enforcement
  ([01_canonical_foundation.sql:251](../supabase/canonical/01_canonical_foundation.sql)).

### 3.2 Payslip stream state machine

```
          (engine sets at creation OR operator routes later)
NULL ──────────────────────────────────────────────────────▶ pending
                                                              │
                              (matched / manual mark_paid)    │
                                  ┌───────────────────────────┘
                                  ▼
                                paid
                                  │
                              (regress_status — explicit user action)
                                  └───────────────────────────▶ pending
```

| State          | Meaning                                                                                  |
|----------------|------------------------------------------------------------------------------------------|
| `null`         | `payment_method` is also `null`. Routing not yet decided.                                |
| `pending`      | Routed to payslip. Expected to appear on a future payslip line. Not yet matched.         |
| `paid`         | Matched to one or more `payment_records` (stream='payslip') with allocations covering the effective payable amount, OR manually marked paid by the operator. |

Transitions:

- `pending → paid`: triggered by `link_payment` (auto-matcher) or
  `mark_paid` (manual). MUST append a `reconciliation_audit` row
  (§ 5).
- `paid → pending`: regression, allowed but discouraged. Triggered by
  `regress_status` (manual). MUST append an audit row. The original
  `entitlement_payment_links` rows are NOT auto-deleted — the operator
  decides whether to remove the link rows alongside (recommended) or
  keep them with a `discrepancy_note` link_kind.
- `pending` and `paid` are stream-scoped. Setting `payment_status =
  'outstanding'` on a payslip entitlement is invalid (app-layer guard;
  DB-side guard pending the TODO above).

### 3.3 Petty Cash stream state machine

```
NULL ──────────────────────────────────────────────────────▶ outstanding
                                                              │
                            (manual / export submitted)       │
                                  ┌───────────────────────────┘
                                  ▼
                              claimed
                                  │
                              (regress_status)
                                  └───────────────────────────▶ outstanding
```

| State          | Meaning                                                                                  |
|----------------|------------------------------------------------------------------------------------------|
| `null`         | `payment_method` is also `null`. Routing not yet decided.                                |
| `outstanding`  | Routed to petty cash. Not yet exported / submitted.                                      |
| `claimed`      | Exported via the petty-cash CSV / form (or manually marked claimed by the operator).     |

Transitions:

- `outstanding → claimed`: triggered by `mark_claimed` (manual) or
  `export_submitted` (when the operator confirms a petty-cash export
  has been physically submitted). MUST append an audit row.
- `claimed → outstanding`: regression. MUST append an audit row. Same
  link-row policy as the payslip regress case.

### 3.4 Initial-state assignment

When the engine sets `payment_method` at generation time (per
`ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 5.3 – 5.4`), it MUST also set
the stream's initial state:

| Engine-set `payment_method` | Engine-set `payment_status` |
|-----------------------------|------------------------------|
| `payslip`                   | `pending`                    |
| `petty_cash`                | `outstanding`                |
| `null` (routing deferred)   | `null`                       |

The engine NEVER emits a terminal state (`paid` / `claimed`) — those
are reconciliation outcomes, never generation outcomes. Mirrors
`ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 7 Invariant 5`.

### 3.5 Operator-set `payment_method` (deferred routing)

For Recall / Retain children (and any MD/DM/SM child whose routing TODO
remains open), `payment_method` is `null` at creation. The
reconciliation surface gives the operator an explicit "Route to
payslip / petty cash" action. That action:

1. Sets `payment_method` to the chosen stream.
2. Sets `payment_status` to the stream's initial state (`pending` /
   `outstanding`).
3. Appends a `set_payment_method` reconciliation audit row with
   `prior_status = null`, `new_status = pending|outstanding`,
   `reason = 'routed to <stream>'`.

This is the **only** path from `payment_method = null` to non-null.
Routing is never inferred automatically from a payment record match —
if a payment_records line lands against an unrouted entitlement, the
matcher surfaces a "needs routing" discrepancy and waits for the
operator.

---

## 4. `payment_records` Lifecycle

Source: `DATABASE_ARCHITECTURE_v1.0.md § 7. Payment and Reconciliation`,
`PAYMENT_RECONCILIATION_v1.0.md § Discrepancy Handling`.

```
(insert on observation)
       │
       ▼
   payment_record  (immutable in normal use)
       │
       ▼
(linked via entitlement_payment_links to N entitlements)
       │
       ▼
(retraction = hard delete — see below)
```

### 4.1 Creation

A `payment_records` row represents an observed real-world payment line:

- A payslip line (gross amount + reference), OR
- A petty-cash submission line (gross amount + form reference).

Source paths (`PaymentRecord.source` enum):

- `manual`           — operator typed it in.
- `payslip_screenshot` — OCR ingest result.
- `payslip_pdf`        — structured-PDF ingest result.
- `petty_cash_export`  — round-tripped from the petty-cash exporter.

`raw_payload` stores the ingest snapshot (OCR text, parsed PDF row,
export row). For `manual` source it MAY be null. Once written,
`raw_payload` is immutable — it's the audit copy of the observation,
not an editable field.

### 4.2 Immutability

`payment_records` rows are append-on-observation. The reconciliation
surface MUST NOT update any column on an existing row except in two
narrow cases:

1. **Tagging only.** A future iteration may add operator tags
   (e.g. "verified", "disputed"). These belong on a sibling table or a
   dedicated column added later — they MUST NOT shadow `gross_amount`
   / `reference` / `record_date` / `raw_payload`.
2. **Retraction.** If a payment record was inserted in error (e.g. OCR
   misread, duplicate ingest), it is hard-deleted. Cascading delete on
   `entitlement_payment_links` removes all link rows automatically
   ([01_canonical_foundation.sql:344](../supabase/canonical/01_canonical_foundation.sql)).
   Any entitlement whose `payment_status` had moved to `paid`/`claimed`
   because of links to the retracted record MUST be reviewed by the
   operator; the matcher does NOT auto-regress entitlements on payment
   retraction (because partial coverage from other linked records may
   still keep them paid).

### 4.3 Open blocker — `payslip_imports` raw-ingest staging

`PAYMENT_RECONCILIATION_v1.0.md § Payslip Verification (Future)` and
`DATABASE_ARCHITECTURE_v1.0.md § TODO` flag a separate raw-ingest
staging table (`payslip_imports`) for OCR / PDF runs that produce
multiple lines from one upload. That table's lifecycle (drafted →
parsed → confirmed) is **out of scope** here. Until it ships,
`payment_records` is the entry point and `source` distinguishes ingest
provenance.

### 4.4 RLS implications

`payment_records.owner_id` scopes every row owner-only. The matcher
service running as `service_role` may insert rows on behalf of any
user (e.g. during a batch payslip ingest) but the user-facing
reconciliation surface only sees own rows. See
[01_canonical_foundation.sql:472](../supabase/canonical/01_canonical_foundation.sql).

---

## 5. `entitlement_payment_links` Behaviour

Source: `DATABASE_ARCHITECTURE_v1.0.md § 7. Payment and Reconciliation`,
`PAYMENT_RECONCILIATION_v1.0.md § Reconciliation Workflows`.

```
ClaimEntitlement ◀── N:M ──▶ PaymentRecord
                  via entitlement_payment_links
                  + allocated_amount + link_kind
```

### 5.1 link_kind semantics

| `link_kind`         | Created by                                | Meaning                                                                                                  |
|---------------------|-------------------------------------------|----------------------------------------------------------------------------------------------------------|
| `auto_match`        | Matcher service (automated)               | The matcher's confidence threshold was met. `note` MAY hold a confidence score or rule trace.            |
| `manual`            | Operator action in the reconciliation UI  | The operator linked the entitlement to a payment record explicitly. `note` is the operator's reason.     |
| `discrepancy_note`  | Operator                                   | The link is *informational*, not a coverage claim. Used to record "this payslip line is sort-of related but should NOT count toward `paid`." Allocated amount is 0 or a partial value the operator records for transparency. |

`auto_match` and `manual` links contribute toward the `paid` /
`claimed` determination; `discrepancy_note` links do not. The
reconciliation status computer:

```
status_eligible_links = links where link_kind IN ('auto_match','manual')
sum_allocated         = SUM(allocated_amount for status_eligible_links)
effective_payable     = COALESCE(edited_amount, generated_amount)        -- dollars-first
                      OR
                        COALESCE(edited_hours,  generated_hours)         -- hours-first
```

`paid` / `claimed` is the terminal state when:

- For dollars-first entitlements: `sum_allocated >= effective_payable`
  (within a configurable tolerance — TODO).
- For hours-first entitlements: at least one eligible link exists (the
  payslip line is the dollar settlement event; the link is the
  evidence). Hours-first rows MAY have zero `allocated_amount` per
  link because the entitlement carries no dollar quantity — the
  matcher is responsible for picking the line and the operator
  confirms.

The exact tolerance / threshold rule is a Phase 3 reconciliation-surface
decision and is intentionally NOT pre-decided here.

### 5.2 Lifecycle

Links are insert/delete only — never updated in place. To change an
allocation, delete the link and insert a new one (each row is small;
churn is acceptable; deletion still leaves an audit trail because the
status transition that prompted the change is recorded in
`reconciliation_audit`).

```
(matcher / operator) ──insert──▶ entitlement_payment_links
                                       │
                                       ▼
                            (delete on retraction / replacement)
```

Cascade rules (already in the schema):

- Delete a `claim_entitlements` row → cascade delete its links
  ([01_canonical_foundation.sql:343](../supabase/canonical/01_canonical_foundation.sql)).
- Delete a `payment_records` row → cascade delete its links
  ([01_canonical_foundation.sql:344](../supabase/canonical/01_canonical_foundation.sql)).
- Delete an `operational_claims` row → cascade delete its entitlements
  → cascade delete the entitlements' links.

### 5.3 Invariants

1. `entitlement.owner_id == payment_record.owner_id` for any link the
   user-facing matcher creates. Cross-owner links are reserved for the
   future sharing layer and must be explicit.
2. `allocated_amount >= 0`. (No DB CHECK today; add as a follow-up
   migration once the tolerance rule lands.)
3. A `paid`/`claimed` entitlement that has all its eligible links
   deleted MUST have its `payment_status` reviewed by the operator (a
   matcher MUST NOT silently regress — see § 4.2).

---

## 6. `reconciliation_audit` Append-Only Semantics

Source: `DATABASE_ARCHITECTURE_v1.0.md § 7. Payment and Reconciliation`,
`PAYMENT_RECONCILIATION_v1.0.md § Audit Trail Requirements`,
[lib/fat/models/reconciliationAudit.js](../lib/fat/models/reconciliationAudit.js).

### 6.1 When to write a row

Every transition listed below MUST append exactly one
`reconciliation_audit` row, in the same transaction as the underlying
mutation.

| Trigger                                          | `action`                  | `prior_status` | `new_status`     |
|--------------------------------------------------|---------------------------|----------------|------------------|
| Operator routes an unrouted entitlement (§ 3.5)  | `set_payment_method`      | `null`         | `pending`/`outstanding` |
| Operator re-routes between streams (§ 3.1)       | `route_change`            | (prior status) | (new initial status of new stream) |
| Auto-matcher links a payment_records line        | `link_payment`            | (prior status) | (new status — may equal prior if threshold not yet met) |
| Operator links a payment_records line manually   | `link_payment`            | (prior status) | (new status)     |
| Operator marks payslip entitlement paid manually | `mark_paid`               | `pending`      | `paid`           |
| Operator marks petty-cash entitlement claimed    | `mark_claimed`            | `outstanding`  | `claimed`        |
| Operator regresses a terminal state              | `regress_status`          | `paid`/`claimed` | `pending`/`outstanding` |
| Operator deletes a link (force regress)          | `unlink_payment`          | (prior status) | (recomputed status) |
| Operator adds a discrepancy note                 | `note_discrepancy`        | (unchanged)    | (unchanged)      |

`automated = true` for matcher-originated actions, `false` for operator
actions. `reason` carries the operator's free-text note (or, for
automated actions, the matcher's rule trace).

### 6.2 What MUST NOT trigger an audit row

- Engine-side INSERT of a new entitlement. The audit log is reconciliation-scoped;
  initial state is captured by `claim_entitlements.generated_at` itself.
- Manual edits to `edited_amount` / `edited_hours` / `edited_note` /
  `manual_override`. Manual-override lifecycle is captured in § 6
  below; it's a value-edit log, not a payment-state log. (Open TODO:
  whether to extend `reconciliation_audit` to cover value edits, or
  introduce a separate `entitlement_edit_audit` table. Recommended:
  separate table, so the two histories don't crowd each other.)
- `operational_claims.status` transitions (draft → submitted →
  archived). Same rationale — claim-level lifecycle is separate from
  entitlement-payment lifecycle. If a claim-level audit log is
  eventually needed, it should be a separate table.
- `payment_records` insertion (the record's own `created_at` and
  `source` columns are the audit). Retraction of a payment_records
  row, however, MUST append one `unlink_payment` audit row PER
  formerly-linked entitlement so the regression is visible in each
  entitlement's per-row history view.

### 6.3 Append-only enforcement

`reconciliation_audit` MUST NOT be updated or deleted in normal use.
Today this is an app-layer invariant; a future trigger or RLS
update-deny policy may enforce it once the policy spec doc lands
(`DATABASE_ARCHITECTURE_v1.0.md § TODO`).

### 6.4 Read scope

Today: actor-scoped (the user who performed the action)
([01_canonical_foundation.sql:480](../supabase/canonical/01_canonical_foundation.sql)).
Open TODO (`SCHEMA_READINESS_v1.0.md § Deferred Blockers item 7`):
whether the entitlement *owner* should also be able to read audit rows
where `actor_id != owner_id`. Becomes relevant once the sharing layer
ships. Phase 3 step 5 does NOT need this resolved; the
reconciliation surface today is single-owner.

---

## 7. Manual Override Lifecycle

Source: `ENTITLEMENT_RULES_v1.0.md § Manual Override Rules`,
`DATABASE_ARCHITECTURE_v1.0.md § 3. Generated Entitlements`,
[lib/fat/models/entitlementHelpers.js](../lib/fat/models/entitlementHelpers.js).

### 7.1 State

```
                  edited_amount = null
                  edited_hours  = null
                  edited_note   = null
                  manual_override = false
                  ───────────────────────
"unedited"  ──set_edit──▶  "edited"
                  ───────────────────────
                  edited_amount or edited_hours (or both) non-null
                  edited_note   = operator-supplied (may be null)
                  manual_override = true
                  ───────────────────────
"edited"    ──clear_edit──▶  "unedited"
```

### 7.2 Transitions

| Transition         | Operator action                                         | Fields changed                                                          |
|--------------------|---------------------------------------------------------|--------------------------------------------------------------------------|
| `set_edit`         | Operator types a new dollar or hour value, optionally with a note. | Set `edited_amount` / `edited_hours` to the new value; set `edited_note`; set `manual_override = true`. |
| `clear_edit`       | Operator reverts to the generated value.                | Null `edited_amount`, `edited_hours`, `edited_note`; set `manual_override = false`. |
| `update_note_only` | Operator changes the note without changing the amount.  | Update `edited_note`. `manual_override` unchanged.                      |

### 7.3 Invariants

1. `manual_override` MUST mirror
   `(edited_amount IS NOT NULL OR edited_hours IS NOT NULL)`. Maintained
   app-side today
   ([entitlementHelpers.js:isManualOverride](../lib/fat/models/entitlementHelpers.js));
   a trigger may be added later (`01_canonical_foundation.sql` comment).
2. Snapshot fields (`generated_amount`, `generated_hours`, `rule_*`,
   `rate_*`, `rate_snapshot`, `generated_at`) MUST NOT be touched by
   any override transition. Mirrors
   `ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 7. Invariants`.
3. Override edits MUST NOT cause regeneration of sibling entitlements
   on the same claim (`ENTITLEMENT_RULES_v1.0.md § Manual Override
   Rules`). The engine is generation-only; once a claim is submitted
   the engine NEVER re-runs.
4. For dollars-first entitlements (`unit = 'dollars'`): only
   `edited_amount` is operator-editable. `edited_hours` MUST remain
   null.
5. For hours-first entitlements (`unit = 'hours'`): only `edited_hours`
   is operator-editable. `edited_amount` MUST remain null.
6. Override edits MUST NOT change `payment_status`. If an entitlement's
   `edited_amount` rises above the linked allocation total, the
   downstream reconciliation status MAY revert to `pending` /
   `outstanding` on the next status recompute — but the edit itself
   never directly writes payment status. The recompute writes a
   `regress_status` reconciliation audit row.

### 7.4 Open question — value-edit audit log

The current schema records *that* an override exists (`manual_override`,
`edited_*`) but not the *history* of edits (e.g. "operator first set
edited_amount = 12.00, then changed it to 15.50"). The reconciliation
audit table is intentionally not the right home (§ 6.2).

**Recommendation (NOT canonical):** add a sibling `entitlement_edit_audit`
table once the override UI surfaces a "show edit history" view.
Defer until that surface is actually being built — premature now.

---

## 8. Delete / Archive / Void Behaviour

Source: `SCHEMA_READINESS_v1.0.md § Deferred Blockers items 1, 6`,
[REBUILD_AUDIT_v1.0.md § Open Architecture Questions items 1, 6](REBUILD_AUDIT_v1.0.md).

Three operations are in tension and **canonical does not pre-decide
between them**:

| Operation | Semantics                                                  | Visible in UI? | History preserved? |
|-----------|------------------------------------------------------------|----------------|--------------------|
| Delete    | Row is removed. Cascade to children.                       | No             | No                 |
| Archive   | Row remains, marked `archived`. Hidden from default views. | Toggle "show archived" | Yes                |
| Void      | (Future) Row remains, marked `void`. Reconciliation totals ignore it. | Maybe — operator-visible flag | Yes |

### 8.1 Current schema cascades (immutable)

```
operational_claims  ──on delete cascade──▶  *_details
                    ──on delete cascade──▶  claim_entitlements
                                              ──on delete cascade──▶
                                                entitlement_payment_links
                                              ──on delete cascade──▶
                                                reconciliation_audit
payment_records      ──on delete cascade──▶  entitlement_payment_links
```

See [01_canonical_foundation.sql](../supabase/canonical/01_canonical_foundation.sql).
These cascades make hard-delete safe at the SQL level — no orphan
rows. They do NOT decide *whether* hard-delete is the right product
behaviour.

### 8.2 Recommended posture per layer (NOT canonical)

| Layer                       | When                                          | Recommended action |
|-----------------------------|-----------------------------------------------|--------------------|
| `operational_claims` in `draft` | Operator discards an in-progress draft.       | **Hard delete.** No history loss because no entitlements exist yet. |
| `operational_claims` in `submitted` | Operator decides the claim should never have been filed. | **Future: void.** Until void lands, **archive + edited_note** on the entitlements. **Do NOT hard-delete** — `reconciliation_audit` rows hang off `claim_entitlements.id` via FK and cascade would erase the audit trail. |
| `operational_claims` in `archived` | Operator wants to remove an archived claim entirely. | **Discouraged.** The cascade will erase the entitlements' reconciliation history. Surfacing this action requires an explicit "I understand this destroys audit history" confirmation. Better: leave archived. |
| `claim_entitlements`        | An entitlement was generated in error.        | **Manual override to `0` with `edited_note`.** Do NOT delete individual entitlements — they're part of the engine's static record, and the engine NEVER re-emits. The override is the legitimate "this should not have generated" lever. |
| `payment_records`           | A payment record was ingested in error.       | **Hard delete.** Cascade removes links; operator reviews any entitlement formerly marked paid against the retracted record. See § 4.2. |
| `entitlement_payment_links` | A link was created in error.                  | **Hard delete.** Status recompute writes a `regress_status` audit row if the deletion drops the entitlement below threshold. |
| `reconciliation_audit`      | (any)                                         | **Never delete.** Append-only. See § 6.3.                          |

### 8.3 Open blocker — soft vs hard delete on `operational_claims`

`DATABASE_ARCHITECTURE_v1.0.md § TODO` asks whether
`operational_claims` deletion should be soft (e.g. add a
`deleted_at timestamptz` and switch the cascade to a tombstone model)
or hard (the current `on delete cascade` chain).

**Recommendation (NOT canonical):**

- Keep the **draft hard-delete** path. It's the simple, expected
  behaviour for discarding a draft.
- Defer the **submitted-state delete** path until either `void` lands
  or a soft-delete decision is made. Until then, the submitted-state
  UI MUST offer Archive only — no Delete button.

This is the safest posture and requires zero schema changes today. The
SQL cascade is forward-compatible with either resolution.

### 8.4 Open blocker — sharing layer cascade

If `parent_claim_id` becomes a real FK (canonical TODO #7), deleting
the source claim must NOT cascade to its copies. The schema today
does not enforce `parent_claim_id` as a FK
([REBUILD_AUDIT_v1.0.md § Open Architecture Questions item 7](REBUILD_AUDIT_v1.0.md)),
so the cascade question doesn't bite yet. When the sharing layer ships,
`parent_claim_id` either:

- stays informational (current state), or
- becomes a `references operational_claims(id) on delete set null` FK
  (the recommendation if it becomes a FK — keep copies independent).

Phase 3 step 8 (sharing layer) is the gating step.

---

## 9. Required Schema / Model / Service Changes Before Phase 3

This document is spec-only — no code changes here. The list below is
the prerequisite delta that Phase 3 service work depends on. Everything
listed in
[ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 6](ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md)
also applies; this section only adds **lifecycle-specific**
prerequisites.

### 9.1 Schema (additive, deferred to a new canonical migration file)

None mandatory beyond the entitlement-engine prerequisite (drop NOT
NULL on `generated_amount` — see
`ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 6.1`).

Recommended optional follow-ups, **not blocking** Phase 3 step ordering:

| Change                                                                                  | Why                                                                                          | Gating decision |
|-----------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|------------------|
| `check (allocated_amount >= 0)` on `fat.entitlement_payment_links`                      | Mirrors integrity posture on the matrices; today nothing prevents a negative allocation.     | Land alongside the tolerance rule (Phase 3 step 5). |
| `check (payment_status in (...)` constrained per `payment_method`                       | App-layer guarded today; DB-side guard once the stream-split TODO resolves.                  | Open canonical TODO #2. |
| `void` state in the `status` CHECK on `fat.operational_claims`                          | Required if the void decision lands.                                                          | Open canonical TODO #1. |
| `deleted_at timestamptz` on `fat.operational_claims` + filtered RLS / index             | Required if soft-delete wins. Hard-delete remains the current path until then.               | Open canonical TODO #6. |
| `entitlement_edit_audit` sibling table                                                  | Captures the manual-override edit history (§ 7.4).                                            | Defer until the override UI surfaces a history view. |

### 9.2 Model layer (`lib/fat/models/`)

- [claimEntitlement.js](../lib/fat/models/claimEntitlement.js): no
  shape changes. Once the `effectiveAmount` / `effectiveHours` helpers
  land (per
  `ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 4`), the existing
  `effectivePayable` helper becomes redundant — keep it until all call
  sites are migrated, then remove.
- [reconciliationAudit.js](../lib/fat/models/reconciliationAudit.js):
  consider extending the `action` jsdoc to enumerate the actions in
  § 6.1. Strictly optional — the column is `text`.
- A new helper `nextPaymentStatusFor(stream)` returning
  `pending|outstanding` would let the engine and the routing UI share
  one source of truth for "what's the initial state of stream X?".
  Trivial to add when Phase 3 step 5 begins.

### 9.3 Service-layer contracts the lifecycle implies

These are the new responsibilities Phase 3 services MUST implement
based on this lifecycle spec. None of them are implementable from the
current prototype `lib/claims/ClaimsContext.js` shape.

1. **Claim writer (Phase 3 step 4):** atomic insert of
   `operational_claims` (`status='submitted'`) + detail row + N
   entitlements. No audit rows on submission (per § 6.2). Cascading
   failure on any partial write.
2. **Reconciliation surface (Phase 3 step 5):** every payment-state
   mutation goes through a single helper that:
   - validates the transition is legal under the current `payment_method`,
   - performs the mutation,
   - inserts an `entitlement_payment_links` row if applicable,
   - inserts the matching `reconciliation_audit` row,
   in one transaction. No mutation path is allowed to skip the audit
   row.
3. **Routing action:** the only path from `payment_method = null` to
   non-null. Writes `set_payment_method` audit row. Phase 3 step 5.
4. **Re-routing action:** the only path from one stream to the other.
   Writes `route_change` audit row. Phase 3 step 5.
5. **Override action:** the only path that writes `edited_*` and
   `manual_override`. Writes nothing to `reconciliation_audit` (§ 6.2).
   Phase 3 step 5 (UI) builds on Phase 3 step 4 (writer).
6. **Status recomputer:** given an entitlement and its current link
   set, decide whether `payment_status` should transition. Single
   source of truth — both the matcher and the operator UI invoke it.
   Phase 3 step 5.
7. **Petty-cash exporter (Phase 3 step 5):** flips
   `outstanding → claimed` for the exported entitlements *only when
   the operator confirms the export was submitted*. The export render
   itself doesn't flip status (avoids "I previewed, didn't submit,
   status moved" surprises).

### 9.4 Out-of-scope service work (named so the Phase 3 PR review can confirm)

- Payslip ingestion (OCR / PDF). The matcher's *consumer* contract
  (entitlement_payment_links + reconciliation_audit) is specified
  here; the ingestion pipeline itself is a separate subsystem with its
  own data model (per `PAYMENT_RECONCILIATION_v1.0.md § Future
  Architecture Guidance`).
- Sharing-layer copy action. Schema is forward-compatible; the action
  itself is Phase 3 step 8.
- Tolerance / threshold rule for "paid / claimed" determination — see
  § 5.1. Will land alongside the reconciliation surface; gating only
  the *exact* status-recompute predicate, not the lifecycle shape.

---

## 10. Open Blockers Carried by This Spec

Restated explicitly so Phase 3 PR authors can scan one list. Source
column points to the canonical TODO that owns the resolution.

| # | Blocker                                                                       | Affects                          | Canonical source                                                            |
|---|-------------------------------------------------------------------------------|-----------------------------------|------------------------------------------------------------------------------|
| 1 | `operational_claims.status` — does it need a `void` state?                    | Claim writer UX (Phase 3 step 4) | `DATABASE_ARCHITECTURE_v1.0.md § TODO`, [REBUILD_AUDIT § OQ 1](REBUILD_AUDIT_v1.0.md) |
| 2 | `claim_entitlements.payment_status` — split per stream or single enum?        | Reconciliation surface (step 5)   | `DATABASE_ARCHITECTURE_v1.0.md § TODO`, OQ 2                                  |
| 3 | Soft-delete vs hard-delete for `operational_claims`; cascade through entitlements | Claim deletion UX             | OQ 6                                                                          |
| 4 | `parent_claim_id` / `copy_source_owner_id` — FK or informational?             | Sharing layer (step 8)            | OQ 7                                                                          |
| 5 | RLS policy spec doc                                                            | All reconciliation surfaces       | `DATABASE_ARCHITECTURE_v1.0.md § TODO`                                        |
| 6 | `payslip_imports` raw-ingest table shape                                       | Payslip ingestion subsystem       | `PAYMENT_RECONCILIATION_v1.0.md § TODO`                                       |
| 7 | Petty-cash export shape (materialised vs computed)                             | Petty-cash exporter (step 5)      | `PAYMENT_RECONCILIATION_v1.0.md § TODO`                                       |
| 8 | Tolerance / threshold for `paid`/`claimed` determination                       | Status recomputer (step 5)        | `PAYMENT_RECONCILIATION_v1.0.md` (new — surface in next canonical revision) |
| 9 | M&D auto-child payment routing default (`payslip` recommended in § 5.4 of engine contracts) | Engine generators (step 2) | `PAYMENT_RECONCILIATION_v1.0.md § Payment Method Routing`                    |
| 10 | Recall / Retain / Delayed Meal / Spoilt Meal entitlement sets                 | Engine generators (step 2)        | `ENTITLEMENT_RULES_v1.0.md § TODO`                                            |

This document is implementable today for **claim submission +
Standby/M&D payslip-only reconciliation** end-to-end. Each open blocker
above gates one specific Phase 3 surface; none gate this spec.

---

## 11. Invariants the Phase 3 Implementation MUST Satisfy

Stated explicitly so the test bench can assert them. Companion to
`ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 7`.

1. **Snapshot immutability.** No service mutates `generated_amount`,
   `generated_hours`, `rule_id`, `rule_version`, `rule_explanation`,
   `formula_explanation`, `rate_id`, `rate_version_id`,
   `rate_snapshot`, `generated_at` on an existing
   `claim_entitlements` row. Same rule for the listed
   `operational_claims` columns (§ 1).
2. **Stream coherence.** `payment_status` values are valid only for
   their stream:
   - `payment_method = 'payslip'` ⇒ `payment_status ∈ {null, 'pending', 'paid'}`
   - `payment_method = 'petty_cash'` ⇒ `payment_status ∈ {null, 'outstanding', 'claimed'}`
   - `payment_method IS NULL` ⇒ `payment_status IS NULL`
3. **Atomic transitions.** Every payment-state mutation appends
   exactly one `reconciliation_audit` row in the same transaction. No
   row-mutation-without-audit, no audit-row-without-mutation (except
   `note_discrepancy` which legitimately leaves status unchanged).
4. **Override isolation.** Setting / clearing `edited_amount` /
   `edited_hours` / `edited_note` / `manual_override` does NOT touch
   snapshot fields, payment-state fields, or sibling entitlements.
5. **Routing is a deliberate action.** `payment_method` goes from
   `null` to non-null only via the explicit routing action. Matchers
   that encounter unrouted entitlements surface a "needs routing"
   discrepancy rather than inferring routing from payslip evidence.
6. **No silent regress.** A `paid` / `claimed` entitlement transitions
   back to `pending` / `outstanding` only via explicit operator action
   (`regress_status`, `unlink_payment`, override that raises payable
   above linked allocations triggering a recompute). The matcher
   never silently regresses on its own.
7. **Cascade respects audit.** Hard-deleting an `operational_claims`
   row in `submitted` state destroys the entitlements' reconciliation
   history. The UI MUST gate this with an explicit destructive-action
   confirmation; the recommended path is Archive (or future Void).
8. **Detail-row freezing.** Once `operational_claims.status =
   'submitted'`, the matching `*_details` row is read-only at the
   service layer. The engine's inputs are the snapshot; re-editing
   them after submission would invalidate the generated entitlements.

---

## 12. Cross-References

- [REBUILD_PLAN_v1.0.md](REBUILD_PLAN_v1.0.md) — phased plan + change control
- [REBUILD_AUDIT_v1.0.md](REBUILD_AUDIT_v1.0.md) — full gap audit + sequencing
- [SCHEMA_READINESS_v1.0.md](SCHEMA_READINESS_v1.0.md) — Phase 1 verification gate
- [ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md](ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md) — Phase 3 engine boundary spec
- [RECONCILIATION_STATE_ARCHITECTURE_v1.0.md](RECONCILIATION_STATE_ARCHITECTURE_v1.0.md) — Phase 3 reconciliation-state contract (stream semantics, routing, link_kind taxonomy, discrepancy states, audit event enum, service contracts)
- [supabase/canonical/01_canonical_foundation.sql](../supabase/canonical/01_canonical_foundation.sql) — Phase 1 schema
- [lib/fat/models/](../lib/fat/models) — Phase 2 typed models
- Governance canonical source set:
  `C:\Users\Admin\Apps\governance-system\chatgpt-project-sources\fire-allowance-tracker\`
