# Fire Allowance Tracker — Canonical Rates & Matrix Seed: Verification Report

Version: v1.0
Status: **SEEDED & VERIFIED**
Date: 2026-06-01
Branch: `dev`
Target DB: DEV `kctctvpobbizhkiqkgqw` (region ap-southeast-2)
Out of scope (untouched): PROD `wgcqzamuspuqpedqasbc`

Companion to [CANONICAL_ACTIVATION_PLAN_v1.0.md](CANONICAL_ACTIVATION_PLAN_v1.0.md)
and [CANONICAL_ACTIVATION_POSTDEPLOY_REPORT_v1.0.md](CANONICAL_ACTIVATION_POSTDEPLOY_REPORT_v1.0.md).

> Scope executed: seed canonical **rates/rate_versions** and the **station
> distance matrix** only. No entitlement-engine wiring, no claim-flow changes,
> no reconciliation, no OCR, no prototype-table removal. Additive + idempotent.

---

## 0. Headline — the matrix-unit concern is RESOLVED (and inverts the plan)

The activation plan §4.4/§5.4 flagged that `fat.travel_matrix_cells.value`
(max **555**) under a "hours" label needed confirmation before driving a payable
quantity, and instructed seeding `fat.station_time_matrix` (hours) from it.

**Live introspection falsifies the "hours" assumption. The loaded matrix is
KILOMETRES.** Evidence:

| Signal | Value |
|---|---|
| `fat.travel_matrix_versions.unit` (only active version) | **`km`** (authoritative) |
| version label | `FRV Index (km) - 1W (2026-05 import)` |
| source file | `index-km-1w.csv` |
| Eastern Hill → Carlton (adjacent inner-Melbourne) | `2` (≈ 2 km ✓; 2 hours absurd) |
| Eastern Hill → Mildura (Melbourne→Mildura) | `555` (≈ 550 km by road ✓; 555 h = 23 days) |
| parser hours ceiling (`parseMatrix.js maxValue=24`) | would have rejected 555 had it been hours |

**Consequence:** the loaded km data canonically belongs in
`fat.station_distance_matrix` (km), **not** `fat.station_time_matrix` (hours).
Seeding the hours table from km values would corrupt the engine's "FRV Matrix
Hours → Payable Bridge" (`claim_entitlements.generated_hours`). Accordingly:

- ✅ Seeded `fat.station_distance_matrix` (km) — direction-expanded, 6642 rows.
- ⛔ `fat.station_time_matrix` (hours) left **EMPTY** — no DB source exists. It
  requires the FRV **"Index (hr)"** sheet, which has never been imported. The
  engine's `excess_travel_standby` / `excess_travel_md` generators read this
  table, so they remain un-generatable until an hours matrix is imported.

This is the inverse of the plan's §4.3 assumption ("`station_distance_matrix`
has no source; seed `station_time_matrix`"). The deviation is evidence-driven
and honors canonical architecture (km→km, hours→hours).

---

## 1. What was seeded

Two tracked migrations applied to DEV via `apply_migration`, appended cleanly to
the migration history after `canonical_02`:

| # | Migration | Source file | Result |
|---|---|---|---|
| 04 | `canonical_04_seed_rates` | `supabase/canonical/04_seed_rates.sql` | ✅ |
| 05 | `canonical_05_seed_station_distance_matrix` | `supabase/canonical/05_seed_station_distance_matrix.sql` | ✅ |

### 1.1 Rates (5 rows in `fat.rates` + 5 in `fat.rate_versions`)

All versions: `version_label='initial-2025-06'`, `effective_from=2025-06-01`
(≤ earliest live claim `2026-05-29`, so every existing claim resolves to this
version). `active_version_id` set on all 5.

| code | display_name | unit | value | source |
|---|---|---|---|---|
| `travel_per_km` | Kilometre Rate | `dollars_per_km` | 1.2000 | `DEFAULT_RATES.kilometreRate` |
| `small_meal` | Small Meal Allowance | `dollars` | 10.9000 | `DEFAULT_RATES.smallMealAllowance` |
| `large_meal` | Large Meal Allowance | `dollars` | 20.5500 | `DEFAULT_RATES.largeMealAllowance` |
| `standby_hours` | Standby & Dismiss (fixed hrs) | `hours` | 0.5000 | engine fixture + payslip evidence † |
| `md_hours` | Muster & Dismiss (fixed hrs) | `hours` | 1.0000 | engine fixture + payslip evidence † |

Codes match the engine's `ctx.rateLookup(code, …)` calls
(`lib/fat/engine/generators/standby.js`, `musterDismiss.js`) so the lookups
resolve when the engine is wired.

† **`standby_hours` / `md_hours` are NOT in `DEFAULT_RATES`** — see §3.1.

### 1.2 Distance matrix (`fat.station_distance_matrix` — 6642 rows)

- Source: `fat.travel_matrix_cells` (3321 upper-triangle km cells, `a<b`).
- **Direction expansion:** each cell inserted both ways `(a→b)` and `(b→a)`
  → 3321 × 2 = **6642** directed rows. Self-pairs omitted (engine treats
  `from==to` as 0).
- `matrix_version` = source `version_id` cast to text
  (`ddc25da6-f36b-4f3d-80d5-c37ef7b85bef`) — stable + traceable.

---

## 2. Validation results (all gates pass)

| Gate | Expected | Observed | Verdict |
|---|---|---|---|
| `fat.rates` rows | 5 | 5 | ✅ |
| `fat.rate_versions` rows | 5 | 5 | ✅ |
| Rates with no `active_version_id` | 0 | 0 | ✅ |
| Dangling `active_version_id` FK | 0 | 0 | ✅ |
| Versions with `effective_from` > 2026-05-29 | 0 | 0 | ✅ |
| Units within CHECK enum | all | all (`dollars`/`dollars_per_km`/`hours`) | ✅ |
| `station_distance_matrix` rows | 2 × 3321 | 6642 | ✅ |
| `rows == 2 × source_cells` | true | true | ✅ |
| Self-pairs | 0 | 0 | ✅ |
| Negative km | 0 | 0 | ✅ |
| Asymmetric rows (a→b without matching b→a, equal km) | 0 | 0 | ✅ |
| PK duplicates `(from,to,version)` | 0 | 0 | ✅ |
| Matrix station-id FK orphans (both directions) | 0 | 0 | ✅ |
| `station_time_matrix` rows | 0 (no source) | 0 | ✅ |
| Idempotency replay (rates/versions/matrix counts) | unchanged | 5 / 5 / 6642 | ✅ |

---

## 3. Assumptions & unresolved data issues (for user confirmation)

### 3.1 `standby_hours` / `md_hours` were sourced outside `DEFAULT_RATES`
The two implemented engine generators require fixed-hours rate codes that are
**absent from the approved `DEFAULT_RATES` object**. Their values were taken from
two corroborating in-repo sources and seeded so the engine is wireable:
- `lib/fat/engine/validateDrafts.js` fixtures: `standby_hours=0.5`, `md_hours=1.0`.
- Payslip evidence in `defaultRates.js`: `Standby&Dismi 0.50 h = $50.51`;
  `Muster&Dismis 1.00 h = $101.02`.

**Action:** ratify 0.5 h / 1.0 h as the canonical fixed-hours values (and their
2025-06-01 effective date). If wrong, they are trivially re-seedable in DEV.

### 3.2 `RETAIN_OVERTIME_HOURLY_RATE` ($101.0225/h) has no canonical home
The hours→dollars bridge constant (`defaultRates.js`, EBA cl. 128.5) is **not
seeded**: no generator looks it up by `code`, and the `fat.rates.unit` CHECK enum
(`dollars`/`dollars_per_km`/`hours`) has **no `dollars_per_hour`** member.

**Action:** decide how the bridge rate is represented — extend the unit enum
with `dollars_per_hour` and add a `retain_overtime_hourly` rate, or keep it as a
code constant the engine multiplies. Blocks the hours→payable conversion for
retain / standby_dismi / md_hours entitlements.

### 3.3 `station_time_matrix` (hours) has no source
The engine's `excess_travel_*` entitlements read `station_time_matrix`, but only
the **km** matrix was ever imported. **Action:** import the FRV "Index (hr)"
sheet into a new `travel_matrix_versions` row (`unit='hours'`) and seed
`station_time_matrix` from it, or decide excess-travel is km-derived and rework
the generators. Until then, SB/MD excess-travel cannot generate.

### 3.4 `matrix_version` key shape
Seeded as the source `version_id` UUID (text). The engine's `matrixLookup(from,
to, matrix_version)` takes whatever the (not-yet-built) claim writer stamps onto
`*_details.matrix_version`. If a human-readable label is preferred, re-key here
and in the writer consistently.

### 3.5 `station_distance_matrix` vs the plan's table choice
Seeding `station_distance_matrix` instead of `station_time_matrix` is a
deliberate, evidence-driven deviation from plan §5.4 (see §0). Non-destructive
and reversible (`truncate fat.station_distance_matrix` in DEV).

---

## 4. Existing-application integrity

- **Prototype tables unchanged** (post-seed = post-deploy baseline): recalls 6,
  retain 8, standby 0, spoilt_meals 5, claim_groups 6, user_rates 1, profiles 2,
  stations 82, travel_matrix_cells 3321.
- **No runtime reads the seeded tables.** Grep of `app/` + `components/` for
  `station_distance_matrix` / `station_time_matrix` / `fat.rates` /
  `fat.rate_versions` = 0 hits. The only references are in `lib/fat/models/*`
  and `lib/fat/engine/*` (unwired scaffolding). App behavior is unchanged.
- **Security advisors:** no seeded table appears in any lint. All findings are
  pre-existing (backup-table RLS, friend-request `SECURITY DEFINER` RPCs,
  `extension_in_public`, leaked-password) and unrelated to this seed.

---

## 5. Outcome

**SUCCESS.** Canonical rates (5 codes, version-pinned, active-linked) and the
station **distance** matrix (6642 directed km rows, symmetric, FK-clean) are
seeded, validated, and idempotent in DEV. The matrix-unit concern is resolved:
the loaded matrix is km, seeded to `station_distance_matrix`;
`station_time_matrix` (hours) is intentionally empty pending an hours import.

**Ready for engine integration with three documented prerequisites** (§3.1–§3.3):
ratify the fixed-hours rates, decide the hours→dollars bridge representation, and
provide an hours matrix source. None were in scope here.

### Not done (by scope)
- No entitlement-engine wiring; no claim-writer cutover.
- No `station_time_matrix` seed (no hours source).
- No `RETAIN_OVERTIME_HOURLY_RATE` seed (no enum home).
- No reconciliation / OCR; no hygiene fixes; PROD untouched.
