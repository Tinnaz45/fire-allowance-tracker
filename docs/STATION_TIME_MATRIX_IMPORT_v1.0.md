# Station Time Matrix — Import & Activation Report (v1.0)

**Date:** 2026-06-02
**Environment:** DEV (`kctctvpobbizhkiqkgqw`) only
**Scope:** Populate `fat.station_time_matrix` from the FRV workbook tab **"Index (hr)"**, completing the canonical dual-matrix model (`station_distance_matrix` = km, `station_time_matrix` = hours).

This closes the gap migration `canonical_05` explicitly left open: that migration seeded the **km** matrix and left `station_time_matrix` EMPTY because `travel_matrix_cells` then held kilometres, not hours.

---

## 1. Source

| | |
|---|---|
| Workbook | `FRV Allowances - Current.xlsx` (412,252 bytes, 2026-04-07) |
| Tab | `Index (hr)` (sheet 12 of 16) |
| Meaning | Station-to-station **one-way** travel time, decimal hours, 0.25-hr increments |
| Provenance (in-sheet notes) | "Taken from the MFESB expenses chart at FS45" / "Taken from Whereis.com" |
| Grid | 96 × 96 (FRV station ids 1–96; 14 are inactive gaps), header at sheet row 3, data rows 4–99 |

> A newer copy `FRV Allowances - Current (1).xlsx` (2026-05-17) also exists in Downloads. The task specified the canonical `FRV Allowances - Current.xlsx`; that is what was imported. Re-run against the newer copy if/when it is ratified as authoritative.

---

## 2. Procedure (replayable)

The `.xlsx` is a ZIP of XML. No SheetJS dependency is used.

```powershell
# 1. unzip
Copy-Item "FRV Allowances - Current.xlsx" book.zip
Expand-Archive book.zip -DestinationPath .\x

# 2. "Index (hr)" = rId16 -> xl/worksheets/sheet12.xml (per xl/workbook.xml + rels)

# 3. extract the raw cell grid to CSV
node scripts/extract-xlsx-sheet.mjs .\x\xl\worksheets\sheet12.xml .\x\xl\sharedStrings.xml .\index-hr-raw.csv

# 4. make importer-ready: drop the 2 title rows (keep the station-number header
#    row), and normalise integer-valued floats "N.0" -> "N" so labels resolve as
#    bare FRV station ids. Result committed at supabase/canonical/data/index-hr.csv
```

```bash
# 5. import into fat.travel_matrix_cells (writes a travel_matrix_versions row,
#    unit=hours, activated independently of the km version)
node scripts/import-travel-matrix.mjs \
  --file supabase/canonical/data/index-hr.csv \
  --label "FRV Index (hr) - 2026-04 import" --unit hours --activate
```

```sql
-- 6. seed fat.station_time_matrix (direction-expanded, hours-filtered)
--    supabase/canonical/06_seed_station_time_matrix.sql
```

Env required for step 5: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (DEV, in `.env.local`).

**Idempotency:** step 6 uses `ON CONFLICT (from,to,version) DO NOTHING` — re-running leaves the row count unchanged (verified: 2736 → 2736). Re-running step 5 creates a *new* version (the importer does not dedupe versions); only re-run it to load corrected source data.

---

## 3. Results

| Metric | Value |
|---|---|
| Parsed pairs (importer) | 1368 |
| Directed rows in `station_time_matrix` | **2736** (1368 × 2) |
| Distinct stations resolved | **82 / 82 active** |
| Matrix version | `676e1a72-7135-4e64-9242-57bf7ddfc7fc` (unit=hours, active) |
| Value range | 0.25 – 7.25 hr |
| Coverage | **41.2 %** of the 3321 possible active pairs |

---

## 4. Validation (all pass)

| Test | Result |
|---|---|
| Row count = 2 × parsed pairs | 2736 ✓ |
| Single matrix version | 1 ✓ |
| Station→station mapping (82 active) | ✓ — 14 unresolved labels are exactly the inactive ids (17,21,36,37,49,65,69,74–79,83) |
| Self-pairs | 0 ✓ |
| Negative / zero hours | 0 ✓ |
| Quarter-hour increments (`hours*4 = round(hours*4)`) | 0 violations ✓ |
| FK integrity (from/to → `fat.stations`) | 0 violations ✓ |
| Inactive-station references | 0 ✓ |
| Symmetry (`|hours(a,b) − hours(b,a)| ≤ 0.001`) | 0 asymmetric pairs ✓ |
| Sample pairs vs spreadsheet | ✓ — (1,2)=0.25, (1,5)=0.75, (1,9)=1.0, (1,10)=0.25, (1,72)=7.25, (1,96)=0.5; symmetric (73,1)=(1,73)=2.25 |
| Idempotent re-seed | 2736 → 2736 ✓ |
| Distance matrix untouched | 6642 rows, 1 version ✓ |
| Engine draft-validation suite | 16 / 16 pass ✓ |
| New security advisors | none on `station_time_matrix` (RLS from canonical_01 intact) ✓ |

---

## 5. Data-quality findings

1. **Sparse coverage (41.2 %).** Unlike the km matrix (fully populated, 6642 rows), the hours sheet only has values for 1368 of 3321 active pairs. Coverage is concentrated in the metro core; **regional stations are thin** — e.g. Geelong City, Corio, Belmont, Ocean Grove, Lara, Melton, Caroline Springs, Tarneit, Point Cook, Greenvale, Ballarat City each have only **7** populated pairs. A missing `(from,to,version)` row means *"no hours datum"*, **not zero** — callers must treat it as absent.

2. **One source typo — pair (14 ↔ 60) = "75".** Both directions in the sheet read `75` (hours), which exceeds the importer's 24-hr plausibility ceiling and was **rejected** (so the pair is absent). Almost certainly an intended `0.75` with a dropped "0.". *Recommend correcting the spreadsheet and re-importing* rather than fabricating the value here (spreadsheet is authoritative).

3. **Float-formatted labels.** Sheet stores station ids as `1.0, 2.0, …`; these are normalised to bare ids during CSV prep so `extractFsId` resolves them. (The off-by-one corner artifact in the raw grid is handled — header `B3`=station 1, data diagonal correctly blank.)

---

## 6. Recommended next step

- **Ratify or correct** the (14↔60) source value and re-import if changed.
- **Decide the regional-coverage policy**: the engine already degrades gracefully (no hours row → no `excess_travel_*` draft), but Standby/M&D claims from thin regional stations will silently produce no excess-travel entitlement. Either accept manual entry for those, or source a complete hours matrix.
- The **hours → payable-dollars bridge** (converting `generated_hours` to a dollar amount) remains unresolved and is **out of scope** here — see `ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md` and the canonical seed report. This must be settled before entitlement generation is wired live.

---

## 7. Entitlement-engine readiness assessment

**Status: data dependency satisfied; engine remains intentionally unwired.**

The hours matrix was the last missing canonical reference dataset. The engine's hours-first generators are ready to consume it:

- `lib/fat/engine/generators/standby.js` → `excess_travel_standby` calls `ctx.matrixLookup(rostered, standby, matrix_version) → { hours }`.
- `lib/fat/engine/generators/musterDismiss.js` → `excess_travel_md` calls `ctx.matrixLookup(rostered, md, matrix_version) → { hours }`.

The DB shape matches the contract exactly: **directed** rows (both `(a,b)` and `(b,a)` seeded) so a single-direction lookup always hits; `matrix_version` is `text`; `hours` is `numeric(6,2)`. `makeMatrixLookup` (`validateDrafts.js`) keys on `from->to@version`, satisfied by the directed seeding.

**Still required to go live (all out of this task's scope — DO NOT wire):**
1. A real `matrixLookup` implementation querying `fat.station_time_matrix` by the **active hours version** (`676e1a72-…`).
2. Stamping `details.matrix_version` = active hours version on Standby/M&D claims at creation (today claims are not stamped with the hours version).
3. The hours→dollars payable bridge constant/unit (finding #6 above).
4. Acceptance of the 41.2 % coverage limitation, or a fuller source matrix.

**Conclusion:** `station_time_matrix` is populated, versioned, validated, and structurally compatible with the engine. The entitlement engine is **ready for next-phase integration** on the data axis; remaining blockers are wiring + the dollar-bridge decision, not the matrix.
