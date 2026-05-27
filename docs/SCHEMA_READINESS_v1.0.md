# Fire Allowance Tracker — Canonical Schema Readiness Report

Version: v1.0
Status: Ready for Phase 2/3 service migration
Last Updated: 2026-05-26
Branch: `dev`

Companion to:

- [REBUILD_PLAN_v1.0.md](REBUILD_PLAN_v1.0.md)
- [REBUILD_AUDIT_v1.0.md](REBUILD_AUDIT_v1.0.md)
- [ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md](ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md)
- [supabase/canonical/01_canonical_foundation.sql](../supabase/canonical/01_canonical_foundation.sql)

This document is the verification gate output for **Phase 1 — Canonical
Foundation Schema**. It records the audit verdict on the canonical SQL +
typed models against `DATABASE_ARCHITECTURE_v1.0.md`, lists the refinements
applied this PR, and enumerates the open business-rule blockers that
intentionally remain deferred.

---

## Verdict

The canonical schema foundation is **ready** for downstream entitlement-
engine and service rewrites:

- All 15 canonical tables specified by `DATABASE_ARCHITECTURE_v1.0.md` are
  present and column-shape-aligned.
- Layer separation is intact: operational claims, generated entitlements,
  rates/rate versions, station matrices, and payment/reconciliation each
  live in their own tables with no cross-conflation.
- RLS is enabled on every canonical table; policies are owner-scoped for
  user data and authenticated-read for shared reference data.
- Typed models in [lib/fat/models/](../lib/fat/models) mirror the SQL
  column-for-column; the `effectivePayable` / `isManualOverride` helpers
  are correct against the canonical override semantics.
- Idempotency claim in the file header is now actually true after the
  RLS policy refactor (was a latent replay bug — see § Refinements).

No structural inconsistencies block Phase 3 sequencing. Every remaining
gap is a business-rule decision tracked under § Deferred Blockers.

---

## Audit Coverage

The canonical SQL was walked section-by-section against
`DATABASE_ARCHITECTURE_v1.0.md`. Coverage summary:

| Canonical doc section                         | SQL match status |
|-----------------------------------------------|------------------|
| § 1. Users and Profiles                       | Aligned          |
| § 2. Operational Claims (core + 6 details)    | Aligned          |
| § 3. Generated Entitlements                   | Aligned          |
| § 4. Rates                                    | Aligned + refined (unique constraint) |
| § 5. Stations + Travel Reference Data         | Aligned (with one acceptable naming drift) |
| § 6. Sharing Model                            | Schema forward-compatible; mechanics deferred |
| § 7. Payment and Reconciliation               | Aligned + refined (indexes, comments) |
| § 8. Status Enums                             | Aligned at column level; stream-scoped status remains text per open TODO |
| § 9. Historical Static Accounting Records     | Enforcement is app-layer (comments call this out); doc accepts this posture |

Typed-model coverage (`lib/fat/models/`):

| Model file                  | SQL table(s)                                                       | Status |
|-----------------------------|--------------------------------------------------------------------|--------|
| `profile.js`                | `profiles`                                                         | Aligned |
| `station.js`                | `stations`                                                         | Aligned (note: doc says `active`, SQL has `is_active` — documented divergence) |
| `rate.js`                   | `rates`, `rate_versions`                                           | Aligned |
| `operationalClaim.js`       | `operational_claims`                                               | Aligned |
| `claimDetails.js`           | 6 `*_details` tables + `DETAIL_TABLE_BY_CLAIM_TYPE` map           | Aligned |
| `claimEntitlement.js`       | `claim_entitlements`                                               | Aligned |
| `stationMatrix.js`          | `station_distance_matrix`, `station_time_matrix`                   | Aligned |
| `payment.js`                | `payment_records`, `entitlement_payment_links`                     | Aligned |
| `reconciliationAudit.js`    | `reconciliation_audit`                                             | Aligned |
| `entitlementHelpers.js`     | (helpers — `effectivePayable`, `isManualOverride`)                 | Aligned to override semantics |

---

## Refinements Applied This PR

All refinements are non-controversial integrity / idempotency / performance
fixes. None pre-decide an open architecture question.

### R1 — RLS policy block made idempotent

Section 10 previously emitted bare `create policy ...` statements. Postgres
has no `CREATE POLICY IF NOT EXISTS`, so the file's stated idempotency
guarantee was broken on second replay. Wrapped every policy creation in a
guarded `DO $$ ... $$` block that checks `pg_policies` first. Pattern matches
the one already used in [supabase/fat-schema-travel.sql](../supabase/fat-schema-travel.sql).

### R2 — `fat.rate_versions` integrity

Added `unique (rate_id, effective_from)` alongside the existing
`unique (rate_id, version_label)`. The canonical lookup rule
(`DATABASE_ARCHITECTURE_v1.0.md § 4`) — *"pick the row where
`effective_from <= claim_date` and there is no later `effective_from` for
the same `rate_id`"* — is ambiguous if two rows share `(rate_id,
effective_from)`. The new constraint enforces unambiguous resolution.

Added supporting index `(rate_id, effective_from desc)` for the lookup.

### R3 — Non-negative checks on matrix tables

Added `check (distance_km >= 0)` to `fat.station_distance_matrix` and
`check (hours >= 0)` to `fat.station_time_matrix`. Matches the integrity
posture of the prototype `fat.travel_matrix_cells.value` (`check (value >= 0)`)
without changing the doc-stated shape.

### R4 — FK-side indexes on `fat.entitlement_payment_links`

Added indexes on `entitlement_id` and `payment_record_id`. Postgres does
not auto-index FK columns; both directions are joined whenever
reconciliation surfaces render.

### R5 — Sharing-layer index

Added partial index `idx_operational_claims_parent` on `parent_claim_id`
(where not null). Cheap until the sharing layer ships; protects the
"find all copies of this claim" lookup from a full scan.

### R6 — Reconciliation audit timeline index

Added `(entitlement_id, created_at desc)` on `fat.reconciliation_audit`
for the per-entitlement history view referenced in
`DATABASE_ARCHITECTURE_v1.0.md § 7`.

### R7 — Payment-records browse index

Added `(owner_id, stream, record_date desc)` on `fat.payment_records`
for the typical "this user's payslip / petty-cash records" reconciliation
surface.

### R8 — Column comments on `claim_entitlements`

Added explicit column comments on:

- `owner_id` — calls out the denormalisation from
  `operational_claims.owner_id` so engine writers see it without reading
  the rebuild audit.
- `payment_method` / `payment_status` — restates the stream-scope rule
  (payslip → pending|paid; petty_cash → outstanding|claimed) directly on
  the column, with a pointer to the open canonical TODO.

### R9 — Header idempotency claim corrected

Header note now accurately describes the idempotency mechanism: `IF NOT
EXISTS` / `OR REPLACE` for objects, guarded `DO` blocks for policies.

---

## Acceptable Documented Drift

These are known divergences from `DATABASE_ARCHITECTURE_v1.0.md` that are
**not** schema bugs. They are tracked here so future readers don't
"correct" them by mistake.

| Item | Doc shape | SQL shape | Why kept |
|---|---|---|---|
| Stations active flag | `active boolean` | `is_active boolean` | Existing prototype column. Renaming forces synchronized prototype-app refactor; out of Phase 1 scope. Audit doc already calls this out. |
| Stations timestamps | `created_at` only | `created_at` + `updated_at` (+ trigger) | Existing prototype shape — keeps station maintenance ergonomics intact. Harmless surplus. |
| `claim_entitlements.rate_id`, `rate_version_id` | FK (nullable not specified) | FK, nullable | Doc treats these as a "convenience pointer"; `rate_snapshot` is the source of truth for historical claims. Nullable while rate catalogue is being seeded in Phase 3 step 1. |
| `claim_entitlements.payment_status` | enum (stream-scoped values) | `text`, no CHECK | Intentionally deferred per the canonical TODO on whether to split per stream. Column comment restates the rule. |
| `operational_claims.parent_claim_id` | FK enforcement not pre-decided | informational text (no FK) | Per canonical TODO #8. Source can be deleted without breaking copies. |
| `claim_entitlements.manual_override` mirror | maintained by app or trigger | app-layer today | Per `01_canonical_foundation.sql` comment, trigger deferred until override semantics stabilise. |

---

## Resolved Architecture Decisions

These were previously tracked as Deferred Blockers; recorded here so the
remaining list below stays accurate.

### FRV Matrix hours → payable bridge — *resolved 2026-05-26 (hours-first)*

Standby and Muster & Dismiss entitlements are **hours-first**: the FRV
Matrix output (0.25-hour increments) is the canonical payable quantity,
written directly to `claim_entitlements.generated_hours`. There is no
implicit hours → dollars conversion at generation time; the dollar
settlement is the payslip line, reconciled via
`entitlement_payment_links`. `generated_amount` is NULL for these rows.

Authoritative source: `ENTITLEMENT_RULES_v1.0.md § FRV Matrix Hours →
Payable Bridge` (governance-system source set). Standby and M&D
entitlement sets are now codified in the same doc.

**Schema follow-up required** (additive, deferred — not blocking Phase 3
sequencing): `fat.claim_entitlements.generated_amount` is currently
`NOT NULL` in `01_canonical_foundation.sql`. A follow-up migration
(`supabase/canonical/02_entitlement_amount_nullable.sql`, not yet
written) must drop the NOT NULL constraint before the engine writes
the first hours-first row. Tracked in the schema follow-up TODO of
`ENTITLEMENT_RULES_v1.0.md`.

---

## Deferred Blockers (Open Architecture Questions)

The schema is intentionally permissive on the items below. Each blocks a
specific Phase 3 step; none block Phase 1/2 sign-off. Sourced verbatim
from `DATABASE_ARCHITECTURE_v1.0.md § TODO` and the rebuild audit.

### Status model

1. **`operational_claims.status` — does it need a `void` state?**
   *Blocks: Phase 3 step 4 (claim writer UX).*
2. **`claim_entitlements.payment_status` — split per stream or single
   enum?** *Blocks: Phase 3 step 5 (reconciliation surface). When
   resolved, add the `CHECK` constraint described in `DATABASE_ARCHITECTURE_v1.0.md § 8`.*

### Matrix / travel

3. **Merge `station_distance_matrix` + `station_time_matrix` into one
   table?** *Blocks: Phase 3 step 3 (matrix loader + travel resolvers).*
4. **FRV Matrix version pin — `profiles` (per-user) or
   `operational_claims` detail tables (per-claim)?** Currently drafted
   per-claim on the detail tables. *Blocks: matrix loader.*

### Sharing layer

5. **Enforce `parent_claim_id` / `copy_source_owner_id` existence with
   FK?** Currently informational text columns. *Blocks: Phase 3 step 8
   (sharing layer).*

### Lifecycle / RLS

6. **Soft-delete vs hard-delete for `operational_claims`** and the
   cascade story through `claim_entitlements`. *Blocks: claim deletion UX.*
7. **`reconciliation_audit` policy** — should the entitlement owner be
   able to read audit rows where `actor_id != owner_id`? Currently
   actor-scoped only. *Becomes relevant once the sharing layer ships.*
8. **RLS policy spec** — needs a dedicated document once the schema is
   stamped (per `DATABASE_ARCHITECTURE_v1.0.md § TODO`).

### Payment / payroll subsystems (out of Phase 1 scope)

9. **Petty-cash export shape** — materialised table vs computed on
   demand? *Blocks: Phase 3 step 5 (petty-cash exporter).*
10. **`payslip_imports` raw-ingest table shape.** *Blocks: payslip
    ingestion subsystem (not in scope for the canonical rebuild).*

### Entitlement-rule blockers (drive engine rewrite, not schema)

11. Recall entitlement trigger conditions (Large Meal, Travel, Excess
    Travel, Relieving).
12. Delayed Meal + Spoilt Meal entitlement sets.
13. Relieving Allowance trigger + formula.

*(Standby formulas and M&D post-promotion entitlement set were
previously listed here; both are now resolved in
`ENTITLEMENT_RULES_v1.0.md` alongside the hours-first bridge.)*

### Profile data

14. **`fat.profile_ext.platoon` / `pay_number`** — canonical home, or
    drop? *Blocks: prototype-table retirement (Phase 3 step 7).*

---

## Phase 1 Verification Gate

Recapped from `REBUILD_AUDIT_v1.0.md § Phase 1`:

- [x] Migration replays cleanly against a stamped Supabase project
      (now actually idempotent after R1).
- [x] All 15 canonical tables present with canonical column shape.
- [x] RLS enabled on every canonical table; policies cover the
      authenticated-read / owner-scoped surface.
- [x] No drops, no data migration — prototype tables remain operational.
- [x] Typed models in `lib/fat/models/` mirror the SQL.

Phase 1 is **complete**. Phase 3 service work may begin in the order
documented in `REBUILD_AUDIT_v1.0.md § Phased Rebuild — Sequencing Audit`
once the relevant Deferred Blocker above is resolved for each step.

---

## Out of Scope

This document does NOT:

- Resolve any of the open canonical TODOs above.
- Migrate any service or UI code to the canonical tables (Phase 3).
- Drop or rename any prototype `fat.*` table (Phase 3 step 7, gated by
  a separate decision PR).
- Apply the schema follow-up that drops `NOT NULL` on
  `fat.claim_entitlements.generated_amount` (a separate migration file
  under `supabase/canonical/`, not yet written). The architectural
  decision behind it is recorded above and in `ENTITLEMENT_RULES_v1.0.md`.

---

## Cross-References

- [REBUILD_PLAN_v1.0.md](REBUILD_PLAN_v1.0.md) — change-control record
- [REBUILD_AUDIT_v1.0.md](REBUILD_AUDIT_v1.0.md) — full gap audit + phased sequencing
- [ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md](ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md) — Phase 3 engine contract spec
- [CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md) — Phase 3 lifecycle/state-machine contract
- [RECONCILIATION_STATE_ARCHITECTURE_v1.0.md](RECONCILIATION_STATE_ARCHITECTURE_v1.0.md) — Phase 3 reconciliation-state contract
- [supabase/canonical/01_canonical_foundation.sql](../supabase/canonical/01_canonical_foundation.sql) — the refined schema
- [lib/fat/models/](../lib/fat/models) — typed models layer
- Governance canonical source set:
  `C:\Users\Admin\Apps\governance-system\chatgpt-project-sources\fire-allowance-tracker\`
