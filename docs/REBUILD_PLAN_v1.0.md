# Fire Allowance Tracker — Canonical Rebuild Plan

Version: v1.0
Status: Draft — Phase 0 (audit + plan)
Last Updated: 2026-05-26
Branch: `dev`

---

## Purpose

Capture the audit findings and the phased plan for migrating the prototype
`fat.*` schema and supporting services onto the canonical architecture defined
in the governance-system repo:

- `DATABASE_ARCHITECTURE_v1.0.md`
- `ALLOWANCE_ARCHITECTURE_v1.0.md`
- `ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md`
- `CLAIM_TYPES_v1.0.md`
- `ENTITLEMENT_RULES_v1.0.md`
- `PAYMENT_RECONCILIATION_v1.0.md`

This document is the single change-control record for the rebuild. It must be
updated as phases land; do NOT track this state in commit messages alone.

---

## Rebuild Assumption

App is NOT live. Dev/test data is disposable. Existing tables are historical
input only — no backwards-compatible data migration is required.

Bounded domain stays `fat.*`. Cross-domain reads/writes remain out of scope.

---

## Audit Snapshot

### Existing canonical alignment (keep)

| Existing                       | Canonical Equivalent             | Notes                                       |
|--------------------------------|----------------------------------|---------------------------------------------|
| `fat.stations`                 | `fat.stations`                   | Same intent. Add canonical columns.         |
| `fat.profiles` (id, email)     | `fat.profiles`                   | Identity row + auth trigger. Extend.        |
| `fat.travel_matrix_versions`   | (versioning helper)              | Useful, not required by canonical doc.      |
| `fat.travel_matrix_cells`      | `fat.station_time_matrix`        | Cells store hours from FRV Index sheet.     |
| `fat.station_aliases`          | (no canonical equivalent)        | Operational helper; not in conflict.        |
| Supabase auth (`auth.users`)   | (unchanged)                      | Must remain stable.                         |
| `on_auth_user_created_fat`     | (unchanged)                      | Auto-seeds `fat.profiles`. Keep.            |

### Existing prototype-only (will be displaced; NOT removed in this phase)

| Existing                  | Reason it doesn't fit canonical                                                                                      |
|---------------------------|----------------------------------------------------------------------------------------------------------------------|
| `fat.financial_years`     | Canonical model has no FY-workspace concept; claim_date alone scopes claims.                                          |
| `fat.claim_sequences`     | Canonical model has no per-FY sequence numbering.                                                                     |
| `fat.claim_groups`        | Conflates operational claim core + payment status (`parent_status` Pending/Paid/Disputed). Canonical separates layers. |
| `fat.recalls`             | One-table-per-claim-type with operational + computed amounts + payment_status in one row. Canonical splits 3 layers.  |
| `fat.retain`              | Same conflation.                                                                                                       |
| `fat.standby`             | Same conflation. Also models M&D via a discriminator (`standby_type`) — canonical promotes M&D to top-level.          |
| `fat.spoilt_meals`        | Same conflation. Models Spoilt + Delayed via `meal_type` discriminator — canonical splits to two detail tables.        |
| `fat.profile_ext`         | Mixes operational fields canonical wants on `fat.profiles` (`rostered_station_id`, home location).                    |
| `fat.user_rates`          | Per-user rate overrides — canonical replaces with global `fat.rates` + `fat.rate_versions`.                           |
| `fat.distance_cache`      | Superseded — canonical home/station distance flows through detail tables and matrix tables, not a user cache row.      |
| `fat.home_address`        | Home address fields canonical wants on `fat.profiles`.                                                                |
| `fat.station_distances`   | Per-user home/station distance estimate cache — superseded by matrix + detail-table snapshots.                        |

### Out of scope (already flagged historical)

- `supabase-migration-v4-distance-tables.sql`
- `DISTANCE-SYSTEM-DEPLOY-REPORT.md`

Do not consult these per canonical `DATABASE_ARCHITECTURE_v1.0.md § Rebuild
Assumption`.

---

## Phased Plan

### Phase 0 — Audit + Plan  *(this PR)*

- Read all six canonical docs.
- Audit existing schema/services for alignment vs conflict.
- Write this document.
- Track open architecture questions sourced from the canonical TODO lists.

### Phase 1 — Canonical Foundation Schema  *(this PR)*

Create new canonical tables in the `fat.*` schema, **alongside** the existing
prototype tables. No data migration. No destructive drops. App keeps booting
on the prototype tables until Phase 3 cuts services over.

New / extended objects:

- Extend `fat.profiles` with canonical columns: `display_name`,
  `rostered_station_id`, `home_location_label`, `home_lat`, `home_lng`.
- Extend `fat.stations` with canonical columns: `district`, `street_address`,
  `lat`, `lng`. (`active` already provided via `is_active`.)
- `fat.rates`
- `fat.rate_versions`
- `fat.operational_claims` (core)
- `fat.recall_details`
- `fat.retain_details`
- `fat.standby_details`
- `fat.muster_dismiss_details`
- `fat.delayed_meal_details`
- `fat.spoilt_meal_details`
- `fat.claim_entitlements`
- `fat.station_distance_matrix`  *(canonical naming)*
- `fat.station_time_matrix`      *(canonical naming; mirrors existing `fat.travel_matrix_cells`)*
- `fat.payment_records`
- `fat.entitlement_payment_links`
- `fat.reconciliation_audit`

All new tables include `parent_claim_id` / `copy_source_owner_id` where the
canonical doc requires them; entitlement table includes `generated_amount`
+ `edited_amount` pair with the `manual_override` mirror column.

RLS policies follow the canonical scoping model: per-owner for user-data
tables, authenticated-read for shared reference tables.

### Phase 2 — Typed Models  *(this PR)*

`lib/fat/models/` — one JSDoc-typed module per canonical table. Pure
shapes + the `effectivePayable` helper (`COALESCE(edited_amount,
generated_amount)`). No runtime behavior change.

### Phase 3 — Service Migration  *(future PR; out of scope here)*

- Replace `lib/claims/ClaimsContext.js` queries against `fat.recalls /
  retain / standby / spoilt_meals` with reads from
  `fat.operational_claims` + the detail tables.
- Replace `lib/calculations/engine.js` rate lookups via
  `fat.user_rates` with `fat.rates` + `fat.rate_versions` snapshotting
  at generation time.
- Replace `fat.claim_groups` + per-claim-type tables with
  `fat.operational_claims` + per-claim-type `*_details` tables.
- Wire reconciliation surface to `fat.payment_records` /
  `fat.entitlement_payment_links` and start writing to
  `fat.reconciliation_audit`.
- Drop prototype tables after services are fully migrated. Will require
  a separate decision PR — see TODO list.

### Phase 4 — Decision Backlog  *(future)*

Canonical docs list open architecture questions (status enums, soft-delete,
matrix table merge, etc.). Each must be confirmed before the relevant
production behaviour ships. See "Open Architecture Questions" below.

---

## Open Architecture Questions (carried from canonical docs)

Sourced verbatim from the canonical TODO lists. Resolve in a follow-up PR
before the corresponding feature ships.

- `operational_claims.status` — does it need a `void` state?
- `claim_entitlements.payment_status` — split per stream or single enum?
- `station_distance_matrix` + `station_time_matrix` — merge or keep split?
- FRV Matrix version pin — per-user (`profiles`) or per-claim (detail tables)?
- RLS policy spec doc — needs separate document once schema stamps.
- Soft-delete vs hard-delete for `operational_claims`; cascade behaviour.
- `parent_claim_id` / `copy_source_owner_id` — enforce existence with FK or
  remain informational?
- Petty-cash export shape — materialised table vs computed on demand?
- `payslip_imports` raw-ingest table shape.
- Recall entitlement trigger conditions (Large Meal, Travel, Excess Travel,
  Relieving).
- Delayed Meal + Spoilt Meal entitlement sets.
- Relieving Allowance trigger + formula.

These are intentionally NOT pre-decided in the Phase 1 migration. The schema
shape is forward-compatible with any reasonable resolution.

### Resolved (2026-05-26)

- **FRV Matrix hours → payable bridge.** Hours-first: matrix output is the
  canonical payable quantity on `claim_entitlements.generated_hours`; no
  implicit hours → dollars conversion at generation time. See
  `ENTITLEMENT_RULES_v1.0.md § FRV Matrix Hours → Payable Bridge` and
  `SCHEMA_READINESS_v1.0.md § Resolved Architecture Decisions`.
- **Standby entitlement formulas** (Excess Travel matrix-hours,
  Standby&Dismi fixed 0.5h, Small Meal Allowance dollars-first). See
  `ENTITLEMENT_RULES_v1.0.md § Standby → Entitlements`.
- **M&D entitlement set post-promotion** (Excess Travel matrix-hours,
  Muster&Dismis fixed 1.0h). See
  `ENTITLEMENT_RULES_v1.0.md § Muster & Dismiss → Entitlements`.

**Phase 3 schema follow-up** (additive, not blocking sequencing): a new
migration `supabase/canonical/02_entitlement_amount_nullable.sql` must
drop `NOT NULL` on `fat.claim_entitlements.generated_amount` before the
engine writes the first hours-first row.

---

## Constraints (re-stated for change control)

- `dev` branch only. No merge to `main` without approval.
- No unrelated cleanup.
- No architecture drift from canonical docs unless a conflict/blocker is
  discovered AND documented here.
- Preserve auth stability — `fat.profiles` + `on_auth_user_created_fat`
  trigger remain untouched.
- Avoid premature optimisation (no view materialisations, no indexes
  beyond what canonical doc names).
- Do not implement speculative advanced entitlement logic.

---

## File Locations

- Canonical foundation SQL: `supabase/canonical/01_canonical_foundation.sql`
- Typed models: `lib/fat/models/`
- This plan: `docs/REBUILD_PLAN_v1.0.md`
- Existing prototype schema (untouched in this phase):
  `supabase/fat-schema.sql`, `supabase/fat-schema-travel.sql`

---

## Cross-References

- `docs/SCHEMA_READINESS_v1.0.md` — Phase 1 verification gate output and
  remaining deferred blockers.
- `docs/ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md` — Phase 3 engine boundary
  specification (inputs, outputs, helper contracts, per-claim generators).
- `docs/CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md` — Phase 3 lifecycle/state-machine
  contract (operational claim states, entitlement payment streams,
  payment_records, links, reconciliation audit, manual override, delete/archive).
- `docs/RECONCILIATION_STATE_ARCHITECTURE_v1.0.md` — Phase 3 reconciliation-state
  contract (stream semantics, payment-method routing, payment_records,
  link_kind taxonomy, discrepancy states, audit event enum, service contracts).
- `docs/FAT_SCHEMA_ARCHITECTURE.md` — current prototype architecture map.
  Will be superseded by canonical docs in Phase 3.
- Governance-system canonical docs at
  `C:\Users\Admin\Apps\governance-system\chatgpt-project-sources\fire-allowance-tracker\`.
