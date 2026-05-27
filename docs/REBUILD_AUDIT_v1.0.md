# Fire Allowance Tracker — Canonical Rebuild Audit

Version: v1.0
Status: Draft — Phase 0 audit output
Last Updated: 2026-05-26
Branch: `dev`

Companion to [REBUILD_PLAN_v1.0.md](REBUILD_PLAN_v1.0.md). The plan is the
change-control record for the rebuild itself. This document is the audit
report behind it — the current-vs-target gap analysis across every major
subsystem, and the sequencing rationale for the phased plan.

---

## Canonical Source Set

The rebuild target is fixed by these six docs in the governance-system repo
(`C:\Users\Admin\Apps\governance-system\chatgpt-project-sources\fire-allowance-tracker\`):

- `ALLOWANCE_ARCHITECTURE_v1.0.md` — subsystem map, layered concepts, travel-source scope per claim type
- `DATABASE_ARCHITECTURE_v1.0.md` — canonical table shape, ownership, RLS, immutability rules
- `ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md` — the operational/entitlement/payment three-layer model and its rationale
- `CLAIM_TYPES_v1.0.md` — catalogue of top-level claim types (RC/RT/SB/MD/DM/SM) post-split
- `ENTITLEMENT_RULES_v1.0.md` — entitlement generation principles, override rules, FRV matrix hours→payable bridge
- `PAYMENT_RECONCILIATION_v1.0.md` — stream-scoped status model, audit trail, payment_method routing

All open architecture questions (status enums, matrix table merge, FRV
version pinning, soft-delete, FK enforcement on `parent_claim_id`, etc.)
are intentionally NOT pre-decided here — see § Open Questions below.

---

## Rebuild Premise

- App is NOT live. No production users, no production data.
- `fat.*` dev/test data is disposable; no backwards-compatible migration is
  required.
- Bounded domain remains `fat.*`. Cross-domain reads/writes stay out of
  scope.
- Auth surface is stable and must remain so:
  - `auth.users` is the only acceptable cross-app dependency.
  - `fat.profiles` + `on_auth_user_created_fat` + `fat.handle_new_user()`
    must not be disturbed.

---

## Canonical Principles (gap audit lens)

The audit measures each subsystem against these six principles. If a
subsystem violates one, it cannot be migrated as-is — it must be replaced
or restructured.

1. **Three-layer separation.** Operational Claims, Generated Entitlements,
   and Payment / Reconciliation State are distinct tables. Payment status
   never lives on an operational claim row.
2. **Heterogeneous operational claims, homogeneous entitlements.** One
   `operational_claims` core + 1:1 `*_details` per claim type. A single
   `claim_entitlements` table covers every entitlement type.
3. **Static accounting records.** Generated amounts, rate snapshots, rule
   identifiers, and station snapshots are immutable post-creation. Manual
   overrides land in sibling `edited_*` columns; the engine never rewrites
   history.
4. **Global rates, append-only versions.** `fat.rates` + `fat.rate_versions`
   are the source of truth at generation time only. Per-user rate overrides
   are not part of the canonical model.
5. **Travel-source scope.** Recall = Google Maps (KM only); Standby = FRV
   Matrix only; Muster & Dismiss = FRV Matrix only; manual override always
   available. Matrix Index returns decimal hours in 0.25-hour increments;
   the engine uses those hours directly as the canonical payable quantity
   on hours-first entitlements (see § Open Architecture Questions item 3 —
   resolved 2026-05-26).
6. **Stream-scoped payment status.** `payment_status` is scoped by
   `payment_method`: payslip → `pending|paid`; petty_cash →
   `outstanding|claimed`. Reconciliation actions append to
   `reconciliation_audit` and never mutate snapshot fields.

---

## Current vs Target — Layer-by-Layer Gap

### Layer A: Identity + Reference Data

| Concern | Current | Target | Gap |
|---|---|---|---|
| Auth integration | `auth.users` → `fat.profiles` via `on_auth_user_created_fat` trigger | Unchanged | **None.** Keep verbatim. |
| Profile identity | `fat.profiles(id, email, first_name, last_name)` | Extend with `display_name`, `rostered_station_id`, `home_location_label`, `home_lat`, `home_lng` | **Additive only.** Already drafted in `01_canonical_foundation.sql`. |
| Profile operational data | `fat.profile_ext(user_id, station_id, rostered_station_label, platoon, pay_number, home_address, home_dist_km)` | Moved onto `fat.profiles`; some fields (platoon, pay_number) have no canonical home yet | **Conflict.** `rostered_station_label` is write-only per the established rule; `home_address` + `home_dist_km` are superseded by `home_location_label` + `home_lat/lng`. `platoon` and `pay_number` are unmapped — need a canonical decision before retirement. |
| Stations | `fat.stations(id, name, abbreviation, region, is_active, ...)` | Extend with `district`, `street_address`, `lat`, `lng` | **Additive only.** Already drafted. |
| Station aliases | `fat.station_aliases` | No canonical equivalent | **Keep as operational helper.** Not in conflict. |
| FRV matrix storage | `fat.travel_matrix_versions` + `fat.travel_matrix_cells` (single value column, version helper table) | `fat.station_distance_matrix` + `fat.station_time_matrix` (`matrix_version text` PK component) | **Replace.** Canonical splits distance from hours; canonical names the matrices differently; canonical drops the version-helper table. Existing cells store *hours* (per `fat.travel_matrix_cells.unit='hours'`) — they will repopulate `station_time_matrix`. `station_distance_matrix` has no source data yet. Both canonical tables already created in `01_canonical_foundation.sql`. |

### Layer B: Operational Claims

| Concern | Current | Target | Gap |
|---|---|---|---|
| Claim core row | None — every claim type is its own table | `fat.operational_claims(id, owner_id, claim_type, claim_date, station_id_snapshot, station_name_snapshot, source_calculation_mode, status, generated_at, notes, parent_claim_id, copy_source_owner_id)` | **Create.** Already drafted in `01_canonical_foundation.sql`. |
| Claim type discrimination | `fat.recalls`, `fat.retain`, `fat.standby` (with `standby_type` discriminating SB vs M&D), `fat.spoilt_meals` (with `meal_type` discriminating Spoilt vs Delayed) | One detail table per type: `recall_details`, `retain_details`, `standby_details`, `muster_dismiss_details`, `delayed_meal_details`, `spoilt_meal_details` | **Replace.** Per `CLAIM_TYPES_v1.0.md`, M&D is a top-level claim type (post commit `902be2b`) and Spoilt/Delayed split into two detail tables. Discriminators inside one table are explicitly rejected by the canonical model. |
| Per-claim computed amounts | Operational tables hold `travel_amount`, `mealie_amount`, `total_amount`, `adjusted_amount`, `rates_snapshot`, `calc_snapshot`, `calculation_inputs` | All entitlements (incl. computed amounts and rate snapshots) live on `fat.claim_entitlements` | **Conflict.** Computed amounts conflate the operational layer with the entitlement layer. Must be removed when the operational tables are retired. |
| Per-claim payment columns | `payment_status`, `payment_date`, `payment_method`, `parent_status` on each operational table | Payment state lives on `claim_entitlements` (per entitlement) and `payment_records`/`entitlement_payment_links` (per real-world payment) | **Conflict.** Three-layer violation. Hard remove during Phase 3 cutover. |
| Parent–child claim modelling | `fat.claim_groups` + every claim row carries `claim_group_id`; child rows are auto-inserted into the *same* type table as the parent (e.g. a "callback_ops" child written back into `fat.recalls` with `autoChild` tagged in `calculation_inputs`) | One `operational_claims` row per real-world event; entitlements (children) live in `claim_entitlements`, not in the operational tables | **Replace.** Parent–child-via-same-table is the most invasive prototype pattern. Every `getAutoChildDefinitions` call site in `lib/claims/ClaimsContext.js` must be rewritten against `claim_entitlements`. |
| FY workspaces | `fat.financial_years` per-user with `is_active`; every claim row has `financial_year_id`; `loadClaims` filters by active FY | No FY workspace concept; date-range filters only (`claim_date`) | **Drop entirely.** Non-canonical. Tax exports and reconciliation views must move to date-range filtering. |
| Claim sequencing | `fat.claim_sequences` per `(user, fy, claim_type)` issuing integer claim numbers via the `fat.increment_claim_sequence` RPC | No canonical claim-number concept; entitlements identified by `id` and rendered via `rule_id` / labels | **Drop.** Display labels (`buildClaimLabel`) become a UI concern; sequencing is not part of the rebuild target. |
| Sharing | None. `parent_claim_id` exists only on operational tables to link auto-children to their parent group, *not* for cross-user copies | First-class copy-on-write via `parent_claim_id` + `copy_source_owner_id` on `operational_claims` (informational; no FKs by default) | **Add.** Drafted on `operational_claims`. Mechanics deferred to a later phase; schema is forward-compatible. |

### Layer C: Entitlements

| Concern | Current | Target | Gap |
|---|---|---|---|
| Entitlement table | None. Entitlements are emulated as additional rows in the operational tables tagged with `autoChild` in `calculation_inputs` | `fat.claim_entitlements` — homogeneous, one row per entitlement, regardless of parent claim type | **Create.** Already drafted. |
| Generated amount + manual override | `total_amount` vs `adjusted_amount` on operational rows | `generated_amount`, `generated_hours` (snapshot, immutable) + `edited_amount`, `edited_hours`, `edited_note`, `manual_override` (mirror) on `claim_entitlements`; effective payable = `COALESCE(edited_amount, generated_amount)` | **Replace.** `effectivePayable` helper already lives at [lib/fat/models/entitlementHelpers.js](lib/fat/models/entitlementHelpers.js). |
| Rule provenance | `calculation_inputs` jsonb on operational rows holds `autoChild` slugs (`callback_ops`, `excess_travel`, `petty_cash_meal`, `standby_and_dismi`, `md_event`, …); no rule version | `rule_id`, `rule_version`, `rule_explanation`, `formula_explanation` columns on every entitlement row | **Replace.** Canonical demands stable, queryable rule provenance. Map prototype `autoChild` slugs → canonical `rule_id` values as part of the engine rewrite. |
| Rate snapshotting | `rates_snapshot` jsonb on each operational row at save time (`createRateSnapshot()` in [lib/calculations/engine.js](lib/calculations/engine.js)) | `rate_id` + `rate_version_id` + `rate_snapshot` jsonb on every entitlement; rate value frozen at generation; historical entitlements NEVER re-query `fat.rates` | **Restructure.** Move snapshot from claim to entitlement; tie to `rate_versions` row id, not free-form jsonb. |
| Entitlement catalogue | Implicit in autoChild slugs (Callback-Ops, Excess Travel, Standby&Dismi, M&D, Small Meal Allowance, Maint Stn N/N, Overnight Cash) | `entitlement_type` text column (catalogue still being codified in `ENTITLEMENT_RULES_v1.0.md`) | **Conflict-free; defer.** Keep canonical column as `text` until catalogue stabilises (per `01_canonical_foundation.sql` comment). |

### Layer D: Rates

| Concern | Current | Target | Gap |
|---|---|---|---|
| Rate source of truth | `fat.user_rates` per-user overrides over the three canonical editable rates (`kilometre_rate`, `small_meal_allowance`, `large_meal_allowance`); double/spoilt/delayed/standby-night meals are derived or sourced from `smallMealAllowance` at calculation time, and overnight cash is captured per-claim — see [lib/calculations/defaultRates.js](lib/calculations/defaultRates.js) (canonical `DEFAULT_RATES` + `RATE_FIELDS`) | `fat.rates` (global codes) + `fat.rate_versions` (append-only, `effective_from`); UI surfaces global rates only | **Replace entirely.** Per-user rate overrides are not in the canonical model. Settings UI becomes admin-only writes to `rate_versions`; users no longer override rates. The canonical-rate refactor (post-PR) means there are now only three editable values to migrate. |
| Rate evolution | Single mutable row per user, updated in place | Append-only `rate_versions`; new claim picks the row where `effective_from <= claim_date` and no later version exists | **Replace.** "Forward-only" enforcement must move into the application layer (or a `BEFORE UPDATE` trigger on `rate_versions` later). |
| Rate field metadata | `RATE_FIELDS` in [lib/calculations/defaultRates.js](lib/calculations/defaultRates.js) — drives Settings UI labels + help text | No canonical equivalent; UI concern only | **Retain as UI metadata.** Migrate to drive the new Rates admin page. |
| Open unresolved rates | Delayed meal value vs `smallMealAllowance` UNRESOLVED, Standby-night meal value vs `smallMealAllowance` UNCONFIRMED, `retainAllowancePerHour` unresolved | Same gaps; canonical does not resolve them | **Carry forward.** These remain `TODO` in `ENTITLEMENT_RULES_v1.0.md`. The runtime now sources both Delayed and Standby-night meal amounts from the canonical `smallMealAllowance` until distinct EA values are confirmed — at which point new canonical rates (not the removed legacy keys) would be introduced. |

### Layer E: Payment / Reconciliation

| Concern | Current | Target | Gap |
|---|---|---|---|
| Payment status model | Single `payment_status text` per operational row (`Pending\|Paid\|null`); `parent_status` cached on `fat.claim_groups`; aggregations done client-side in [lib/reconciliation/reconciliationUtils.js](lib/reconciliation/reconciliationUtils.js) (`deriveGroupPaymentStatus`, `calcNormalizedSummary`) | Per-entitlement `payment_method` (`payslip\|petty_cash`) + stream-scoped `payment_status` (payslip → `pending\|paid`; petty_cash → `outstanding\|claimed`) | **Replace.** Stream-scoped statuses must be threaded through every reconciliation surface. |
| Payment records | None — there is no separate "real-world payment line" table. A payment is recorded by toggling `payment_status` on the operational row | `fat.payment_records` (stream, record_date, reference, gross_amount, raw_payload, source) | **Create.** Already drafted in `01_canonical_foundation.sql`. |
| Entitlement ↔ payment link | None. The toggle is one-to-one with the operational row | `fat.entitlement_payment_links` N:M with `allocated_amount`, `link_kind` (`auto_match\|manual\|discrepancy_note`) | **Create.** Already drafted. |
| Audit trail | None. Payment-status mutations leave no log | `fat.reconciliation_audit` append-only (entitlement_id, actor_id, action, prior_status, new_status, reason, automated) | **Create.** Already drafted. Reconciliation actions MUST NOT mutate `generated_amount`, `rate_snapshot`, `rule_id`, `rule_version`. |
| Payment-method routing on creation | Standby auto-children currently set `payment_method` at creation; Recall/Retain children don't — intentional per the 2026-05 spec | Same asymmetry preserved on `claim_entitlements.payment_method` (`PAYMENT_RECONCILIATION_v1.0.md § Payment Method Routing`); MD/DM/SM TODO | **Carry forward.** Decision remains intentional. |
| Petty-cash export | `buildPettyCashReconciliationCSV` filtered by `payment_method='Petty Cash'`; column shape ad-hoc | Canonical export shape still TODO in `PAYMENT_RECONCILIATION_v1.0.md` | **Defer.** Keep current export shape during transition; reshape once canonical export columns are nailed down. |

### Layer F: Travel / Distance

| Concern | Current | Target | Gap |
|---|---|---|---|
| Recall travel | `lib/distance/stationDistance.js` + `app/api/travel/google/route.js` (Google API w/ OSRM fallback, server-side; rate-limited; auth-gated) | Recall = Google Maps (KM only; no reimbursement wiring yet); the existing server route is correct in scope | **Keep.** Only server route in the codebase; correct architectural shape. |
| Standby travel | Currently also routes through Google + OSRM via `googleRouting.js`; some standby UI hits the matrix via `fat.travel_matrix_lookup` RPC | Standby = FRV Matrix ONLY. Never Google. | **Conflict (active).** Per the standing user feedback ([feedback_travel_scope](.claude/memory/feedback_travel_scope.md) — recorded canonical: Recall=Google, Standby/M&D=FRV matrix only), the Standby path must be untangled. Specifically: any Standby code path that calls `googleRouting.js` or the `/api/travel/google` route is in violation. |
| Muster & Dismiss travel | Inherits Standby plumbing (M&D rows live in `fat.standby`) | M&D = FRV Matrix ONLY | **Conflict.** Same as Standby. |
| FRV Matrix Index unit | `fat.travel_matrix_cells.unit='hours'` (per [project_frv_matrix_unit](.claude/memory/project_frv_matrix_unit.md)) | Hours stored as-is in `fat.station_time_matrix`; matrix output is the canonical payable quantity for Standby + M&D entitlements (`ENTITLEMENT_RULES_v1.0.md § FRV Matrix Hours → Payable Bridge`) | **Resolved 2026-05-26 — hours-first.** Matrix hours land directly on `claim_entitlements.generated_hours`; `generated_amount` is NULL for those rows. No implicit hours → dollars conversion at generation time. Architecture is unblocked; engine implementation remains a Phase 3 task. |
| Distance cache tables | `fat.distance_cache`, `fat.home_address`, `fat.station_distances` | Distances live on per-claim detail rows (`travel_distance_km`, `matrix_distance_km`, `matrix_hours`) and reference matrices; no per-user cache table | **Drop entirely.** Per-user distance caches conflate runtime concerns with persistence and are not part of the canonical model. `home_lat`/`home_lng` migrate onto `fat.profiles`. |
| Server routes | One: `app/api/travel/google/route.js` | Same posture: server-only secrets remain on the server; no new server routes unless required (per [project_no_server_routes](.claude/memory/project_no_server_routes.md)) | **No change.** |
| Station label shape | In-memory shape is `(station_id, bare_name)` from `fat.stations`; `rostered_station_label` is write-only ([project_station_label_canonical_shape](.claude/memory/project_station_label_canonical_shape.md)) | Identical | **Keep.** Do not reintroduce prefix-stripping. |

### Layer G: App Surface (Next.js)

| Surface | Files | Verdict |
|---|---|---|
| Auth pages | `app/login`, `app/signup`, `app/forgot-password`, `app/reset-password` | **Keep verbatim.** Auth surface is stable. |
| Profile page | `app/profile/page.js` | **Rewrite.** Currently reads `fat.profiles` + `fat.profile_ext` + `fat.home_address` + `fat.station_distances`; must collapse to the extended `fat.profiles`. |
| New-claim page | `app/new-claim/page.js`, `components/claims/ClaimForm.js`, `components/claims/ShiftPicker.js` | **Rewrite.** Drives `addClaim()` against operational tables. Becomes a 6-tab form (RC/RT/SB/MD/DM/SM) writing one `operational_claims` row + one detail row + N `claim_entitlements`. |
| Dashboard | `app/dashboard/page.js`, `components/dashboard/RecentActivitySection.js`, `components/dashboard/ReconciliationSummary.js`, `components/claims/ExpandableClaimList.js`, `components/claims/GroupedClaimList.js`, `components/claims/MarkPaidPayNumberModal.js` | **Rewrite.** Heavy coupling to the grouped/ungrouped split and to `payment_status`/`payment_method` columns on operational rows. |
| Settings (rates) | `app/settings/page.js` | **Rewrite.** Becomes a rate-versions admin page; user overrides go away. |
| Tax page | `app/tax/page.js` | **Rewrite.** Move from FY-scoped to date-range-scoped. |
| Paths page | `app/paths/page.js` | **Audit further.** Travel/distance utility surface. |
| Travel API route | `app/api/travel/google/route.js` | **Keep verbatim.** Correct in shape. |

### Layer H: Shared Utilities

| Module | Verdict |
|---|---|
| [lib/supabaseClient.js](lib/supabaseClient.js) | **Keep.** Schema-scoped `fat` client is the right access pattern. |
| [lib/fat/models/*](lib/fat/models/) | **Keep.** Eight JSDoc typedefs mirror canonical `DATABASE_ARCHITECTURE_v1.0.md`. `effectivePayable` + `isManualOverride` helpers are already correct. These are ahead of the schema, not behind. |
| [lib/calculations/engine.js](lib/calculations/engine.js) | **Rewrite.** Per-claim-type calc functions (`calcRecall`, `calcRetain`, `calcStandby`, `calcSpoiltMeal`) emit `total_amount`/`travel_amount` shaped for the operational tables. Replace with an entitlement-generator that emits `claim_entitlements` rows with `rule_id`/`rule_version`/`rate_snapshot`. |
| [lib/calculations/RatesContext.js](lib/calculations/RatesContext.js) | **Rewrite.** Currently reads/writes `fat.user_rates`. Becomes a read-only consumer of `fat.rates` + `fat.rate_versions`. |
| [lib/calculations/defaultRates.js](lib/calculations/defaultRates.js) | **Repurpose.** `DEFAULT_RATES` becomes the seed data for `fat.rates` + initial `fat.rate_versions`. `RATE_FIELDS` becomes the admin-UI metadata for the rates page. |
| [lib/calculations/validationScenarios.js](lib/calculations/validationScenarios.js) | **Audit further.** Test scenarios; may be reusable as a regression bench for the new engine. |
| [lib/claims/ClaimsContext.js](lib/claims/ClaimsContext.js) | **Rewrite.** Anchored on the grouped/ungrouped + per-table-claim prototype model. The single largest displacement. |
| [lib/claims/claimTypes.js](lib/claims/claimTypes.js) | **Replace.** `CLAIM_TABLES`/`resolveClaimTable`/discriminators encode the heterogeneous-table prototype. The canonical equivalent is a 6-claim-type enum with a 1:1 detail-table map. |
| [lib/reconciliation/reconciliationUtils.js](lib/reconciliation/reconciliationUtils.js) | **Rewrite.** Aggregations assume single `payment_status` per row + grouped/ungrouped split + FY-scoped input. Reshape to stream-scoped statuses + date-range scope + entitlement-centric aggregation. The `resolveChildLabel` helper is reusable as the source for canonical `entitlement_type` display names. |
| [lib/reconciliation/filterUtils.js](lib/reconciliation/filterUtils.js), [lib/reconciliation/exportUtils.js](lib/reconciliation/exportUtils.js) | **Rewrite.** Same reasons as above. CSV column shapes can carry over once stream-scoped statuses land. |
| [lib/distance/stationDistance.js](lib/distance/stationDistance.js), [lib/distance/googleRouting.js](lib/distance/googleRouting.js), [lib/distance/osrm.js](lib/distance/osrm.js), [lib/distance/photon.js](lib/distance/photon.js), [lib/distance/nominatim.js](lib/distance/nominatim.js), [lib/distance/distanceEstimator.js](lib/distance/distanceEstimator.js), [lib/distance/addressCache.js](lib/distance/addressCache.js), [lib/distance/stationParser.js](lib/distance/stationParser.js), [lib/distance/matrix/matrixClient.js](lib/distance/matrix/matrixClient.js), [lib/distance/matrix/parseMatrix.js](lib/distance/matrix/parseMatrix.js) | **Restructure.** Currently a flat lookup layer with caches keyed off `fat.station_distances` / `fat.home_address` / `fat.distance_cache`. Reshape into two narrowly scoped resolvers: one Google-only (Recall) and one Matrix-only (Standby + M&D). Manual override path stays available in both. |
| [lib/fy/FinancialYearContext.js](lib/fy/FinancialYearContext.js) | **Drop entirely.** FY workspace concept is not in the canonical model. |
| [lib/platoon/theme.js](lib/platoon/theme.js) | **Keep.** UI-only. |

---

## Existing Tables — Disposition Matrix

| Existing `fat.*` table | Canonical disposition | Notes |
|---|---|---|
| `auth.users` | Unchanged | Cross-app shared resource. |
| `fat.profiles` | **Keep + extend** | Add canonical columns in place. Trigger remains. |
| `fat.profile_ext` | **Retire** | Fields move onto `fat.profiles` or are dropped. `platoon` + `pay_number` need a canonical decision before removal. |
| `fat.stations` | **Keep + extend** | Add `district`, `street_address`, `lat`, `lng`. |
| `fat.station_aliases` | **Keep** | Operational helper, not in conflict. |
| `fat.travel_matrix_versions` | **Retire** | `matrix_version text` PK component on the canonical matrices replaces the helper table. |
| `fat.travel_matrix_cells` | **Migrate then retire** | Source for re-seeding `fat.station_time_matrix`. |
| `fat.financial_years` | **Drop entirely** | Non-canonical. |
| `fat.claim_sequences` | **Drop entirely** | Non-canonical. |
| `fat.claim_groups` | **Drop entirely** | Replaced by `fat.operational_claims` core. |
| `fat.recalls` | **Drop entirely** | Replaced by `fat.operational_claims` + `fat.recall_details` + `fat.claim_entitlements`. |
| `fat.retain` | **Drop entirely** | Same pattern. |
| `fat.standby` | **Drop entirely** | SB and MD split into separate detail tables. |
| `fat.spoilt_meals` | **Drop entirely** | DM and SM split into separate detail tables. |
| `fat.user_rates` | **Drop entirely** | Replaced by global `fat.rates` + `fat.rate_versions`. |
| `fat.home_address` | **Drop entirely** | `home_lat`/`home_lng` move onto `fat.profiles`. |
| `fat.distance_cache` | **Drop entirely** | Per-claim detail rows hold the snapshot. |
| `fat.station_distances` | **Drop entirely** | Same. |
| `fat.increment_claim_sequence()` RPC | **Drop** | Non-canonical (sequencing goes away). |
| `fat.travel_matrix_lookup()` RPC | **Reshape or drop** | Replaceable with direct SELECTs on the canonical matrices; keep only if measured useful after cutover. |
| `fat.handle_new_user()` + trigger | **Keep** | Auth seeding is correct. |
| `fat.set_updated_at()` + triggers | **Keep + extend** | Already attached to canonical tables in `01_canonical_foundation.sql`. |

Already created by `01_canonical_foundation.sql` (Phase 1 schema, alongside
prototype): `fat.rates`, `fat.rate_versions`, `fat.operational_claims`,
`fat.recall_details`, `fat.retain_details`, `fat.standby_details`,
`fat.muster_dismiss_details`, `fat.delayed_meal_details`,
`fat.spoilt_meal_details`, `fat.claim_entitlements`,
`fat.station_distance_matrix`, `fat.station_time_matrix`,
`fat.payment_records`, `fat.entitlement_payment_links`,
`fat.reconciliation_audit`.

---

## Phased Rebuild — Sequencing Audit

The phased plan in [REBUILD_PLAN_v1.0.md](REBUILD_PLAN_v1.0.md) §
"Phased Plan" is the change-control record. This audit confirms the
sequencing is correct and explains *why* each phase precedes the next.

### Phase 0 — Audit + Plan (in this PR)

- Read all six canonical docs.
- Land this audit and the rebuild plan.
- Open architecture questions catalogued, not pre-decided.

### Phase 1 — Canonical Foundation Schema (in this PR)

**Why first:** Service code cannot be written against tables that do not
exist. Canonical tables land *alongside* the prototype so the app keeps
booting throughout Phase 2 and the entitlement-engine prototyping.

Already implemented as [`supabase/canonical/01_canonical_foundation.sql`](../supabase/canonical/01_canonical_foundation.sql).
Idempotent, no drops, no data migration, RLS attached.

**Verification gate before Phase 2 starts:**
- Migration replays cleanly against a fresh Supabase project.
- All 15 new tables are present with the canonical column shape.
- RLS policies pass an authenticated-read / owner-scoped smoke test.
- The existing app continues to build and boot against the unchanged
  prototype tables.

### Phase 2 — Typed Models (in this PR)

**Why next:** Typed shapes pinned at the JS layer protect Phase 3 service
code from drift while the schema is still young. Already implemented as
`lib/fat/models/` — eight modules + `effectivePayable` / `isManualOverride`
helpers. No runtime behaviour change.

### Phase 3 — Service Migration (future PR; out of scope here)

**Why this order inside Phase 3** (top to bottom is the recommended
implementation sequence):

1. **Rates first.** Seed `fat.rates` + `fat.rate_versions` from
   `DEFAULT_RATES`. Build a read-only `useRates()` against the new tables.
   Rationale: every entitlement insert needs a `rate_version_id` to point
   at — no other service can land cleanly until rates exist.
2. **Entitlement generator next.** Rewrite [lib/calculations/engine.js](lib/calculations/engine.js)
   to emit `claim_entitlements` rows with `rule_id`, `rule_version`,
   `rule_explanation`, `formula_explanation`, `rate_id`, `rate_version_id`,
   `rate_snapshot`. Start with rules the canonical docs already specify:
   Recall travel/meal triggers, Standby split (Excess Travel +
   Standby&Dismi + Small Meal). Defer Relieving Allowance, Delayed Meal,
   Spoilt Meal rules until canonical TODOs are resolved. Use
   `lib/calculations/validationScenarios.js` (or a new test bench) as a
   regression gate.
3. **Travel resolvers third.** Split [lib/distance](lib/distance) into two
   scoped resolvers — Google-only for Recall (km), Matrix-only for Standby +
   M&D (hours). The Matrix resolver returns decimal hours verbatim; the
   entitlement generator writes them straight onto
   `claim_entitlements.generated_hours` (hours-first per the resolved
   architecture decision — no hours → $ conversion at generation time).
   Retire `fat.distance_cache`, `fat.home_address`,
   `fat.station_distances` once the resolvers no longer read them.
4. **Claim writer fourth.** Rewrite [lib/claims/ClaimsContext.js](lib/claims/ClaimsContext.js)
   to write one `operational_claims` row + one detail row + N
   `claim_entitlements` per claim. Drop `getAutoChildDefinitions` /
   `createClaimGroup` / `getNextClaimNumber`. Sharing (copy-on-write) stays
   off the critical path — schema already supports it.
5. **Reconciliation surface fifth.** Rewrite
   [lib/reconciliation/reconciliationUtils.js](lib/reconciliation/reconciliationUtils.js)
   + filter/export utilities to read `claim_entitlements` + join
   `payment_records` via `entitlement_payment_links`. Switch the status
   model to stream-scoped (`payslip` → `pending|paid`, `petty_cash` →
   `outstanding|claimed`). All status mutations append to
   `reconciliation_audit` and never touch `generated_*` / `rate_*` /
   `rule_*` fields.
6. **UI surface last.** Rewrite `app/new-claim`, `app/dashboard`,
   `app/settings`, `app/tax`, `app/profile` against the new services. UI
   is last because every page consumes one or more of the services above;
   pulling UI forward risks rework.
7. **Drop prototype tables.** Final cutover step, separate PR, requires
   approval. Drop `fat.financial_years`, `fat.claim_sequences`,
   `fat.claim_groups`, `fat.recalls`, `fat.retain`, `fat.standby`,
   `fat.spoilt_meals`, `fat.user_rates`, `fat.home_address`,
   `fat.distance_cache`, `fat.station_distances`,
   `fat.travel_matrix_versions`, `fat.travel_matrix_cells`,
   `fat.profile_ext`. RPC drops: `fat.increment_claim_sequence`,
   `fat.travel_matrix_lookup` (the latter only if confirmed unused).
8. **Sharing layer (optional follow-up).** Wire copy-on-write semantics
   (`parent_claim_id`, `copy_source_owner_id`); add the server-side copy
   action. Schema is already forward-compatible.

### Phase 4 — Decision Backlog

Confirm each open architecture question (see § Open Questions) before the
relevant production behaviour ships. None of these are pre-decided here.

---

## Open Architecture Questions (carried from canonical docs)

Surfaced verbatim from canonical TODO lists. Open items are unblockers for
specific Phase 3 service rewrites. The "Resolved" subsection below records
decisions made after this audit landed.

1. `operational_claims.status` — does it need a `void` state?
   - Blocks: claim writer UX (Phase 3 step 4).
2. `claim_entitlements.payment_status` — split per stream or single enum?
   - Blocks: reconciliation surface (Phase 3 step 5).
3. `station_distance_matrix` + `station_time_matrix` — merge or keep split?
   - Blocks: matrix loader + travel resolvers (Phase 3 step 3).
4. FRV Matrix version pin — per-user (`profiles`) or per-claim (detail tables)?
   - Currently drafted per-claim. Blocks: matrix loader.
5. RLS policy spec doc — needs separate document once schema stamps.
6. Soft-delete vs hard-delete for `operational_claims`; cascade behaviour.
7. `parent_claim_id` / `copy_source_owner_id` — enforce existence with FK
   or remain informational?
   - Currently informational. Blocks: sharing layer (Phase 3 step 8).
8. Petty-cash export shape — materialised table vs computed on demand?
   - Blocks: petty-cash exporter (Phase 3 step 5).
9. `payslip_imports` raw-ingest table shape.
   - Blocks: payslip ingestion subsystem (not in scope).
10. Recall entitlement trigger conditions (Large Meal, Travel, Excess
    Travel, Relieving).
11. Delayed Meal + Spoilt Meal entitlement sets.
12. Relieving Allowance trigger + formula.
13. `fat.profile_ext.platoon` and `fat.profile_ext.pay_number` — canonical
    home, or drop?

### Resolved (2026-05-26)

- **FRV Matrix hours → payable bridge.** Hours-first: matrix output is
  the canonical payable quantity on `claim_entitlements.generated_hours`
  (0.25-hour increments stored verbatim); `generated_amount` is NULL for
  hours-first rows. No implicit hours → dollars conversion at generation
  time — the payslip line is the dollar settlement event, reconciled via
  `entitlement_payment_links`. Authoritative source:
  `ENTITLEMENT_RULES_v1.0.md § FRV Matrix Hours → Payable Bridge`.
- **Standby entitlement formulas.** Excess Travel (matrix-hours
  rostered ↔ standby station), Standby&Dismi (fixed 0.5h), Small Meal
  Allowance (dollars-first). See `ENTITLEMENT_RULES_v1.0.md § Standby →
  Entitlements`.
- **M&D entitlement set post-promotion.** Excess Travel (matrix-hours
  rostered ↔ M&D station), Muster&Dismis (fixed 1.0h). See
  `ENTITLEMENT_RULES_v1.0.md § Muster & Dismiss → Entitlements`.

**Phase 3 schema follow-up** (additive, not blocking sequencing): a new
migration `supabase/canonical/02_entitlement_amount_nullable.sql` must
drop `NOT NULL` on `fat.claim_entitlements.generated_amount` before the
engine writes the first hours-first row.

---

## Constraints (re-stated for change control)

- `dev` branch only. No merge to `main` without approval.
- No unrelated cleanup.
- No destructive production action.
- No architecture invention outside the six canonical docs. Any new
  decision must be added to the Open Questions list and the relevant
  canonical doc first.
- No silent preservation of legacy patterns that conflict with canonical
  (per-user rates, FY workspaces, single-table claim discriminators,
  Standby-via-Google).
- Auth surface untouched: `auth.users`, `fat.profiles` row, trigger.

---

## Verification Map

For each major existing subsystem, this audit covered:

| Subsystem | Audited against canonical doc(s) | Status |
|---|---|---|
| Supabase schema (`supabase/fat-schema.sql`, `supabase/fat-schema-travel.sql`, `supabase/canonical/01_canonical_foundation.sql`) | `DATABASE_ARCHITECTURE_v1.0.md` | Covered — Layer A/B/C/D/E |
| `fat.profiles` + auth trigger | `DATABASE_ARCHITECTURE_v1.0.md § 1`, `ALLOWANCE_ARCHITECTURE_v1.0.md § User Profile Model` | Covered — Layer A |
| `lib/claims/ClaimsContext.js`, `lib/claims/claimTypes.js` | `ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md`, `CLAIM_TYPES_v1.0.md` | Covered — Layer B/G/H |
| `lib/calculations/engine.js`, `RatesContext.js`, `defaultRates.js` | `ENTITLEMENT_RULES_v1.0.md`, `DATABASE_ARCHITECTURE_v1.0.md § 3-4` | Covered — Layer C/D |
| `lib/reconciliation/*` | `PAYMENT_RECONCILIATION_v1.0.md`, `DATABASE_ARCHITECTURE_v1.0.md § 7-8` | Covered — Layer E |
| `lib/distance/*`, `app/api/travel/google/route.js` | `ALLOWANCE_ARCHITECTURE_v1.0.md § Travel + Distance Architecture` | Covered — Layer F |
| `lib/fy/FinancialYearContext.js` | (no canonical equivalent) | Covered — Layer B (drop) |
| `lib/fat/models/*` | `DATABASE_ARCHITECTURE_v1.0.md`, `ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md` | Covered — Layer C/H (already aligned) |
| `app/*` Next.js surfaces | All six canonical docs | Covered — Layer G |

---

## Cross-References

- [REBUILD_PLAN_v1.0.md](REBUILD_PLAN_v1.0.md) — phased plan + change control
- [SCHEMA_READINESS_v1.0.md](SCHEMA_READINESS_v1.0.md) — Phase 1 verification gate output
- [ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md](ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md) — Phase 3 engine boundary spec (inputs, outputs, helpers, per-claim generators)
- [CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md) — Phase 3 lifecycle/state-machine contract (claim status, entitlement payment streams, payment_records, links, audit, override, delete/archive)
- [RECONCILIATION_STATE_ARCHITECTURE_v1.0.md](RECONCILIATION_STATE_ARCHITECTURE_v1.0.md) — Phase 3 reconciliation-state contract (stream semantics, routing, payment_records, link_kind taxonomy, discrepancy states, audit event enum, service contracts)
- [FAT_SCHEMA_ARCHITECTURE.md](FAT_SCHEMA_ARCHITECTURE.md) — prototype schema map (to be superseded in Phase 3)
- [supabase/canonical/01_canonical_foundation.sql](../supabase/canonical/01_canonical_foundation.sql) — Phase 1 schema
- [lib/fat/models/](../lib/fat/models) — Phase 2 typed models
- Governance canonical source set:
  `C:\Users\Admin\Apps\governance-system\chatgpt-project-sources\fire-allowance-tracker\`
