# Fire Allowance Tracker — Current-State Gap Analysis & Roadmap

Version: v1.0
Status: Audit output (read-only investigation)
Date: 2026-06-01
Branch: `dev`

Benchmark: the canonical three-layer architecture as defined in
`docs/REBUILD_AUDIT_v1.0.md`, `docs/REBUILD_PLAN_v1.0.md`,
`docs/ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md`,
`docs/RECONCILIATION_STATE_ARCHITECTURE_v1.0.md`,
`docs/CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md`, and the governance source set.

> Canonical three-layer model (the benchmark):
> **Operational Claim** (what the user did) → **Generated Entitlement**
> (what they were owed; immutable snapshot) → **Payment / Reconciliation**
> (what actually got paid; ledger + links + audit).

---

## 1. Current State (evidence-based)

### 1.1 What is LIVE (runtime today)

The running app is the **prototype**, not the canonical model. It works and
covers the first product pillar (operational event tracking) end to end.

| Subsystem | Live mechanism | Evidence |
|---|---|---|
| Claim types | 6 user-visible (`retain, recalls, standby, md, spoilt, delayed_meal`); `md` and `delayed_meal` are *virtual* — discriminators on `fat.standby` (`standby_type`) and `fat.spoilt_meals` (`meal_type`) | `lib/claims/claimTypes.js:21,33-45` |
| Claim creation | `ClaimForm` → `ClaimsContext.addClaim`: atomic claim # RPC → `fat.claim_groups` parent → parent row in `fat.<table>` → N auto-children → platoon stamp | `lib/claims/ClaimsContext.js:649-744`; `app/new-claim/page.js:100` |
| Parent/child | One `fat.claim_groups` row + child rows written **into the same claim tables**, tagged `autoChild` in `calculation_inputs` | `ClaimsContext.js:79-282,721-736` |
| Entitlement generation | `ClaimsContext.getAutoChildDefinitions` (imports only `lib/calculations/engine`); produces auto-children for recalls/retain/standby/md; meals produce none | `ClaimsContext.js:79-282`, `:25` |
| Rates | Per-user overrides in `fat.user_rates` (3 editable values); defaults merged from `defaultRates.js`; value-only `rates_snapshot` JSONB written onto each row | `RatesContext.js:77-121`; `defaultRates.js:23-59`; `engine.js:1231-1248` |
| Payment state | `payment_status ('Pending'|'Paid')`, `payment_date`, `payslip_pay_nbr`, `payment_method` **on each claim row**; `claim_groups.parent_status` cached | `fat-schema.sql:236-241,278-281,317-320,367-376`; `ClaimsContext.js:841-890` |
| Reconciliation | Pure client-side **summarizer** over in-memory claim rows (`calcNormalizedSummary` buckets $ by method × status). No ledger, no matching, no discrepancy detection, no audit | `lib/reconciliation/reconciliationUtils.js:48-101,299-427`; `components/dashboard/ReconciliationSummary.js:27` |
| Exports | 5 reconciliation CSVs + clipboard + tax CSV/PDF (`window.print`), Blob download | `lib/reconciliation/exportUtils.js:65-485`; `app/tax/page.js:112-206` |
| Travel | Recall = Google route (`app/api/travel/google/route.js`); FRV matrix loaded (`travel_matrix_cells`, 3321 cells) via `travel_matrix_lookup` RPC | per `feedback_travel_scope`, matrix live in DEV |

### 1.2 What is SCAFFOLDED but NOT wired

A coherent, well-typed canonical layer exists in source — but nothing at
runtime imports it.

| Asset | State | Evidence |
|---|---|---|
| `lib/fat/engine/*` (6 generators + `index.js`) | **Dead scaffolding.** `generateEntitlements` imported only by its own `validateDrafts.js`; no `app/`/`components/` importer | `index.js:46`; grep `fat/engine` in `{app,components}` = 0 hits |
| Engine generator completeness | Standby + M&D **functionally implemented**; recall/retain/spoilt/delayed all `return []` (TODO) | `standby.js:149-171`, `musterDismiss.js:100-114`, `recall.js:30`, `retain.js:19`, `spoiltMeal.js:19`, `delayedMeal.js:19` |
| `lib/fat/models/*` (8 typed models) | **Dead scaffolding.** No runtime import; referenced only by the unwired engine | grep `lib/fat/models` import = 0 app hits; `models/index.js:1-10` |
| Canonical SQL (`01/02/03_*.sql`) | **Authored, not deployed** (see §1.3) | `supabase/canonical/` |

### 1.3 What is in the LIVE database (verified via Supabase MCP)

This is the single most important finding, and it **contradicts the doc set's
"Phase 1 complete" claim**: the canonical schema exists only as SQL files.

- **DEV** (`kctctvpobbizhkiqkgqw`, the runtime target): 20 tables in `fat`, all
  **prototype** (`recalls, retain, standby, spoilt_meals, claim_groups,
  claim_sequences, financial_years, user_rates, profiles, profile_ext`,
  travel-matrix tables, stations). **Zero** canonical tables —
  no `operational_claims`, `claim_entitlements`, `payment_records`,
  `entitlement_payment_links`, `reconciliation_audit`, `rates`, `rate_versions`.
- **Live-only drift (not in any SQL file):** `friend_requests`, `friendships`,
  `claim_replication_events` (a sharing layer that exists in the DB but is
  absent from `fat-schema.sql`), plus `profile_ext_label_backup_20260518`.
- **PROD** (`wgcqzamuspuqpedqasbc`): half-migrated and broken for cutover — still
  has populated legacy `public.fat_*` tables, an **empty** `fat.*` skeleton, and
  **no travel-matrix tables**. Confirms `FAT_SCHEMA_ARCHITECTURE.md:151-154`.
- **Phantom ledger:** runtime defensively writes `fat.payment_components`
  (try/catch-guarded); that table exists in no SQL file and no live DB
  (`ClaimsContext.js:863-883`).
- **Security:** RLS is **disabled** on `fat.profile_ext_label_backup_20260518`
  in DEV (Supabase advisor critical) — exposed to the anon/authenticated key.

### 1.4 OCR / payslip ingestion

**Entirely absent from runtime.** No OCR, screenshot/vision, or PDF-parse code;
no ingestion route; no dependency. Every match is documentation, dormant SQL
columns (`ocr_source jsonb`, `raw_payload`, `source` enum), or typedef comments.
It is purely documented-as-future (`RECONCILIATION_STATE_ARCHITECTURE_v1.0.md:43,65-68`).

---

## 2. Architectural Alignment

| Canonical principle | Documentation | Scaffolding (source) | **Runtime / live DB** |
|---|---|---|---|
| 1. Three-layer separation | ✅ Fully specified | ✅ Tables + models authored | ❌ Collapsed: claim + entitlement + payment-state in one row |
| 2. Heterogeneous claims / homogeneous entitlements | ✅ | ✅ `operational_claims` + 6 details + `claim_entitlements` (SQL only) | ❌ One table per type; entitlements are sibling claim rows |
| 3. Static accounting records (immutable snapshots, rule/rate provenance) | ✅ | ✅ `generated_*`/`edited_*`/`rule_*`/`rate_*` columns | ⚠️ Value-only `rates_snapshot`; no `rule_id`/`rule_version`/`rate_version_id` |
| 4. Global rates + append-only versions | ✅ | ✅ `rates`/`rate_versions` (SQL only) | ❌ Per-user mutable `fat.user_rates`; no versioning |
| 5. Travel-source scope (Recall=Google, SB/MD=Matrix) | ✅ | ✅ matrix tables | ⚠️ Recall=Google ✅; Standby/M&D still routed via Google plumbing in places (`REBUILD_AUDIT §F`) |
| 6. Stream-scoped payment status + audit | ✅ Full contract | ✅ models | ❌ Single `Pending|Paid` per row; no streams, no audit |

**Alignment summary:** Planning and design maturity is **very high** (Phases 0–2
are thorough and internally consistent). Runtime alignment is **near zero** — the
app runs entirely on the prototype. The gap between documented intent and shipped
reality is the defining characteristic of this codebase today.

---

## 3. Missing Components (toward payroll verification & reconciliation)

Ordered from foundational to surface:

1. **Deployed canonical schema.** `01/02/03_canonical_foundation` never applied
   to any DB. *Nothing canonical can be built until these tables exist.*
2. **Live entitlement layer.** No persisted `claim_entitlements` rows with
   stable IDs — there is nowhere to attach a payment line or a discrepancy.
3. **Rule + rate provenance.** No `rule_id`/`rule_version`, no
   `rate_id`/`rate_version_id`; rates aren't versioned.
4. **Payment ledger.** No `payment_records` (what FRV actually paid). "Paid"
   is a boolean on the claim, not an observed real-world line.
5. **Entitlement↔payment links.** No `entitlement_payment_links` (N:M evidence
   layer) → no partial-payment, no allocation, no matching.
6. **Discrepancy detection.** The current reconciliation cannot detect
   underpayment/overpayment/missing-line — it only sums `payment_status`.
7. **Audit history.** No `reconciliation_audit`; payment toggles leave no trail.
8. **Stream-scoped status machine** (`payslip: pending|paid`,
   `petty_cash: outstanding|claimed`) + the §9 reconciliation service helpers.
9. **Payslip ingestion / OCR** (the automation that makes verification *fast*).
   Greenfield; explicitly future.
10. **Completed engine generators** for Recall, Retain, Delayed & Spoilt meals
    (currently `return []`).

---

## 4. Highest-Leverage Gaps

The few moves that unblock the most downstream value:

- **G1 — Deploy the canonical schema to DEV.** One SQL replay
  (`01` → `02` → `03`). Trivial cost, unblocks *every* Phase 3 service. This is
  the highest leverage-to-effort action in the entire project, and it closes the
  doc-vs-reality gap that currently makes "Phase 1 complete" false.
- **G2 — Persist a real entitlement layer (wire the engine).** Stable-ID
  `claim_entitlements` rows are the substrate payroll verification *requires*.
  Without them there is literally no row to link a payslip line to. The Standby
  and M&D generators are already written; this is more wiring than invention.
- **G3 — Rates as versioned source of truth (G2 prerequisite).** Every
  entitlement insert needs a `rate_version_id`. Cheap to seed from
  `DEFAULT_RATES`; gates the generator.
- **G4 — Payment ledger + links + audit + the §9 helpers.** This *is* payroll
  verification. The current `reconciliationUtils.js` cannot be patched into the
  contract (`RECONCILIATION_STATE_ARCHITECTURE_v1.0.md:855-856,1177-1179`) — it
  must be rewritten on top of G1–G3.
- **G5 (hygiene, parallel):** enable RLS on the DEV backup table; fold the live
  sharing tables (`friend_requests`/`friendships`/`claim_replication_events`)
  into version-controlled SQL; remove or formalize the phantom
  `payment_components` write.

Leverage chain: **G1 → G3 → G2 → G4**. Verification (the product goal) sits at
the *end* of this chain because it structurally depends on a persisted,
provenance-stamped entitlement layer and a payment ledger that do not yet exist.

---

## 5. Recommended Priority Order

This mirrors the repo's own Phase-3 sequencing (`REBUILD_AUDIT §Phased Rebuild`)
— which this audit confirms is correct — but front-loads the near-free unblock
(G1) and re-frames the ordering around the stated goal (verification &
reconciliation) rather than a generic rewrite.

1. Deploy canonical schema to DEV + hygiene (G1, G5). *Hours.*
2. Rates → `fat.rates`/`fat.rate_versions`; read-only `useRates()` (G3).
3. Wire entitlement engine → persist `operational_claims` + details +
   `claim_entitlements`; complete Recall/Retain generators (G2).
4. Split travel resolvers (Google-only Recall, Matrix-only SB/MD).
5. Reconciliation service: ledger + links + audit + §9 helpers + stream status
   (G4). **← payroll verification lands here.**
6. Reshape exports onto stream-scoped statuses; UI surfaces last.
7. (Later) Payslip OCR/PDF ingestion; sharing layer; drop prototype tables.

---

## 6. Proposed Roadmap (Phase 1 / 2 / 3)

> Re-scoped from the repo's plan to lead with verification value. The repo's
> "Phases 0–2" (audit, schema authoring, models) are *authored*; the schema is
> not *deployed*, so Phase 1 below begins by making the authored foundation real.

### Phase 1 — Activate the Foundation *(days)*
**Goal: make the canonical layer real and unblock everything.**
- Replay `supabase/canonical/01,02,03` to DEV; verify all 15 tables + RLS.
- Fix RLS on `profile_ext_label_backup_20260518`; version-control the live
  sharing tables; decide the fate of the `payment_components` write.
- Seed `fat.rates` + `fat.rate_versions` from `DEFAULT_RATES`; build read-only
  `useRates()`. (App keeps running on prototype throughout.)
- **Exit:** canonical tables live in DEV; rates queryable; doc-vs-reality gap closed.

### Phase 2 — Live Entitlement Layer *(the leverage phase)*
**Goal: persisted, provenance-stamped entitlements with stable IDs.**
- Wire `lib/fat/engine` into a new claim-writer path that persists
  `operational_claims` + one detail row + N `claim_entitlements` (with
  `rule_id`/`rule_version`/`rate_version_id`/`rate_snapshot`, hours-first for
  matrix rows).
- Complete the four `return []` generators (Recall, Retain, Spoilt, Delayed) as
  canonical TODOs resolve; Standby/M&D are already written.
- Split travel resolvers (Google = Recall km; Matrix = SB/MD hours).
- **Exit:** new claims produce real `claim_entitlements` rows; entitlement IDs
  exist to link payments against.

### Phase 3 — Payroll Verification & Reconciliation *(the goal)*
**Goal: match what was owed against what was paid, with discrepancies + audit.**
- Implement §9 reconciliation helpers on `payment_records` /
  `entitlement_payment_links` / `reconciliation_audit`: manual payment entry,
  manual matching, discrepancy notes, stream-scoped status, append-only audit.
- Rewrite `reconciliationUtils`/`filterUtils`/`exportUtils` onto the ledger;
  date-range scope (drop FY); reshape petty-cash export.
- Rewrite UI surfaces (`dashboard`, `new-claim`, `settings`, `tax`, `profile`).
- **Then automate:** payslip OCR/PDF ingestion → `payment_records` (the
  `payslip_imports` staging table is an open canonical TODO).
- Final, separate, approval-gated PR: drop prototype tables; promote to PROD.

---

## 7. Caveats

- Live-DB findings (§1.3) were verified via Supabase MCP against DEV and PROD.
- All file:line citations are from the `dev` branch working tree at audit time.
- This is an audit; no code or schema was changed.
- The repo's `REBUILD_AUDIT_v1.0.md`/`REBUILD_PLAN_v1.0.md` remain the canonical
  change-control records; this document is the current-state verification behind
  them and supersedes their "Phase 1 complete" status note with the deployment
  reality.
