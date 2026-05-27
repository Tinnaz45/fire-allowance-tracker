# Fire Allowance Tracker — Financial Verification Checklist

**Version:** 1.2
**Created:** 2026-05
**Last updated:** 2026-05 (canonical-rate refactor — only `kilometreRate`, `smallMealAllowance`, and `largeMealAllowance` remain editable; double meal is derived; spoilt, delayed, and standby-night meals all source `smallMealAllowance`; overnight cash is captured per-claim, not as a rate)
**Purpose:** Pre-production verification of all allowance rates and calculation formulas against the current FBEU Enterprise Agreement and real payslip examples.
**Status:** 🟡 NOT CLEARED FOR PRODUCTION — unresolved assumptions remain (see §3 and §4).

---

## How to Use This Document

1. Work through each table in §2 (Rates) and §3 (Formulas).
2. For every row marked ⚠️ ASSUMED or ❓ UNKNOWN — locate the relevant clause in the enterprise agreement and record the confirmed value + clause reference.
3. Provide real payslip / pay advice examples for the §5 placeholders.
4. Update each row's **Source Status** and **Testing Status** columns.
5. Re-run `node lib/calculations/validationScenarios.js` to confirm 41/41 still pass after any rate corrections.
6. Only mark the app "Financially Safe" (bottom of this document) once every row is ✅ CONFIRMED.

---

## §1 — Known Confirmed Rates (Starting Point)

These rates have been confirmed from the FRV historical allowance sheets (FRV Allowances 2023FY, 2025FY, and Current).

| Rate | Confirmed Value | Editable? | Source |
|---|---|---|---|
| Kilometre Rate (`kilometreRate`) | $1.20/km | ✅ Canonical | User-confirmed from FBEU EA, 2025; also in FRV allowance sheets |
| Small Meal Allowance (`smallMealAllowance`) | $10.90 | ✅ Canonical | User-confirmed from FBEU EA, 2025; also in FRV allowance sheets. Also drives Spoilt, Delayed, Standby-Night, and Retain-small meals. |
| Large Meal Allowance (`largeMealAllowance`) | $20.55 | ✅ Canonical | Confirmed FRV Allowances 2023FY, 2025FY, Current — flat rate, NOT 2× small. Also drives Retain-large and the derived double meal. |
| Double Meal Allowance | $31.45 | ❌ Derived | Confirmed FRV Allowances 2023FY, 2025FY, Current. Computed at calculation time as `smallMealAllowance + largeMealAllowance`; there is no editable `doubleMealAllowance` rate. |
| Spoilt Meal Allowance | $10.90 | ❌ Sourced | Confirmed FRV Allowances 2023FY, 2025FY, Current. Sourced from canonical `smallMealAllowance`; there is no editable `spoiltMealAllowance` rate. |

---

## §2 — Rate Verification Table

The canonical-rate refactor leaves only three editable rates in `lib/calculations/defaultRates.js` (see `RATE_FIELDS`). All other meal-allowance values are derived at calculation time inside `engine.js`, and overnight cash is captured per-claim.

### 2.1 Travel

| Rate Key | App Value | Source Status | EA Clause / Evidence Needed | Risk if Wrong | Testing Status |
|---|---|---|---|---|---|
| `kilometreRate` | $1.20/km | ✅ CONFIRMED | User-confirmed from FBEU EA 2025. Review at 1 July annually. | LOW — confirmed | ✅ Covered by validation scenarios |

---

### 2.2 Canonical Meal Allowances (editable)

| Rate Key | App Value | Source Status | EA Clause / Evidence Needed | Risk if Wrong | Testing Status |
|---|---|---|---|---|---|
| `smallMealAllowance` | $10.90 | ✅ CONFIRMED | User-confirmed from FBEU EA 2025; also in FRV Allowances 2023FY, 2025FY, Current. **Also drives Spoilt, Delayed, Standby-Night, and Retain-small meals.** | LOW — confirmed | ✅ Covered by validation scenarios |
| `largeMealAllowance` | $20.55 | ✅ CONFIRMED | Confirmed from FRV Allowances 2023FY, 2025FY, and Current. **Flat rate — not derived from small meal.** Previous derived assumption of $21.80 (2× small) has been corrected. Also drives Retain-large meals and the derived double meal. | LOW — confirmed | ✅ Covered by validation scenarios |

---

### 2.3 Derived / Sourced Meal Allowances (not editable rates)

These allowances were previously editable rates and have been **removed** from `defaultRates.js`. They are now derived at calculation time from `smallMealAllowance` and/or `largeMealAllowance`.

| Allowance | Sourced From | Computed Value | EA Status | Risk |
|---|---|---|---|---|
| Double meal | `smallMealAllowance + largeMealAllowance` | $31.45 | ✅ CONFIRMED — FRV Allowances 2023FY, 2025FY, Current confirm the sum equals the published double meal value | LOW |
| Spoilt meal | `smallMealAllowance` | $10.90 | ✅ CONFIRMED — FRV Allowances 2023FY, 2025FY, Current. Previous $22.80 (SQL schema default of unknown origin) has been corrected. Historical claims at $22.80 are preserved as-is. | LOW |
| Delayed meal | `smallMealAllowance` | $10.90 | ⚠️ UNRESOLVED — no separate FRV evidence found. The engine collapses Delayed onto the small-meal rate pending EA confirmation. If a distinct value is confirmed, introduce a new canonical rate at that time. | HIGH for Delayed claims |
| Standby-night meal | `smallMealAllowance` | $10.90 | ⚠️ ASSUMED — confirm the EA clause and that it applies equally to Standby vs M&D. The engine gates eligibility on `isStandbyNightMealEligible()` (Night shift, arrival ≥ 19:00, never M&D). | MEDIUM |

> **Note (Spoilt):** No regression — the runtime simply reads `smallMealAllowance` instead of the removed `spoiltMealAllowance` key. Historical Spoilt claims stored at $22.80 are unaffected; they are protected by historical claim preservation logic.
>
> **Note (Delayed):** Rate is unresolved. No FRV evidence found. The runtime sources `smallMealAllowance`. Do not rely on Delayed claim calculations for compliance until this is confirmed from the enterprise agreement.

---

### 2.4 Overnight Cash (per-claim, not a rate)

| Field | Where Captured | Source Status | EA Clause / Evidence Needed | Risk if Wrong | Testing Status |
|---|---|---|---|---|---|
| `overnight_cash` (on Retain claims) | Per-claim form input | ❓ USER-ENTERED PER CLAIM | The previous `overnightAllowance` rate has been removed. Overnight cash varies per incident and is not a uniform award amount. Confirm: is there an EA-specified overnight rate that should be reintroduced as a canonical default, or does it remain a per-claim determination from pay advice? | MEDIUM — users must record the correct overnight amount per claim | ⚠️ Not tested against a real payslip example |

---

### 2.5 Retain

| Rate Key | App Value | Source Status | EA Clause / Evidence Needed | Risk if Wrong | Testing Status |
|---|---|---|---|---|---|
| `retainAllowancePerHour` | $0.00 | ❌ UNRESOLVED | **This rate is intentionally zeroed out because the formula is unknown. The retain allowance (base pay for staying past book-off) is currently user-entered manually. Find the EA clause for retain allowance: is it a flat amount per retain event, a per-hour rate, or a percentage of ordinary pay?** | CRITICAL — retain calculations cannot be automated until this is confirmed | ❌ No formula implemented; manual entry only |

---

### 2.6 Non-Monetary Thresholds

These are stored in `defaultRates.js` but not yet used in automated calculations (no auto-entitlement logic is implemented). They are flagged here for future confirmation.

| Key | App Value | Source Status | EA Clause / Evidence Needed | Risk |
|---|---|---|---|---|
| `recallMinimumHours` | 3 hours | ⚠️ ASSUMED | Minimum engagement period on recall. Confirm EA clause. | LOW (not yet used in calculations) |
| `recallMealieThreshold` | 4 hours | ⚠️ ASSUMED | Hours threshold that triggers a meal allowance on recall. Confirm EA clause. | LOW (not yet used; user self-selects) |

---

## §3 — Formula Verification Checklist

### 3.1 Recall Claim

**Formula (engine.js `calcRecallClaim`):**
```
total_km      = (dist_home_km × 2) + (dist_stn_km × 2)   // return route
travel_amount = round(total_km × kilometreRate)
mealie_amount = calcMealAllowance({ mealEntitlement }, rates)
                  small  → smallMealAllowance
                  large  → largeMealAllowance
                  double → smallMealAllowance + largeMealAllowance   // derived
total_amount  = round(travel_amount + mealie_amount)
```

| Check | Status | Notes |
|---|---|---|
| Travel: km × $1.20/km | ✅ Formula correct | Confirmed rate |
| Meal: user self-selects none/small/large/double | ⚠️ ASSUMPTION | **EA likely specifies objective threshold (e.g. "if recall exceeds 4 hours, small meal applies"). Self-selection may not match award entitlement. Confirm the exact trigger conditions.** |
| Large meal = $20.55 flat (NOT 2× small) | ✅ Confirmed | Confirmed FRV — see §2.2 |
| Double meal = small + large = $31.45 (derived) | ✅ Confirmed | Sum matches FRV double meal value; ATO tax decomposition = 1 small + 1 large via `calcMealTaxComponents()` |
| total = travel + meal | ✅ Formula logically correct | No dispute |
| Historical claims never recalculate | ✅ Implemented correctly | Verified in code |

---

### 3.2 Retain Claim

**Formula (engine.js `calcRetainClaim`):**
```
{ smallCount, largeCount } = calcRetainMealEligibility({ shift, bookedOffTime })
meal_amount   = round((smallCount × smallMealAllowance) + (largeCount × largeMealAllowance))
total_amount  = round(retainAmount + overnightCash + meal_amount)
```

| Check | Status | Notes |
|---|---|---|
| retainAmount — base retain allowance | ❌ UNRESOLVED | **User-entered only. No formula implemented. EA formula unknown. Must be confirmed before this claim type is reliable.** |
| overnightCash — overnight component | ⚠️ USER-ENTERED PER CLAIM | User determines from their own pay advice. The previous `overnightAllowance` rate has been removed; overnight cash is captured on the Retain form per claim. Verify with at least one real example. |
| Retain-meal auto-derivation (`calcRetainMealEligibility`) | ⚠️ ASSUMED | Thresholds in `RETAIN_MEAL_THRESHOLDS` (Day → Large > 19:00, +Small > 22:00; Night → Large > 09:00, +Small > 13:00) need EA confirmation. |
| Meal pricing = small/large canonical rates | ✅ Formula correct | No separate retain-meal rate; canonical rates only |
| total = retain + overnight + meal | ✅ Formula logically correct | Addition is correct; the issue is the retain input value |

---

### 3.3 Standby Claim

**Formula (engine.js `calcStandbyClaim`):**
```
travel_amount = round(dist_km × kilometreRate)
hasNightMeal  = isStandbyNightMealEligible({ standbyType, shift, arrivedTime })
                  // false for M&D; Night shift only; arrival ≥ 19:00
night_mealie  = hasNightMeal ? smallMealAllowance : 0
total_amount  = round(travel_amount + night_mealie)
```

| Check | Status | Notes |
|---|---|---|
| Travel: km × $1.20/km | ✅ Formula correct | Confirmed rate |
| Night meal sourced from `smallMealAllowance` ($10.90) | ⚠️ ASSUMED | Confirm EA clause for night meal value. |
| Eligibility = Night shift AND arrival ≥ 19:00 AND not M&D | ⚠️ ASSUMED | Confirm against EA — particularly the 19:00 cutoff and the M&D exclusion |
| Standby vs M&D — same travel rate? | ⚠️ ASSUMED | **App applies identical travel rates; M&D never carries a meal allowance. Confirm the EA does not have a separate M&D travel rate.** |
| total = travel + night_mealie | ✅ Formula logically correct | No dispute |

---

### 3.4 Spoilt / Delayed Meal Claim

**Formula (engine.js `calcSpoiltClaim`):**
```
meal_amount  = round(smallMealAllowance)   // for both Spoilt and Delayed
total_amount = meal_amount
```

| Check | Status | Notes |
|---|---|---|
| Spoilt = $10.90 (sourced from `smallMealAllowance`) | ✅ Confirmed | Confirmed FRV — see §2.3 |
| Delayed = $10.90 (sourced from `smallMealAllowance`) | ⚠️ UNRESOLVED | No separate FRV evidence found; collapses onto small meal pending EA confirmation |
| No travel component on spoilt/delayed | ✅ Appears correct | Spoilt/Delayed are meal-only claims |
| total = meal only | ✅ Formula logically correct | No dispute |
| Legacy `Spoilt / Meal` value normalised to `Spoilt` | ✅ Verified | `normaliseMealType()` handles legacy DB rows |

---

### 3.5 Rounding

| Check | Status | Notes |
|---|---|---|
| All amounts rounded to 2dp half-up | ✅ Verified | `roundMoney()` uses `Math.round((v + Number.EPSILON) × 100) / 100` |
| Float drift prevented | ✅ Verified | `Number.EPSILON` guard in place |
| Historical totals read from DB, not recalculated | ✅ Verified | `resolveStoredAmount()` reads stored columns only |

---

## §4 — Unresolved Assumptions Summary

This is the consolidated list of everything that must be confirmed before the app is financially safe for production use.

| # | Item | Current Value | Status | Priority | What to Provide |
|---|---|---|---|---|---|
| 1 | Large meal allowance | $20.55 | ✅ CONFIRMED | — | Confirmed from FRV Allowances 2023FY, 2025FY, Current. No further action needed. |
| 2 | Double meal allowance | $31.45 (derived = small + large) | ✅ CONFIRMED | — | Derived sum matches the published FRV double meal value. No editable rate. |
| 3 | Spoilt meal allowance | $10.90 (sourced from `smallMealAllowance`) | ✅ CONFIRMED | — | Confirmed from FRV Allowances 2023FY, 2025FY, Current. No editable rate. |
| 4 | Delayed meal allowance | $10.90 (sourced from `smallMealAllowance`) | ⚠️ UNRESOLVED | HIGH | No separate FRV evidence found. Confirm against EA whether Delayed differs from the small-meal value. |
| 5 | Standby night meal | $10.90 (sourced from `smallMealAllowance`) | ⚠️ ASSUMED | MEDIUM | EA clause + confirm Standby vs M&D + 19:00 cutoff |
| 6 | Retain allowance formula | User-entered; no auto-calc | ❌ UNRESOLVED | CRITICAL | EA clause describing the formula (hourly rate? flat? % of pay?) |
| 7 | Overnight cash | Captured per-claim; no rate | ❓ USER-ENTERED PER CLAIM | MEDIUM | Confirm whether EA specifies a standard rate that should be reintroduced as a canonical default |
| 8 | Recall meal entitlement trigger | User self-selects none/small/large/double | ⚠️ ASSUMED | HIGH | EA clause defining hours threshold for none/small/large/double |
| 9 | Standby vs M&D same rates? | Same travel rate applied; M&D never meal-eligible | ⚠️ ASSUMED | MEDIUM | Confirm EA has no separate M&D travel rate |
| 10 | Retain meal thresholds (`RETAIN_MEAL_THRESHOLDS`) | Day: Large > 19:00, +Small > 22:00; Night: Large > 09:00, +Small > 13:00 | ⚠️ ASSUMED | MEDIUM | EA clause for the booked-off thresholds that grant Large and Large+Small meal eligibility |
| 11 | Recall minimum hours | 3 hours (stored, unused) | ⚠️ ASSUMED | LOW | EA clause (not yet in calculations) |
| 12 | Recall meal threshold hours | 4 hours (stored, unused) | ⚠️ ASSUMED | LOW | EA clause (not yet in calculations) |

---

## §5 — Real-World Validation Cases (Placeholders)

These placeholders must be filled with actual values from payslips or pay advice before the app can be signed off. Do not invent amounts.

Instructions for each placeholder:
- Retrieve the actual claim from payroll / pay advice.
- Enter the exact inputs and the exact amount paid.
- Run the app with those inputs and compare.
- Record whether the app result matches.

---

### Payslip Example 1

> **Purpose:** General cross-check of the most common claim type against a real pay record.

| Field | Value |
|---|---|
| Claim type | _[to be provided]_ |
| Date of claim | _[to be provided]_ |
| Inputs (km, meal type, etc.) | _[to be provided]_ |
| Amount on payslip | _[to be provided]_ |
| App calculated amount | _[run app, record here]_ |
| Match? | _[Yes / No / Discrepancy: $X]_ |
| Notes | _[any differences or explanations]_ |

---

### Payslip Example 2

> **Purpose:** Second cross-check, ideally a different claim type from Example 1.

| Field | Value |
|---|---|
| Claim type | _[to be provided]_ |
| Date of claim | _[to be provided]_ |
| Inputs | _[to be provided]_ |
| Amount on payslip | _[to be provided]_ |
| App calculated amount | _[run app, record here]_ |
| Match? | _[Yes / No / Discrepancy: $X]_ |
| Notes | |

---

### Recall Example

> **Purpose:** Verify recall travel + meal calculation against a real recall claim.

| Field | Value |
|---|---|
| Date of recall | _[to be provided]_ |
| dist_home_km | _[to be provided]_ |
| dist_stn_km | _[to be provided]_ |
| Meal entitlement claimed | _[none / small / large]_ |
| Total paid by payroll (allowance portion only) | _[to be provided]_ |
| App travel amount | _[run app, record here]_ |
| App meal amount | _[run app, record here]_ |
| App total | _[run app, record here]_ |
| Match? | _[Yes / No / Discrepancy: $X]_ |
| Notes | _If mismatch, was it the km rate, meal rate, or threshold?_ |

---

### Meal Example (Spoilt or Delayed)

> **Purpose:** Confirm the Spoilt/Delayed allowance rate against a real claim.

| Field | Value |
|---|---|
| Meal type | _[Spoilt / Delayed]_ |
| Date | _[to be provided]_ |
| Amount on payslip | _[to be provided]_ |
| App calculated amount | _[run app — should match `smallMealAllowance` ($10.90) for both Spoilt and Delayed]_ |
| Match? | _[Yes / No / Discrepancy: $X]_ |
| Confirmed rate | _[If Delayed differs from $10.90, introduce a new canonical rate — do NOT reintroduce the removed `delayedMealAllowance` key]_ |
| Notes | |

---

### Standby Example

> **Purpose:** Verify standby travel + night meal against a real standby claim.

| Field | Value |
|---|---|
| Claim type | _[Standby / M&D]_ |
| Date | _[to be provided]_ |
| dist_km | _[to be provided]_ |
| Was it a night shift? | _[Yes / No]_ |
| Amount on payslip | _[to be provided]_ |
| App travel amount | _[run app, record here]_ |
| App night meal | _[run app, record here]_ |
| App total | _[run app, record here]_ |
| Match? | _[Yes / No / Discrepancy: $X]_ |
| Notes | _If M&D — note whether rates differed from Standby_ |

---

### Retain Example

> **Purpose:** Understand how retain is currently paid and what inputs produce the correct total.

| Field | Value |
|---|---|
| Date of retain | _[to be provided]_ |
| Book-off time | _[to be provided]_ |
| Actual departure time | _[to be provided]_ |
| Hours retained | _[to be provided]_ |
| Retain allowance on payslip | _[to be provided]_ |
| Overnight cash on payslip (if any) | _[to be provided]_ |
| Total paid | _[to be provided]_ |
| App total (manual entry) | _[run app with same values, record here]_ |
| Match? | _[Yes / No / Discrepancy: $X]_ |
| EA formula discovered? | _[describe the formula — hourly rate? flat fee? — so it can be implemented]_ |
| Notes | |

---

## §6 — Validation Scenario Status

The automated validation suite (`lib/calculations/validationScenarios.js`) covers internal arithmetic correctness. It does **not** verify that the rates themselves are correct — only that the formulas apply the rates consistently.

| Scenario Group | Coverage |
|---|---|
| `roundMoney` | float drift, half-up rounding, null and NaN guards |
| Travel (`calcTravelAmount`, `calcTotalKm`) | typical/fractional/zero/large distances, home+station summing |
| Meal allowances (`calcMealAllowance`, `calcDoubleMealAllowance`) | none/small/large; derived double meal (small + large); missing-rates and unknown-type guards |
| Spoilt/Delayed (`calcSpoiltMealAmount`, `calcSpoiltClaim`, `normaliseMealType`) | Spoilt and Delayed both source `smallMealAllowance`; legacy `Spoilt / Meal` normalisation |
| Recall (`calcRecallClaim`) | typical recall, travel-only, small/large/double meal at zero km, all-zero |
| Retain (`calcRetainClaim`) | retain + overnight, retain only, all-zero |
| Standby (`calcStandbyClaim`) | day/night, with/without travel |
| `resolveStoredAmount` | column priority cascade including all-null |
| Dashboard (`calcDashboardSummary`) | mixed claim types, empty input |
| Rounding edge cases | 7.5 km precision, sum stability, rate-change impact |

Run `node lib/calculations/validationScenarios.js` for the live pass/fail count. The validation suite was updated alongside the canonical-rate refactor — only the three canonical rates are seeded into `TEST_RATES`, and the Spoilt/Delayed/Standby-night/double-meal scenarios assert the derived values.

> Validation scenarios test formula correctness using the rates as configured. Passing them does not mean all rates are correct — it means the formulas are internally consistent. Delayed meal allowance remains flagged UNRESOLVED.

---

## §7 — Production Readiness Assessment

| Area | Status | Blocker? |
|---|---|---|
| Calculation engine (formulas) | ✅ Implemented and tested | No |
| Rounding | ✅ Correct | No |
| Historical claim protection | ✅ Implemented correctly | No |
| Rate snapshot on each claim | ✅ Implemented | No |
| Canonical rate model (only `kilometreRate`, `smallMealAllowance`, `largeMealAllowance` editable) | ✅ Implemented | No — derived/sourced allowances now compute at calculation time |
| km rate ($1.20/km) | ✅ Confirmed | No |
| Small meal ($10.90) | ✅ Confirmed | No |
| Large meal ($20.55) | ✅ Confirmed (FRV records) | No |
| Double meal ($31.45 derived) | ✅ Confirmed | No — derived = small + large |
| Spoilt meal ($10.90 sourced from small) | ✅ Confirmed | No |
| Delayed meal ($10.90 sourced from small) | ⚠️ UNRESOLVED | **Yes — no separate FRV evidence; runtime sources `smallMealAllowance` pending EA confirmation** |
| Standby night meal ($10.90 sourced from small) | ⚠️ Unconfirmed | **Yes — used on every eligible night standby** |
| Retain formula | ❌ Unresolved | **Yes — no auto-calc; retain_amount manual entry only (meal is auto-derived)** |
| Overnight cash (per-claim) | ❓ User-entered per claim | Partial — captured on the Retain form per claim; no rate-level default |
| Real-world payslip verification | ❌ Not yet done | **Yes — no real examples tested** |

### Overall Status

> 🟡 **NOT CLEARED FOR PRODUCTION — Significantly improved; two rate blockers remain**
>
> The app is **mechanically correct** — formulas and rounding are sound, historical claims are protected, and the validation suite passes. After the canonical-rate refactor the editable rate surface has shrunk to three keys (`kilometreRate`, `smallMealAllowance`, `largeMealAllowance`); every other meal value is derived or sourced from these, and overnight cash is captured per-claim.
>
> **Confirmed since last review (2026-05):**
> - Large meal: $21.80 → corrected to $20.55 (confirmed FRV flat rate — not 2× small)
> - Double meal: $31.45 (derived = small + large; matches FRV)
> - Spoilt meal: $22.80 → corrected to $10.90 (sourced from canonical `smallMealAllowance`)
> - Removed editable rates: `doubleMealAllowance`, `spoiltMealAllowance`, `delayedMealAllowance`, `standbyNightMealAllowance`, `overnightAllowance`
>
> **Minimum required before production use:**
> 1. ~~Confirm large meal allowance~~ ✅ DONE — $20.55 confirmed
> 2. ~~Confirm spoilt meal allowance~~ ✅ DONE — $10.90 confirmed (sourced from small)
> 3. Confirm Delayed meal against EA — if it differs from $10.90, introduce a new canonical rate (do NOT reintroduce `delayedMealAllowance`)
> 4. Confirm standby night meal against EA — if it differs from $10.90, introduce a new canonical rate
> 5. Confirm `RETAIN_MEAL_THRESHOLDS` (Day Large > 19:00 / +Small > 22:00; Night Large > 09:00 / +Small > 13:00) against EA
> 6. Complete at least one real-world payslip comparison for each claim type
> 7. Optionally: confirm the retain-amount formula so it can be auto-calculated

---

*Last updated: 2026-05 (v1.2) — canonical-rate refactor: editable rates collapsed to `kilometreRate`, `smallMealAllowance`, `largeMealAllowance`; double meal derived; spoilt, delayed, standby-night meals sourced from `smallMealAllowance`; overnight cash captured per-claim. Validation suite updated and passing. — Danny Tinitali, Fire Allowance Tracker*
