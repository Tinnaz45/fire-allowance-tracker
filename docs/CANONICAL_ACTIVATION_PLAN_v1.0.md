# Fire Allowance Tracker — Canonical Schema Activation & Cutover Plan

Version: v1.0
Status: Executable plan (verification + planning only — nothing deployed)
Date: 2026-06-01
Branch: `dev`
Target DB: DEV `kctctvpobbizhkiqkgqw` (PROD `wgcqzamuspuqpedqasbc` out of scope)

Companion to [CURRENT_STATE_GAP_ANALYSIS_v1.0.md](CURRENT_STATE_GAP_ANALYSIS_v1.0.md),
[REBUILD_PLAN_v1.0.md](REBUILD_PLAN_v1.0.md), [REBUILD_AUDIT_v1.0.md](REBUILD_AUDIT_v1.0.md).

> All findings verified against the canonical SQL files and **live Supabase
> introspection** (information_schema, pg_proc, pg_migrations, row counts) on
> 2026-06-01.

---

## 1. Current DEV State

### 1.1 Canonical tables — verified ABSENT
A live query for all 15 canonical tables in schema `fat` returned **empty**.
None of `rates, rate_versions, operational_claims, recall_details,
retain_details, standby_details, muster_dismiss_details, delayed_meal_details,
spoilt_meal_details, claim_entitlements, station_distance_matrix,
station_time_matrix, payment_records, entitlement_payment_links,
reconciliation_audit` exist.

### 1.2 Migration history — proves authored-but-not-deployed
`list_migrations` (58 entries) contains **no** `01_canonical_foundation` /
`canonical` / `entitlement_amount_nullable` migration. The FAT migrations are
all prototype-era. Two history facts change the plan:

- `20260530020619 add_platoon_to_standby` — **already applies the effect of
  `03_standby_platoon.sql`.** `fat.standby.platoon` exists; replaying `03` is a
  guaranteed no-op.
- `20260518021803 fat_stations_address_columns` — already added
  `district`, `street_address` (plus `suburb`, `postcode`) to `fat.stations`.

### 1.3 Pre-existing base (canonical preconditions met)
| Precondition | Live state | Verdict |
|---|---|---|
| `fat` schema + `fat.set_updated_at()` | present (1 function) | ✅ triggers in `01` will bind |
| `gen_random_uuid()` | available | ✅ no extension blocker |
| `fat.profiles.id` | `uuid` | ✅ matches `owner_id uuid` FKs |
| `fat.stations.id` | `integer` | ✅ matches `*_station_id integer` FKs |
| `fat.profiles` columns | `id,email,first_name,last_name,created_at,updated_at` only | canonical adds 5 (all absent → additive) |
| `fat.stations` columns | + `district,street_address,suburb,postcode` already; **no `lat`/`lng`** | `01` adds `lat`,`lng` (absent); `district`/`street_address` adds are no-ops |

### 1.4 Live data (disposable per rebuild premise)
`recalls 6, retain 8, spoilt_meals 5, claim_groups 6, standby 0, user_rates 1,
profiles 2`. Small dev/test set. `REBUILD_PLAN §Rebuild Assumption`: app not
live, **no backward-compatible data migration required.**

### 1.5 Live drift not in version-controlled SQL (carried from prior audit)
- Sharing tables live but absent from `fat-schema.sql`: `friend_requests`,
  `friendships`, `claim_replication_events` (migration
  `20260515223705 fat_friends_and_claim_replication`).
- `fat.profile_ext_label_backup_20260518` — **RLS disabled** (Supabase critical
  advisory).
- Runtime writes a phantom `fat.payment_components` (try/catch-guarded; table
  exists in no schema).

### 1.6 FRV matrix seed source
`fat.travel_matrix_cells`: 3321 rows, **1** version, columns
`(id, version_id, station_a_id, station_b_id, value, created_at)`. All rows are
**single-direction** (`station_a_id < station_b_id`; 0 self-pairs, 0 reverse).
`value` range 0–555 (unit = hours per `project_frv_matrix_unit`; the 555 max
warrants a unit sanity-check before it becomes payable). No `fat.station_distances`
km source exists for `station_distance_matrix`.

---

## 2. Canonical Target State

`01_canonical_foundation.sql` creates, in the `fat` domain, alongside the
prototype:

- **Rates:** `rates` (code/unit/active_version_id), `rate_versions`
  (append-only; `unique(rate_id, effective_from)` for unambiguous claim-date
  lookup) + deferred FK `rates.active_version_id → rate_versions`.
- **Operational layer:** `operational_claims` (core; `claim_type` CHECK
  `RC/RT/SB/MD/DM/SM`; immutable snapshot columns; `parent_claim_id` /
  `copy_source_owner_id` informational) + 6 1:1 detail tables
  (`recall/retain/standby/muster_dismiss/delayed_meal/spoilt_meal_details`).
- **Entitlement layer:** `claim_entitlements` (homogeneous; `generated_*` +
  `edited_*` + `manual_override`; `rule_id/rule_version/rule_explanation/
  formula_explanation`; `rate_id/rate_version_id/rate_snapshot`; stream
  `payment_method`/`payment_status`).
- **Travel reference:** `station_distance_matrix` (km), `station_time_matrix`
  (hours) — directed PK `(from_station_id, to_station_id, matrix_version)`.
- **Payment/reconciliation:** `payment_records`, `entitlement_payment_links`
  (N:M; `link_kind` CHECK), `reconciliation_audit` (append-only).
- **Indexes (13):** owner/date, type/date, partial parent, rate effective,
  entitlement claim/owner-paystatus/type, both link FK directions, payment
  owner/stream/date, audit entitlement/time.
- **Triggers:** `set_updated_at` on `operational_claims`, `claim_entitlements`.
- **RLS:** enabled on all 15; `authenticated_read` + `service_role_manage` on
  the 4 shared-reference tables; `users_manage_own` on owner tables
  (detail tables scoped via join to `operational_claims.owner_id`; links via
  `claim_entitlements.owner_id`; audit via `actor_id`).
- **Grants:** SELECT/INSERT/UPDATE/DELETE to `authenticated, service_role`.

`02_entitlement_amount_nullable.sql`: `alter ... generated_amount drop not null`
(enables hours-first rows). **Depends on `01` having created the table.**

`03_standby_platoon.sql`: `add column if not exists platoon` on `fat.standby` —
**already live**; no-op.

This file set verifies fully against `DATABASE_ARCHITECTURE_v1.0.md` /
`REBUILD_AUDIT §Already created by 01_canonical_foundation.sql` — column-for-column
parity with the documented Layer A–E target, and the three-layer separation is
preserved (no payment columns on operational tables; no computed amounts on the
operational layer).

---

## 3. Deployment Readiness Assessment

| Dimension | Verdict | Evidence |
|---|---|---|
| **Idempotency** | ✅ Safe to replay | Every CREATE uses `IF NOT EXISTS`; policies in guarded `DO`/`pg_policies` checks; deferred FK guarded by `pg_constraint` check; triggers `drop ... if exists` then recreate. |
| **Additivity / non-destructive** | ✅ No drops, no data loss | No `DROP`/`TRUNCATE`; only `CREATE ... IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`. |
| **Runtime safety on activation** | ✅ **Breaks zero running code** | New profile/station columns are all nullable (existing INSERTs via `handle_new_user` use explicit columns); app never references canonical tables; new RLS only affects new tables. |
| **FK/type integrity** | ✅ | `stations.id` integer & `profiles.id` uuid match all canonical FK column types. |
| **Function/extension deps** | ✅ | `fat.set_updated_at()` present; `gen_random_uuid()` available. |
| **Dependency order** | ⚠️ Enforce | `02` references `fat.claim_entitlements` → **must run after `01`**. Running `02` first errors. `03` is order-independent and already live. |
| **Migration tracking** | ⚠️ Recommend `apply_migration` | Files are raw SQL not in migration history; apply via tracked migrations so DEV history records them and PROD promotion can replay cleanly. |
| **Seed completeness** | ⚠️ Gap | Tables ship empty. `rates`/`rate_versions` and `station_time_matrix` need seeding before the engine can generate (see §5.4). `station_distance_matrix` has no source. |

**Overall: GREEN to activate the schema.** It is a low-risk, additive, idempotent
deployment. The risk lives entirely in the *cutover* (code), not the activation.

---

## 4. Cutover Risks

1. **Ordering trap (02 before 01).** `02` fails standalone. Always `01 → 02`.
   Mitigation: single ordered migration run; verify table exists between steps.
2. **`station_time_matrix` direction expansion.** Source cells are upper-triangle
   only (a<b). A directed lookup `(from,to)` will miss half its pairs unless seed
   inserts both directions (→ 6642 rows) or the resolver symmetrises. Decide
   before seeding (recommend insert both directions; matrix is symmetric).
3. **`station_distance_matrix` has no data.** Recall uses Google live, so this is
   not a Phase-1 blocker, but the canonical Standby km field stays empty until a
   source is defined. Don't let downstream code assume it's populated.
4. **Matrix unit ambiguity.** `value` max 555 under a "hours" label needs
   confirmation before it drives a payable quantity (hours-first entitlements).
5. **Rates cutover removes per-user overrides.** Canonical `rates`/`rate_versions`
   are global; `fat.user_rates` (1 row) and the Settings override UI must become
   admin-only writes. Behaviour change for users — surface in the rewrite.
6. **`manual_override` is an app-maintained mirror** (no trigger). The writer
   must set it whenever `edited_*` is set, or reconciliation/override invariants
   drift.
7. **PROD divergence.** PROD is half-migrated (legacy `public.fat_*` + empty
   `fat.*` + no travel tables). This plan is **DEV-only**; PROD needs its own
   rebaseline before any canonical promotion.
8. **Three-layer violation regressions.** During cutover, any code that writes
   `payment_status` onto an operational/detail row (the prototype habit) violates
   the separation. Reconciliation state lives only on `claim_entitlements` +
   `payment_records`/links/audit.
9. **Snapshot immutability.** The new engine and reconciliation helpers must
   never rewrite `generated_*`/`rule_*`/`rate_*` after creation.
10. **RLS regression on activation.** The DEV backup table has RLS off; unrelated
    but should be fixed in the same hygiene pass so the activation doesn't ship
    next to a known-exposed table.

---

## 5. Required Migration Steps (DEV)

> Planning only — do not execute. Each step is a discrete, verifiable unit.

### 5.1 Pre-flight (read-only)
- Snapshot current `fat` table list + `pg_policies` + `profiles`/`stations`
  columns (baseline for rollback diffing).
- Confirm `fat.set_updated_at()` and `gen_random_uuid()` (done — present).

### 5.2 Apply `01_canonical_foundation.sql`
- Apply as tracked migration `canonical_01_foundation` (MCP `apply_migration`
  or `supabase db push`). Additive; idempotent.
- **Gate:** all 15 tables present; 13 indexes present; 2 triggers present; RLS
  enabled on all 15; policy count matches (4 shared ×2 + 11 owner ≈ 19);
  `profiles` gains 5 cols, `stations` gains `lat`/`lng`.

### 5.3 Apply `02_entitlement_amount_nullable.sql`
- Apply as `canonical_02_entitlement_amount_nullable`, **after 01**.
- **Gate:** `claim_entitlements.generated_amount` is nullable.
- (`03` — skip; already live. Replay is harmless if included for completeness.)

### 5.4 Seed (separate migration `canonical_04_seed`)
- **`rates` + `rate_versions`** from `lib/calculations/defaultRates.js`
  `DEFAULT_RATES` (km $1.20, small meal $10.90, large meal $20.55), one
  `rate_versions` row each with `effective_from` ≤ earliest claim date; set
  `rates.active_version_id`. *Blocks the entitlement engine* (every entitlement
  needs a `rate_version_id`).
- **`station_time_matrix`** from `travel_matrix_cells`: map
  `station_a_id→from`, `station_b_id→to`, `value→hours`,
  `version_id::text→matrix_version`; **insert both directions** (decision per
  §4.2).
- **`station_distance_matrix`** — leave empty (no source; Recall stays on Google).

### 5.5 Verification gate (before any code cutover)
- Migration replays cleanly against a fresh project (idempotency proof).
- Authenticated owner-scoped smoke test: a user can CRUD their own
  `operational_claims`/`claim_entitlements`; cannot see another owner's.
- Existing app still builds and boots on the **unchanged prototype tables**
  (this must remain true through Phase 2).

### 5.6 Hygiene (parallel, same window)
- `ENABLE ROW LEVEL SECURITY` on `fat.profile_ext_label_backup_20260518`.
- Fold `friend_requests`/`friendships`/`claim_replication_events` into
  version-controlled SQL.
- Decide fate of the phantom `payment_components` write.

---

## 6. Code Refactor Requirements

**Schema activation requires zero code change** — the app keeps running on the
prototype. The refactor below is what is needed to *run on* canonical (Phase 3
cutover). Sourced from `REBUILD_AUDIT §Layer G/H`; verified against current code.

| Module | Action | Why |
|---|---|---|
| `lib/calculations/RatesContext.js` | **Rewrite** | `fat.user_rates` read/write → read-only `fat.rates`+`fat.rate_versions`. |
| `lib/calculations/defaultRates.js` | **Repurpose** | becomes `rates` seed + Rates-admin UI metadata. |
| `lib/fat/engine/*` | **Wire + complete** | currently unwired; complete `recall/retain/spoilt/delayed` generators (`return []` today); Standby/M&D done. Emit `claim_entitlements` rows w/ `rule_*`/`rate_*`. |
| `lib/fat/models/*` | **Adopt** | typed shapes are correct; start importing them at runtime. |
| `lib/distance/*` | **Restructure** | split into Google-only (Recall km) + Matrix-only (SB/MD hours) resolvers; stop reading `home_address`/`station_distances`/`distance_cache`. |
| `lib/claims/ClaimsContext.js` | **Rewrite (largest)** | replace `getAutoChildDefinitions`/`createClaimGroup`/`increment_claim_sequence` with 1 `operational_claims` + 1 detail + N `claim_entitlements` writes. |
| `lib/claims/claimTypes.js` | **Replace** | `CLAIM_TABLES`/discriminators → 6-type enum + 1:1 detail map. |
| `lib/reconciliation/{reconciliationUtils,filterUtils,exportUtils}.js` | **Rewrite** | cannot be patched into the contract (`RECONCILIATION_STATE_ARCHITECTURE §9/§10.3`); rebuild on records+links+audit, stream-scoped status, date-range scope. |
| `lib/fy/FinancialYearContext.js` | **Drop** | no FY concept in canonical. |
| `app/{new-claim,dashboard,settings,tax,profile}` | **Rewrite** | consume the new services; UI last. |
| `app/api/travel/google/route.js`, `lib/supabaseClient.js`, `lib/platoon/*` | **Keep** | correct as-is. |

---

## 7. Recommended Phase 1 Execution Plan (smallest path to a live canonical foundation)

Goal: canonical schema live in DEV, app still running, foundation ready for the
engine — **without touching the prototype runtime.**

1. **Apply `01` then `02`** as tracked migrations (skip `03`, already live). Run
   the §5.5 verification gate.
2. **Hygiene pass** (§5.6) in the same window.
3. **Seed `rates`+`rate_versions`** from `DEFAULT_RATES`; build a read-only
   `useRates()` against the new tables (does not replace `RatesContext` yet —
   parallel, behind a flag/new hook).
4. **Seed `station_time_matrix`** (direction-expanded) so the Matrix resolver has
   data when Phase 2 starts.
5. **Stop.** Do not cut over claim writes yet. Exit criteria: 15 tables + seeds
   live, RLS smoke test green, app unchanged and booting on prototype.

This is hours-to-a-day of work, fully reversible (additive), and unblocks every
subsequent phase.

---

## 8. Ranked Implementation Sequence (leverage-ordered)

1. **Apply `01` → `02`** (foundation). *Unblocks everything; near-zero risk.*
2. **Seed `rates`/`rate_versions`** + read-only `useRates()`. *Engine prereq.*
3. **Seed `station_time_matrix`** (direction-expanded). *Travel prereq.*
4. **Wire + complete the entitlement engine** → persist `operational_claims` +
   details + `claim_entitlements`. *Creates the stable-ID entitlement layer all
   reconciliation depends on.*
5. **Split travel resolvers** (Google=Recall, Matrix=SB/MD).
6. **Rewrite the claim writer** (`ClaimsContext`) onto canonical; drop FY.
7. **Build the reconciliation surface** (records+links+audit, §9 helpers,
   stream status). *Payroll verification lands here.*
8. **Rewrite UI** (`new-claim/dashboard/settings/tax/profile`).
9. **Drop prototype tables** (separate approval-gated PR).
10. **PROD rebaseline + promotion**; later: payslip OCR ingestion, sharing layer.

---

## 9. Caveats
- Live findings verified via Supabase MCP against DEV `kctctvpobbizhkiqkgqw` on
  2026-06-01. PROD inspected for divergence only.
- No schema or code was changed; nothing was deployed.
- Citations are from the `dev` working tree and live introspection at audit time.
