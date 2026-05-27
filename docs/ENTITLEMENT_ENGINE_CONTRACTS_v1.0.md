# Fire Allowance Tracker — Entitlement Engine Contracts

Version: v1.0
Status: Draft — specification for Phase 3 service migration
Last Updated: 2026-05-26
Branch: `dev`

Companion to:

- [REBUILD_PLAN_v1.0.md](REBUILD_PLAN_v1.0.md)
- [REBUILD_AUDIT_v1.0.md](REBUILD_AUDIT_v1.0.md)
- [SCHEMA_READINESS_v1.0.md](SCHEMA_READINESS_v1.0.md)
- Governance canonical source set:
  `C:\Users\Admin\Apps\governance-system\chatgpt-project-sources\fire-allowance-tracker\`
  — `ENTITLEMENT_RULES_v1.0.md`, `DATABASE_ARCHITECTURE_v1.0.md`,
  `ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md`, `CLAIM_TYPES_v1.0.md`,
  `PAYMENT_RECONCILIATION_v1.0.md`.

---

## Purpose

Specify the **engine boundary** between operational-claim creation and
generated-entitlement persistence. This is the contract that Phase 3
service migration must satisfy when replacing
[lib/calculations/engine.js](../lib/calculations/engine.js) and the
per-claim-type code paths in
[lib/claims/ClaimsContext.js](../lib/claims/ClaimsContext.js).

It is a **specification only**:

- It does NOT implement the entitlement generators.
- It does NOT pre-decide unresolved triggers — every TODO in
  `ENTITLEMENT_RULES_v1.0.md` remains a TODO here.
- It does NOT invent dollar formulas for hours-first entitlements.
- It does NOT migrate any service or UI code.

Its job is to make the entitlement-layer contract explicit enough that
Phase 3 PRs land without architecture ambiguity.

---

## Non-Goals

- Resolving any open `ENTITLEMENT_RULES_v1.0.md` TODO (Recall triggers,
  Retain set, Delayed/Spoilt Meal sets, Relieving Allowance).
- Specifying the Phase 3 service file layout (one module vs many; how
  the Supabase client is threaded; etc.) — that is an implementation
  concern.
- Specifying UI behaviour. The contracts here are server-side only.
- Specifying reconciliation behaviour — reconciliation reads the
  entitlement snapshot and writes payment-state + audit rows. The
  engine never re-runs after `generated_at`.

---

## 1. Static-Snapshot Philosophy (recap)

Every contract below honours these invariants. They are not negotiable
within this spec; any future change requires a canonical-doc update
first.

1. **One generation per claim.** Entitlements are generated once, at
   the moment the operational claim is persisted. Subsequent rule or
   rate changes do NOT regenerate historical entitlements.
2. **Immutable snapshot fields.** `generated_amount`, `generated_hours`,
   `rule_id`, `rule_version`, `rule_explanation`, `formula_explanation`,
   `rate_id`, `rate_version_id`, `rate_snapshot`, `generated_at` are
   write-once.
3. **Manual edits never cascade.** Editing one entitlement's
   `edited_amount` / `edited_hours` / `edited_note` does NOT re-run the
   engine for siblings.
4. **Reconciliation never mutates snapshots.** Status / payment-link
   changes append to `reconciliation_audit` and touch only the
   payment-state columns.

Source: `ENTITLEMENT_RULES_v1.0.md § Guiding Principles`,
`DATABASE_ARCHITECTURE_v1.0.md § 9. Historical Static Accounting Records`.

---

## 2. Engine Boundary

```
                              ┌──────────────────────────┐
draft OperationalClaim ──────▶│                          │
draft *_details row ─────────▶│                          │
                              │   Entitlement Engine     │──▶ [EntitlementDraft]
RateLookup(claim_date)  ─────▶│                          │     (one row per
StationMatrixLookup(...) ────▶│                          │      generated entitlement)
ProfileSnapshot ─────────────▶│                          │
                              └──────────────────────────┘
```

### Inputs

| Input              | Source                                                              | Shape (typedef)                              |
|--------------------|---------------------------------------------------------------------|----------------------------------------------|
| `claim`            | Caller-built draft of the row about to be inserted into `fat.operational_claims` | [`OperationalClaim`](../lib/fat/models/operationalClaim.js) (sans `id` / `generated_at` / `created_at` / `updated_at`) |
| `details`          | Caller-built draft of the 1:1 detail row for `claim.claim_type`     | [`RecallDetails`](../lib/fat/models/claimDetails.js) / `RetainDetails` / `StandbyDetails` / `MusterDismissDetails` / `DelayedMealDetails` / `SpoiltMealDetails` |
| `rateLookup`       | Service-provided lookup against `fat.rates` + `fat.rate_versions`   | `(code: string, claimDate: string) => RateLookupResult` |
| `matrixLookup`     | Service-provided lookup against `fat.station_time_matrix` (and `_distance_matrix` for Recall override paths only) | `(fromStationId: number, toStationId: number, matrixVersion: string) => StationMatrixHit \| null` |
| `profileSnapshot`  | Subset of `fat.profiles` captured at claim creation time            | `{ id, rostered_station_id, rostered_station_name }` (bare name per `project_station_label_canonical_shape`) |

`claim.station_id_snapshot` and `claim.station_name_snapshot` MUST be
pre-populated by the caller from `profileSnapshot`. The engine does NOT
read live profile state.

`claim.source_calculation_mode` MUST be pre-set by the caller — it
records the operator's intent (`frv_matrix` / `google_maps` / `manual`)
and the engine reads it to decide whether to call `matrixLookup` /
`distanceLookup` / pass through a manual override.

### Outputs

Engine returns `EntitlementDraft[]` (zero or more rows). Each draft maps
1:1 to a row to be inserted into `fat.claim_entitlements` after the
parent claim insert succeeds. The caller (claim writer) is responsible
for the actual INSERT and for cascading failure on partial writes.

Engine **never** writes to the database. It is a pure function over its
inputs (lookups + claim/details). This makes it test-bench friendly and
keeps transaction control with the claim writer.

### Lookup contracts

```ts
// Rate lookup — picks the rate_versions row that applies to claim_date.
RateLookup(code, claimDate) → {
  rate:        Rate,           // catalogue row from fat.rates
  rateVersion: RateVersion,    // version row whose effective_from <= claimDate
                               // and no later effective_from exists for the same rate_id
  value:       number,         // RateVersion.value, surfaced for convenience
} | null                       // null = no version applies; engine must surface this
                               //        as a generator-side guard (do NOT emit a row)

// Matrix lookup — returns FRV Matrix hours for a (from, to, version) cell.
StationMatrixLookup(from, to, matrixVersion) → {
  hours: number,               // 0.25-hour increments, stored verbatim
  matrixVersion: string,
} | null                       // null = matrix has no cell; engine surfaces as guard
```

The `matrixVersion` argument is supplied by the caller. The pin source
(per-user `profiles` vs per-claim detail row) is an open canonical TODO
— this contract is forward-compatible with either resolution.

---

## 3. `EntitlementDraft` Output Shape

Every entitlement draft has the same shape regardless of parent claim
type. This mirrors the homogeneous-entitlement principle in
`DATABASE_ARCHITECTURE_v1.0.md § 3`.

```ts
type EntitlementDraft = {
  // Provenance (set by the caller post-engine, before INSERT):
  // - claim_id        — parent operational_claims.id (assigned by claim writer)
  // - owner_id        — denormalised from operational_claims.owner_id

  // Catalogue + unit:
  entitlement_type:    string,                 // see § Entitlement Catalogue
  unit:                'dollars' | 'hours' | 'km',

  // Canonical payable quantity — exactly ONE of the two is populated:
  generated_amount:    number | null,          // dollars-first → number; hours-first → null
  generated_hours:     number | null,          // hours-first  → number; dollars-first → null
  edited_amount:       null,                   // always null at generation; user-only field
  edited_hours:        null,                   // always null at generation; user-only field
  edited_note:         null,
  manual_override:     false,                  // always false at generation

  // Rule provenance (REQUIRED):
  rule_id:             string,                 // stable canonical identifier
  rule_version:        string,                 // version of that rule at generation time
  rule_explanation:    string | null,          // human-readable "why"
  formula_explanation: string | null,          // human-readable "how"

  // Rate provenance:
  // Hours-first rows MAY have rate_id / rate_version_id set when a rate
  // code drives a fixed-hour value (e.g. standby_hours = 0.5). Hours-first
  // matrix-output rows have no driving rate (rate_id = null,
  // rate_version_id = null) but still write a rate_snapshot capturing the
  // matrix_version + matrix_hours for audit replay.
  rate_id:             string | null,          // → rates.id
  rate_version_id:     string | null,          // → rate_versions.id
  rate_snapshot:       object,                 // NEVER null — jsonb on the SQL side

  // Payment routing (per PAYMENT_RECONCILIATION_v1.0.md § Payment Method Routing):
  payment_method:      'payslip' | 'petty_cash' | null,
  payment_status:      // null until payment_method is set; stream-scoped thereafter
                       'pending' | 'paid' | 'outstanding' | 'claimed' | null,
}
```

Notes:

- `claim_id` / `owner_id` / `id` / `generated_at` / `updated_at` are set
  by the claim writer (or the DB defaults), not the engine.
- `rate_snapshot` is REQUIRED — even hours-first matrix-output rows
  store a snapshot like `{ matrix_version, matrix_hours, from_station_id,
  to_station_id }` for audit replay. The NOT NULL constraint on the SQL
  column reflects this.
- `edited_*` / `manual_override` are always `null` / `false` at
  generation. They are user-edit fields and the engine MUST NOT
  pre-populate them.

### Hours-first vs dollars-first

Resolved per `ENTITLEMENT_RULES_v1.0.md § FRV Matrix Hours → Payable
Bridge` (2026-05-26).

| Mode           | `unit`     | `generated_amount` | `generated_hours` | Notes |
|----------------|------------|--------------------|-------------------|-------|
| dollars-first  | `dollars`  | required `number`  | `null` (or unused)| Small/Large Meal, Spoilt/Delayed Meal $ (when resolved), Excess Travel (Recall $/km) |
| hours-first    | `hours`    | `null`             | required `number` | Standby Excess Travel, Standby&Dismi (0.5h), M&D Excess Travel, Muster&Dismis (1.0h) |
| km (transitional) | `km`    | `null`             | `null`            | Reserved for unbridged distance rows; not currently emitted. Kept in the `unit` enum because the SQL allows it. |

### Entitlement catalogue (in-spec subset)

The catalogue is still being codified in `ENTITLEMENT_RULES_v1.0.md`.
Stable rule identifiers used by Phase 3 generators MUST follow
`{rule_family}.{variant}.{version}` form so historical rows remain
queryable after rule version bumps.

| `entitlement_type`         | `rule_id` (initial)            | Mode           | Rate code        | Status |
|----------------------------|--------------------------------|----------------|------------------|--------|
| `small_meal`               | `meal.small.v1`                | dollars-first  | `small_meal`     | Resolved |
| `large_meal`               | `meal.large.v1`                | dollars-first  | `large_meal`     | TODO trigger (Recall) |
| `excess_travel_recall`     | `excess_travel.recall.v1`      | dollars-first  | `travel_per_km`  | TODO threshold + formula |
| `excess_travel_standby`    | `excess_travel.standby.v1`     | hours-first    | (none — matrix)  | Resolved |
| `excess_travel_md`         | `excess_travel.md.v1`          | hours-first    | (none — matrix)  | Resolved |
| `standby_dismi`            | `standby_dismi.fixed.v1`       | hours-first    | `standby_hours`  | Resolved (0.5h) |
| `muster_dismis`            | `muster_dismis.fixed.v1`       | hours-first    | `md_hours`       | Resolved (1.0h) |
| `relieving`                | TODO                            | TODO           | TODO             | TODO |
| `delayed_meal`             | TODO                            | TODO           | TODO             | TODO |
| `spoilt_meal`              | TODO                            | TODO           | TODO             | TODO |
| `maint_stn_nn`             | TODO                            | TODO           | TODO             | TODO |

The `entitlement_type` column in `claim_entitlements` is `text` with no
DB-side CHECK — the catalogue is enforced app-side until it stabilises
(see [01_canonical_foundation.sql:226](../supabase/canonical/01_canonical_foundation.sql)).

---

## 4. Helper Contracts (`lib/fat/models/entitlementHelpers.js`)

The existing `effectivePayable` helper assumes every entitlement has a
non-null `generated_amount`. With the hours-first decision that
assumption no longer holds. Phase 3 needs two co-equal helpers.

### `effectiveAmount(entitlement) → number | null`

```ts
effectiveAmount(e) = e.edited_amount ?? e.generated_amount
```

- Dollars-first rows: returns the user-effective dollar amount.
- Hours-first rows: returns `null` (no dollar prediction at generation).
- Callers MUST treat `null` as "no dollar value at this time" — not as
  zero. Reconciliation summaries sum only non-null values.

### `effectiveHours(entitlement) → number | null`

```ts
effectiveHours(e) = e.edited_hours ?? e.generated_hours
```

- Hours-first rows: returns the user-effective hours.
- Dollars-first rows: returns `null` (the row carries no hours quantity).

### `isManualOverride(entitlement) → boolean`

Unchanged. Mirrors `edited_amount IS NOT NULL OR edited_hours IS NOT NULL`.

### Backwards compatibility

`effectivePayable` is currently exported from
[entitlementHelpers.js](../lib/fat/models/entitlementHelpers.js). The
Phase 3 plan:

- Introduce `effectiveAmount` + `effectiveHours` alongside.
- Migrate every call site that today expects a single number to choose
  the helper appropriate for the row's `unit`.
- Remove `effectivePayable` once all call sites are migrated.

No backwards-compatibility shim ships in the schema or model layer —
the migration happens during Phase 3 service rewrite.

---

## 5. Per-Claim Generator Contracts

One generator per claim type. Each is a pure function:

```ts
generateXxxEntitlements(claim, details, ctx) → EntitlementDraft[]
```

where `ctx` carries `rateLookup`, `matrixLookup`, and `profileSnapshot`.

Generators MUST:

- Return an empty array when triggers fire but inputs are insufficient
  (e.g. matrix lookup returns `null` for the required cell). They MUST
  NOT emit a row with placeholder values.
- Surface a structured error / log when a required rate or matrix
  lookup is missing, so the claim writer can decide whether to abort
  the parent INSERT or persist the claim with zero entitlements (Phase
  3 service decision — out of spec here).
- Populate every required `EntitlementDraft` field. Omission is a bug.

Each section below states (a) what is resolved and what the generator
MUST emit, and (b) what is still TODO and what the generator MUST NOT
emit until the canonical doc resolves it.

### 5.1 Recall (`RC`)

Resolved: travel scope is Google Maps (km only). The Recall server route
[app/api/travel/google/route.js](../app/api/travel/google/route.js)
already provides the km value; the claim writer pre-populates
`details.travel_distance_km`.

TODO (`ENTITLEMENT_RULES_v1.0.md § Recall → Entitlements`):

- Large Meal trigger condition.
- Travel Allowance formula.
- Excess Travel threshold + formula.
- Relieving Allowance trigger.

Generator MUST emit:

- Nothing yet — every Recall entitlement is gated on an unresolved
  trigger. The generator scaffold exists so call sites can integrate,
  but it returns `[]` until the canonical rules land.

Generator MUST NOT:

- Invent Large Meal / Travel / Excess Travel / Relieving formulas.
- Carry forward the prototype `autoChild` slugs (`callback_ops`,
  `excess_travel`, `petty_cash_meal`, …) as `rule_id` values without
  the canonical `{family}.{variant}.{version}` rewrite — the audit
  trail must be queryable after migration.

### 5.2 Retain (`RT`)

Status: entire entitlement set is TODO (`CLAIM_TYPES_v1.0.md § Retain`).

Generator MUST emit `[]` until the canonical set is defined.

### 5.3 Standby (`SB`)

Resolved (`ENTITLEMENT_RULES_v1.0.md § Standby → Entitlements`).

Generator MUST emit, when triggers fire:

1. **Excess Travel (Standby)** — hours-first.
   - `entitlement_type = 'excess_travel_standby'`
   - `rule_id = 'excess_travel.standby.v1'`
   - `unit = 'hours'`
   - `generated_hours = matrixLookup(rostered_station_id, standby_station_id, matrix_version).hours`
   - `generated_amount = null`
   - `rate_id = null`, `rate_version_id = null`
   - `rate_snapshot = { matrix_version, matrix_hours, from_station_id, to_station_id }`
   - `payment_method = 'payslip'`, `payment_status = 'pending'`
2. **Standby&Dismi** — hours-first, fixed.
   - `entitlement_type = 'standby_dismi'`
   - `rule_id = 'standby_dismi.fixed.v1'`
   - `unit = 'hours'`
   - `generated_hours = rateLookup('standby_hours', claim_date).value` (currently 0.5)
   - `generated_amount = null`
   - `rate_id`, `rate_version_id` populated from the lookup.
   - `rate_snapshot = { code: 'standby_hours', value, version_label, effective_from }`
   - `payment_method = 'payslip'`, `payment_status = 'pending'`
3. **Small Meal Allowance** — dollars-first.
   - `entitlement_type = 'small_meal'`
   - `rule_id = 'meal.small.v1'`
   - `unit = 'dollars'`
   - `generated_amount = rateLookup('small_meal', claim_date).value`
   - `generated_hours = null`
   - `rate_id`, `rate_version_id` populated.
   - `rate_snapshot = { code: 'small_meal', value, version_label, effective_from }`
   - `payment_method = 'petty_cash'`, `payment_status = 'outstanding'`

Generator MUST NOT:

- Convert matrix hours to dollars at generation time (hours-first
  decision is canonical — see § 1).
- Emit any of the three rows if its required lookup returns `null`.

### 5.4 Muster & Dismiss (`MD`)

Resolved (`ENTITLEMENT_RULES_v1.0.md § Muster & Dismiss → Entitlements`).

Generator MUST emit, when triggers fire:

1. **Excess Travel (M&D)** — hours-first.
   - `entitlement_type = 'excess_travel_md'`
   - `rule_id = 'excess_travel.md.v1'`
   - `unit = 'hours'`
   - `generated_hours = matrixLookup(rostered_station_id, md_station_id, matrix_version).hours`
   - Other fields parallel § 5.3 item 1.
2. **Muster&Dismis** — hours-first, fixed.
   - `entitlement_type = 'muster_dismis'`
   - `rule_id = 'muster_dismis.fixed.v1'`
   - `unit = 'hours'`
   - `generated_hours = rateLookup('md_hours', claim_date).value` (currently 1.0)
   - Other fields parallel § 5.3 item 2.

Payment routing for M&D children remains formally TODO in
`PAYMENT_RECONCILIATION_v1.0.md § Payment Method Routing`. **Recommended
default** (carried forward from Standby's split-entitlement parallel):
`payment_method = 'payslip'`, `payment_status = 'pending'` for both
rows. The generator MAY emit this default; the canonical doc owns the
final decision. If the routing TODO resolves to `null` (defer routing
until later), the generator emits `payment_method = null`.

### 5.5 Delayed Meal (`DM`)

Status: entire entitlement set is TODO
(`ENTITLEMENT_RULES_v1.0.md § Delayed Meal → Entitlements`,
`CLAIM_TYPES_v1.0.md § Delayed Meal`).

Generator MUST emit `[]` until the canonical set is defined.

### 5.6 Spoilt Meal (`SM`)

Status: entire entitlement set is TODO (parallel sources to § 5.5).

Generator MUST emit `[]` until the canonical set is defined.

---

## 6. Required Schema / Model Changes Before Phase 3 Writes

These are the only changes Phase 3 needs to land before the canonical
engine writes its first row. None of them are blocking Phase 1/2
sign-off (already shipped in
[01_canonical_foundation.sql](../supabase/canonical/01_canonical_foundation.sql)
+ [lib/fat/models/](../lib/fat/models)). All are additive.

### 6.1 Drop `NOT NULL` on `generated_amount`

File to add: `supabase/canonical/02_entitlement_amount_nullable.sql`
(not yet written).

```sql
alter table fat.claim_entitlements
  alter column generated_amount drop not null;
```

Rationale: hours-first rows persist with `generated_amount IS NULL`.
The current `NOT NULL` constraint
([01_canonical_foundation.sql:231](../supabase/canonical/01_canonical_foundation.sql))
blocks the engine from writing Standby and M&D hours-first rows.

### 6.2 Widen `generated_amount` typedef

File: [lib/fat/models/claimEntitlement.js](../lib/fat/models/claimEntitlement.js)

Change `@property {number} generated_amount` → `@property {number|null}
generated_amount`. JSDoc-only; no runtime change.

### 6.3 Add `effectiveAmount` and `effectiveHours` helpers

File: [lib/fat/models/entitlementHelpers.js](../lib/fat/models/entitlementHelpers.js)

Implement the two helpers per § 4. `effectivePayable` stays in place
during the migration; remove it once the last call site is migrated.

### 6.4 No other schema or model changes required

The Phase 1 schema already supports:

- `unit` enum including `hours` and `km`
  ([01_canonical_foundation.sql:229](../supabase/canonical/01_canonical_foundation.sql)).
- `generated_hours` nullable
  ([01_canonical_foundation.sql:232](../supabase/canonical/01_canonical_foundation.sql)).
- `rate_id` / `rate_version_id` nullable (hours-first matrix rows have
  no driving rate).
- `payment_method` / `payment_status` nullable until the claim writer
  sets them per claim-type defaults.

---

## 7. Invariants the Engine MUST Satisfy

Stated explicitly so the Phase 3 test bench can assert them.

1. For every `EntitlementDraft` in the output:
   - exactly one of `(generated_amount, generated_hours)` is non-null,
   - `unit === 'dollars'` ⇒ `generated_amount` non-null,
     `generated_hours` null,
   - `unit === 'hours'` ⇒ `generated_hours` non-null,
     `generated_amount` null,
   - `unit === 'km'` ⇒ both null (transitional; not currently emitted).
2. `manual_override === false` and `edited_amount === edited_hours
   === edited_note === null` at generation. The engine MUST NOT
   populate edit fields.
3. `rule_id` and `rule_version` are non-empty strings.
4. `rate_snapshot` is non-null. For matrix-driven hours-first rows it
   captures the matrix cell context; for rate-driven rows it captures
   the rate version row.
5. If `payment_method` is non-null, `payment_status` is the stream's
   initial state (`'pending'` for payslip, `'outstanding'` for
   petty_cash). The engine never emits a terminal state.
6. The engine reads from the supplied `rateLookup` / `matrixLookup` /
   `profileSnapshot` only. It does NOT query the database directly. It
   does NOT cache lookup results across calls — each generation is a
   fresh pure-function invocation.
7. The engine NEVER mutates its inputs.

---

## 8. Remaining Blockers (External to This Contract)

This contract is implementable today for **Standby** and **Muster &
Dismiss** entitlement generators end-to-end. The blockers below gate
other generators or downstream subsystems; none gate this spec.

| Blocker                                                       | Generator(s) affected | Source TODO                                  |
|---------------------------------------------------------------|-----------------------|----------------------------------------------|
| Recall entitlement triggers (Large Meal / Travel / Excess / Relieving) | RC                    | `ENTITLEMENT_RULES_v1.0.md § Recall`         |
| Retain entitlement set                                         | RT                    | `ENTITLEMENT_RULES_v1.0.md § Retain`         |
| Delayed Meal entitlement set                                   | DM                    | `ENTITLEMENT_RULES_v1.0.md § Delayed Meal`   |
| Spoilt Meal entitlement set                                    | SM                    | `ENTITLEMENT_RULES_v1.0.md § Spoilt Meal`    |
| M&D auto-child payment routing                                 | MD (recommended default in § 5.4) | `PAYMENT_RECONCILIATION_v1.0.md § Payment Method Routing` |
| FRV Matrix version pin source (`profiles` vs detail row)       | SB, MD                | `DATABASE_ARCHITECTURE_v1.0.md § TODO`       |
| `claim_entitlements.payment_status` split per stream vs single enum | Reconciliation surface (not engine) | `DATABASE_ARCHITECTURE_v1.0.md § TODO` |

The schema follow-up in § 6.1 is the only **engine-side** prerequisite
before Phase 3 starts writing rows.

---

## 9. Out of Scope

This document does NOT:

- Implement any generator.
- Decide service file layout for Phase 3.
- Define test-bench shape (`validationScenarios.js` reuse vs new file).
- Cover reconciliation, payment ingestion, or sharing-layer behaviour
  beyond the routing defaults each generator emits.
- Cover UI form shape for `new-claim`.
- Cover Phase 3 step ordering — that lives in
  [REBUILD_AUDIT_v1.0.md § Phased Rebuild — Sequencing Audit](REBUILD_AUDIT_v1.0.md).

---

## 10. Cross-References

- [REBUILD_PLAN_v1.0.md](REBUILD_PLAN_v1.0.md) — phased plan + change control
- [REBUILD_AUDIT_v1.0.md](REBUILD_AUDIT_v1.0.md) — full gap audit + sequencing
- [SCHEMA_READINESS_v1.0.md](SCHEMA_READINESS_v1.0.md) — Phase 1 verification gate
- [CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md) — claim/entitlement/payment lifecycle + audit contract
- [RECONCILIATION_STATE_ARCHITECTURE_v1.0.md](RECONCILIATION_STATE_ARCHITECTURE_v1.0.md) — Phase 3 reconciliation-state contract (stream semantics, routing, link_kind taxonomy, discrepancy states, audit event enum, service contracts)
- [supabase/canonical/01_canonical_foundation.sql](../supabase/canonical/01_canonical_foundation.sql) — Phase 1 schema
- [lib/fat/models/](../lib/fat/models) — Phase 2 typed models
- Governance canonical source set:
  `C:\Users\Admin\Apps\governance-system\chatgpt-project-sources\fire-allowance-tracker\`
