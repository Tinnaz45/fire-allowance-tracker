# Fire Allowance Tracker — Canonical Schema Activation: Post-Deployment Verification Report

Version: v1.0
Status: **DEPLOYED & VERIFIED**
Date: 2026-06-01
Branch: `dev`
Target DB: DEV `kctctvpobbizhkiqkgqw` (region ap-southeast-2)
Out of scope (untouched): PROD `wgcqzamuspuqpedqasbc`

Companion to [CANONICAL_ACTIVATION_PLAN_v1.0.md](CANONICAL_ACTIVATION_PLAN_v1.0.md)
and [CURRENT_STATE_GAP_ANALYSIS_v1.0.md](CURRENT_STATE_GAP_ANALYSIS_v1.0.md).

> Scope executed: deploy the canonical schema only. No entitlement-engine wiring,
> no UI changes, no claim-flow changes, no reconciliation implementation, no OCR,
> no prototype-table removal. Additive + idempotent activation as specified by the
> activation plan §5.2–§5.3.

---

## 1. What was deployed

Two tracked migrations were applied to DEV via Supabase `apply_migration`, in the
verified order. `03_standby_platoon.sql` was **skipped** — its effect
(`fat.standby.platoon`) was already live via migration `20260530020619
add_platoon_to_standby` (confirmed before deploy).

| # | Migration (history name) | Version stamp | Source file | Result |
|---|---|---|---|---|
| 01 | `canonical_01_foundation` | `20260601111400` | `supabase/canonical/01_canonical_foundation.sql` | ✅ success |
| 02 | `canonical_02_entitlement_amount_nullable` | `20260601111418` | `supabase/canonical/02_entitlement_amount_nullable.sql` | ✅ success |
| 03 | *(skipped — already live)* | `20260530020619` | `supabase/canonical/03_standby_platoon.sql` | n/a (no-op) |

Migration history is clean: both new entries appended at the tail of the 58-entry
history; no duplicates, no gaps, no out-of-order application.

---

## 2. Pre-deployment baseline (snapshot)

Verified live before applying anything:

- **Canonical tables: absent.** A probe for all 15 canonical tables returned 0.
- **Preconditions met:** `fat.set_updated_at()` present (1); `gen_random_uuid()`
  available; `fat.profiles.id` = `uuid`; `fat.stations.id` = `integer`;
  `fat.profiles` had only the 6 base columns; `fat.standby.platoon` already present.
- **Prototype data:** recalls 6, retain 8, standby 0, spoilt_meals 5, claim_groups
  6, user_rates 1, profiles 2, stations 82, travel_matrix_cells 3321 (+ others).

---

## 3. Created objects (full inventory)

### 3.1 Tables (15 created — all in schema `fat`)
`rates`, `rate_versions`, `operational_claims`, `recall_details`,
`retain_details`, `standby_details`, `muster_dismiss_details`,
`delayed_meal_details`, `spoilt_meal_details`, `claim_entitlements`,
`station_distance_matrix`, `station_time_matrix`, `payment_records`,
`entitlement_payment_links`, `reconciliation_audit`.

### 3.2 Column additions (additive, in place)
- `fat.profiles` +5: `display_name`, `rostered_station_id` (FK→stations),
  `home_location_label`, `home_lat`, `home_lng`.
- `fat.stations` +4: `district`, `street_address`, `lat`, `lng`
  (`district`/`street_address` were already present from a prior migration →
  `if not exists` no-op; `lat`/`lng` newly added).

### 3.3 Secondary indexes (11 — all `idx_*`)
`idx_rate_versions_rate_effective`, `idx_operational_claims_owner_date`,
`idx_operational_claims_type_date`, `idx_operational_claims_parent` (partial),
`idx_claim_entitlements_claim`, `idx_claim_entitlements_owner_paystatus`,
`idx_claim_entitlements_type_generated`, `idx_payment_records_owner_stream_date`,
`idx_entitlement_payment_links_entitlement`,
`idx_entitlement_payment_links_payment_record`,
`idx_reconciliation_audit_entitlement_time`.

> Note: the activation plan prose says "Indexes (13)", but the authored SQL
> defines exactly **11** secondary `create index` statements, and the plan's own
> itemized list also enumerates 11. All 11 are present. The "(13)" is a plan
> overcount, not a missing object. (Primary-key and unique constraints add further
> btree indexes — e.g. the matrix composite PKs, `rates.code` unique,
> `rate_versions` two unique constraints — but those are constraint-backed, not
> the 11 named secondary indexes.)

### 3.4 Triggers (2)
`set_updated_at` BEFORE UPDATE on `fat.operational_claims` and on
`fat.claim_entitlements`, each executing `fat.set_updated_at()`.

### 3.5 RLS (enabled on all 15; 19 policies)
- 4 shared-reference tables (`rates`, `rate_versions`, `station_distance_matrix`,
  `station_time_matrix`): `authenticated_read` (SELECT) + `service_role_manage`
  (ALL) = 8 policies.
- 11 owner-scoped tables: `users_manage_own` (ALL) = 11 policies.
  - direct `owner_id`: `operational_claims`, `claim_entitlements`, `payment_records`
  - `actor_id`: `reconciliation_audit`
  - via join to `operational_claims.owner_id`: the 6 detail tables
  - via join to `claim_entitlements.owner_id`: `entitlement_payment_links`
- Total = **19 policies**.

### 3.6 Foreign keys & constraints
All FK column types match referenced PKs (`*_station_id` integer → `stations.id`;
`owner_id`/`actor_id`/`rate_*` uuid → respective uuid PKs). The deferred
`rates.active_version_id → rate_versions.id` FK was added post-table-creation via
the guarded `DO` block (`rates_active_version_id_fkey` present). CHECK constraints
present on `claim_type`, `unit`, `status`, `source_calculation_mode`, `stream`,
`source`, `link_kind`, `travel_source`, and the `>= 0` quantity guards.

### 3.7 Grants
`select, insert, update, delete` granted to `authenticated, service_role` on all
15 canonical tables.

### 3.8 Migration 02 effect
`fat.claim_entitlements.generated_amount` is now **nullable** (`is_nullable = YES`)
— enables hours-first entitlement rows.

---

## 4. Validation results (gate-by-gate)

| Gate (plan §5.2–§5.3) | Expected | Observed | Verdict |
|---|---|---|---|
| Canonical tables present | 15 | 15 | ✅ |
| RLS enabled | 15/15 | 15/15 | ✅ |
| Secondary indexes (`idx_*`) | 11 (plan prose says 13 — overcount) | 11 | ✅ |
| `set_updated_at` triggers | 2 | 2 | ✅ |
| RLS policies | ≈19 (4×2 + 11) | 19 | ✅ |
| `profiles` new columns | 5 | 5 | ✅ |
| `stations` new columns | 4 (2 pre-existing) | 4 | ✅ |
| `generated_amount` nullable (02) | YES | YES | ✅ |
| Migration history clean | 2 new, ordered, no dupes | confirmed | ✅ |

---

## 5. Existing-application integrity

- **Prototype tables: unchanged.** Post-deploy row counts identical to baseline
  (recalls 6, retain 8, standby 0, spoilt_meals 5, claim_groups 6, claim_sequences
  4, financial_years 1, user_rates 1, profiles 2, stations 82, profile_ext 1,
  home_address 1, station_distances 1, travel_matrix_versions 1,
  travel_matrix_cells 3321). No drops, no renames, no truncations.
- **Runtime safety:** the running app never references canonical tables; all new
  `profiles`/`stations` columns are nullable (the `handle_new_user` trigger uses
  explicit column lists), so no existing INSERT path is affected. New RLS applies
  only to the new tables. **Activation breaks zero running code.**

---

## 6. Advisor review (post-deploy)

### Security — no new issues introduced by the activation
No canonical table appears with a security defect. The single ERROR
(`rls_disabled_in_public` on `fat.profile_ext_label_backup_20260518`) is
**pre-existing** (flagged in the activation plan §1.5 / gap analysis §1.3) and
unrelated to this deployment. Remaining WARNs (friend-request `SECURITY DEFINER`
RPCs, `function_search_path_mutable`, `extension_in_public`, leaked-password
protection) are all pre-existing and out of this task's scope.

> **Surfaced for the user (pre-existing, NOT changed by this deploy):**
> `fat.profile_ext_label_backup_20260518` has RLS disabled — exposed to the anon /
> authenticated key. Remediation (the user should decide):
> `ALTER TABLE fat.profile_ext_label_backup_20260518 ENABLE ROW LEVEL SECURITY;`
> This is the activation plan's §5.6 hygiene item, intentionally left for a
> separate hygiene pass per the strict "deploy canonical schema only" scope.

### Performance — all INFO/WARN, all expected, none blocking
Canonical-table advisories are consequences of the authored SQL exactly as
written and several mirror pre-existing prototype patterns:
- `unindexed_foreign_keys` (INFO ×11): reference FKs the author deliberately left
  without a covering index (cold-path lookups; same choice the prototype makes).
- `auth_rls_initplan` (WARN): policies call `auth.uid()`/`auth.role()` per row.
  The authored SQL uses the direct form; the pre-existing `fat.user_rates` policy
  carries the identical warning. A future micro-optimization (`(select auth.uid())`)
  would deviate from the authored SQL and is out of scope here.
- `unused_index` (INFO ×11): the new indexes are unused because the tables are
  empty — expected immediately after creation.
- `multiple_permissive_policies` (WARN): the 4 shared-reference tables expose both
  `authenticated_read` and `service_role_manage` on SELECT — by design.

---

## 7. Idempotency confirmation
Every object was created with `IF NOT EXISTS` / guarded `DO` blocks / `OR REPLACE`;
the deferred FK is `pg_constraint`-guarded; triggers `drop ... if exists` then
recreate; policies are `pg_policies`-guarded; migration 02 is a no-op when the
column is already nullable. The migrations are safe to replay.

---

## 8. Outcome

**SUCCESS.** Canonical tables exist in DEV, migration history is clean, all
validation gates pass, and the application behaves exactly as before deployment
(prototype tables and data untouched). The canonical foundation is now live and
ready for the next phases (rates/matrix seeding, then entitlement-engine wiring) —
none of which were performed here, per scope.

### Not done (by scope, for the record)
- No seeding (`rates`/`rate_versions`, `station_time_matrix`) — plan §5.4.
- No entitlement-engine wiring; no claim-writer cutover.
- No reconciliation/OCR implementation.
- No hygiene fixes (backup-table RLS, sharing-table version-control, phantom
  `payment_components`) — plan §5.6.
- PROD untouched.
