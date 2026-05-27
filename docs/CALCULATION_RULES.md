# Fire Allowance Tracker — Calculation Rules

**Version:** 1.3
**Last reviewed:** 2026-05 (canonical-rate refactor — double meal derived from small + large; spoilt, delayed and standby-night meals all source the canonical `smallMealAllowance`; the obsolete `overnightAllowance` rate has been removed because overnight cash is captured per-claim, not as a rate)
**Status:** Active — review annually when award or ATO rates change

---

## Overview

This document is the canonical specification for every financial calculation in the Fire Allowance Tracker. It defines every formula, every adjustable rate, all assumptions, edge cases, and unresolved business-rule ambiguities.

All calculations are implemented in **`lib/calculations/engine.js`**.  
All default rates are defined in **`lib/calculations/defaultRates.js`**.  
User-editable rates are stored in Supabase table **`fat.user_rates`**.

**Golden rule:** No arithmetic on dollar amounts may appear anywhere in the app except inside `engine.js`.

---

## 1. Rounding

All monetary values are rounded to **2 decimal places** using standard half-up rounding.

**Function:** `roundMoney(value)` in `engine.js`

**Implementation:**
```js
Math.round((value + Number.EPSILON) * 100) / 100
```

`Number.EPSILON` is added before rounding to prevent float representation errors (e.g. `0.1 + 0.2 = 0.30000000000000004`).

**Rules:**
- Every calculation result is passed through `roundMoney()` before being returned.
- Totals are computed from rounded sub-components (not from raw floats).
- Dashboard totals sum stored `total_amount` values (already rounded at creation time).
- A claim's displayed amount always matches what is stored in Supabase.

---

## 2. Recall Claims (`recalls` table)

### What a Recall Claim Covers

A recall claim records the **allowance components** of being recalled to work outside of rostered hours. It does **not** calculate base recall pay (hours × hourly rate) — that is a payroll system function.

The `total_amount` on a recall claim is:

```
total_amount = travel_amount + mealie_amount
```

### Travel Component

```
travel_amount = total_km × kilometre_rate
total_km      = dist_home_km + dist_stn_km
```

- `dist_home_km` — kilometres from the firefighter's home to the station attended.
- `dist_stn_km` — additional kilometres if recalled to a different station than the rostered one. Set to 0 if same station.
- `kilometre_rate` — FRV/FBEU per-kilometre award reimbursement rate (default: $1.20/km — confirmed FRV award rate 2025).

### Meal Component (`mealie_amount`)

| Entitlement | Amount | Source | Condition |
|---|---|---|---|
| `none`   | $0.00 | — | No meal break disrupted |
| `small`  | `smallMealAllowance` ($10.90)  | ✅ Confirmed FRV | One disrupted meal break |
| `large`  | `largeMealAllowance` ($20.55)  | ✅ Confirmed FRV | Full meal allowance (extended shift). **Flat confirmed rate — NOT derived as 2× small.** |
| `double` | `smallMealAllowance + largeMealAllowance` ($31.45 derived) | ✅ Derived from canonical rates | Double meal allowance. **Derived at calculation time** — there is no editable `doubleMealAllowance` rate. For ATO purposes a double meal counts as 1 small + 1 large. See `calcDoubleMealAllowance()` and `calcMealTaxComponents()` in `engine.js`. |

**⚠️ ASSUMPTION:** The threshold for small vs large vs double meal entitlement (hours worked, shift type) has not been confirmed from the enterprise agreement. The current form asks users to self-select their entitlement. This should be validated against the current award before the app is used for compliance-critical tracking.

### Schema Columns Written

| Column | Value |
|---|---|
| `user_id` | Auth user ID |
| `date` | Claim date |
| `dist_home_km` | From form |
| `dist_stn_km` | From form |
| `travel_amount` | Calculated |
| `mealie_amount` | Calculated |
| `total_amount` | Calculated sum |
| `status` | `'Pending'` (default) |
| `rates_snapshot` | JSONB snapshot of active rates |
| `calculation_inputs` | JSONB of raw inputs |

Note: `total_km` is a generated column in Supabase (`dist_home_km + dist_stn_km`). It must NOT be written by the app.

---

## 3. Spoilt / Delayed Meal Claims (`spoilt` table)

### What a Spoilt/Delayed Claim Covers

A spoilt meal claim is paid when a rostered meal break is interrupted (Spoilt) or held past the scheduled time (Delayed) due to operational demands.

```
total_amount = meal_amount
```

The `spoilt` table uses `meal_amount` (not `total_amount`) as the primary amount column. `resolveStoredAmount()` in `engine.js` handles this transparently.

### Rates

Both Spoilt and Delayed meal claims source the canonical `smallMealAllowance` rate — there is no separate editable rate for either.

| Meal Type | Formula | Amount | Source |
|---|---|---|---|
| `Spoilt`  | `rates.smallMealAllowance` | $10.90 | ✅ Confirmed FRV (2023FY, 2025FY, Current) |
| `Delayed` | `rates.smallMealAllowance` | $10.90 | ⚠️ UNRESOLVED — no separate FRV evidence found; engine collapses Delayed onto the small-meal rate pending EA confirmation |

**Implementation:** `calcSpoiltMealAmount({ mealType }, rates)` in `engine.js` returns `roundMoney(rates.smallMealAllowance)` for both `'Spoilt'` and `'Delayed'` (and for the legacy `'Spoilt / Meal'` value normalised via `normaliseMealType()`).

**Note (Spoilt):** A legacy hardcoded SQL schema default of $22.80 was previously in use. This has been removed from the schema default; the runtime now sources the confirmed FRV rate of $10.90 via `smallMealAllowance`. Existing rows with the old value ($22.80) continue to display correctly via `resolveStoredAmount()` — historical claim amounts are never recalculated.

**Note (Delayed):** No FRV allowance evidence exists for a distinct delayed meal rate, so the runtime sources `smallMealAllowance` for Delayed claims as well. If the EA later confirms a different value, introduce a distinct canonical rate at that time — do not reintroduce a free-floating `delayedMealAllowance` rate without evidence.

### Schema Columns Written

| Column | Value |
|---|---|
| `user_id` | Auth user ID |
| `date` | Claim date |
| `meal_type` | `'Spoilt'` or `'Delayed'` |
| `meal_amount` | Calculated |
| `status` | `'Pending'` |
| `rates_snapshot` | JSONB |
| `calculation_inputs` | JSONB |

---

## 4. Standby Claims (`standby` table)

### What a Standby Claim Covers

A standby or M&D (Mobile & Deployed) claim records allowances for working at a non-home station or remaining on standby.

```
total_amount = travel_amount + night_mealie
```

### Travel Component

```
travel_amount = dist_km × kilometre_rate
```

- `dist_km` — total kilometres for the standby (user-entered or from station distance lookup).
- If the firefighter was called from home (`free_from_home = true`), the home→station km should be included in `dist_km`.

### Night Meal Component

The night meal is sourced from the canonical `smallMealAllowance` rate — there is no separate editable `standbyNightMealAllowance`.

```
night_mealie = smallMealAllowance   (if eligible — see below)
             = 0                    (otherwise)
```

**Eligibility** (`isStandbyNightMealEligible()` in `engine.js`):
- M&D claims never receive a night meal.
- Standby Day shift never receives a night meal.
- Standby Night shift receives the meal only when the arrival time is **>= 19:00**.

**⚠️ ASSUMPTION:** Night meal on standby equals the canonical small meal allowance. Confirm against the current enterprise agreement; if the EA defines a distinct night meal value, introduce a new canonical rate at that time rather than reintroducing the removed `standbyNightMealAllowance`.

---

## 5. Retain Claims (`retain` table)

### What a Retain Claim Covers

A retain claim is paid for remaining available at station past the rostered book-off time.

```
total_amount = retain_amount + overnight_cash + meal_amount
```

The `meal_amount` is auto-derived from shift + booked-off time via `calcRetainMealEligibility()` (see `RETAIN_MEAL_THRESHOLDS` in `engine.js`) and priced using the canonical `smallMealAllowance` and `largeMealAllowance` rates only. There is no separate editable retain meal rate.

**⚠️ UNRESOLVED — CRITICAL:** The formula for `retain_amount` (base retain allowance) has not been confirmed from the enterprise agreement. The current implementation treats `retain_amount` as a **user-entered value**. The actual formula likely involves:

- Hours retained (booked-off time to departure time)
- A per-hour allowance rate from the award

Until this is confirmed, `retainAllowancePerHour` in `defaultRates.js` is set to 0. **This must be resolved before the app is used for retain claim tracking.**

`overnight_cash` is always user-entered per-claim — it represents an overnight component that the user has independently determined from their pay advice. **There is no editable `overnightAllowance` rate** — the previous rate-driven model was removed because overnight cash varies per claim and is not a uniform award amount.

---

## 6. Travel / Kilometre Rate

**Current rate:** $1.20/km (user-confirmed award rate 2025)

**Source:** NSW Fire Brigades / FBEU Enterprise Agreement. This is an award rate, not the ATO cents-per-kilometre rate.

**Review trigger:** Update when the enterprise agreement is renegotiated. Also review annually at 1 July in case ATO rate exceeds award rate. Update `defaultRates.js` and notify users to review their saved rates.

**Formula:**
```
travel_amount = roundMoney(km × kilometre_rate)
```

---

## 7. Rates System

### Default Rates (canonical only)

Defined in `lib/calculations/defaultRates.js`. The Settings UI exposes only these three canonical editable rates (see `RATE_FIELDS`). All other meal-allowance values are **derived at calculation time** from these — there are no editable rates for double / spoilt / delayed / standby-night meal, and overnight cash is captured per-claim.

| Rate Key | Default | Status | Description |
|---|---|---|---|
| `kilometreRate` | $1.20/km | ✅ Confirmed | Award rate (user-confirmed 2025) |
| `smallMealAllowance` | $10.90 | ✅ Confirmed | Single disrupted meal (confirmed FRV). **Also the source rate for Spoilt, Delayed and Standby-Night meals.** |
| `largeMealAllowance` | $20.55 | ✅ Confirmed | Full meal allowance (confirmed FRV — flat rate, NOT 2× small). |

#### Derived / sourced allowances (not editable rates)

| Allowance | Sourced from | Notes |
|---|---|---|
| Double meal | `smallMealAllowance + largeMealAllowance` (= $31.45) | Derived at calculation time via `calcDoubleMealAllowance()`. For ATO tax decomposition a double meal counts as 1 small + 1 large (`calcMealTaxComponents()`). |
| Spoilt meal | `smallMealAllowance` (= $10.90) | `calcSpoiltMealAmount({ mealType: 'Spoilt' }, rates)` returns the small meal value. |
| Delayed meal | `smallMealAllowance` (= $10.90) | Collapsed onto small meal pending FRV confirmation. See §3. |
| Standby-night meal | `smallMealAllowance` (= $10.90) | Paid only when `isStandbyNightMealEligible()` returns true (Night shift, arrival ≥ 19:00, not M&D). |
| Retain meal | `smallMealAllowance` and/or `largeMealAllowance` | Quantities (`smallCount`, `largeCount`) come from `calcRetainMealEligibility()` (shift + booked-off time); priced using canonical rates only. |
| Overnight cash (Retain) | **per-claim user input** | Not a rate. There is no `overnightAllowance` rate — the value is captured on the Retain form per claim. |

The previously editable rates `doubleMealAllowance`, `spoiltMealAllowance`, `delayedMealAllowance`, `standbyNightMealAllowance`, and `overnightAllowance` have been **removed** from `defaultRates.js`. Any older `rates_snapshot` JSONB that still contains those keys is ignored at calculation time — historical claim amounts remain protected via `resolveStoredAmount()`.

### User Overrides

Stored in `fat.user_rates` (one row per user). Loaded by `RatesContext.js` and merged over defaults.

**How merging works:**
```js
activeRates = { ...DEFAULT_RATES, ...userSavedRates }
```

If a user has no saved row, all defaults apply. If a user has a partial row (some keys null), defaults fill in the gaps.

### Rate Changes and Historical Claims

**CRITICAL:** When a user updates their rates:
- **New claims** use the new rates immediately.
- **Existing claims** are NEVER recalculated. Their `total_amount` is preserved exactly as stored.

This is enforced by:
1. `resolveStoredAmount()` always reading from the database column.
2. `calcDashboardSummary()` summing stored amounts only.
3. No code path re-derives amount from rates at display time.

### Rate Snapshot

Every claim stores a `rates_snapshot` JSONB column containing the rates that were active at creation time. This enables:
- Future auditing of why a claim had a particular value.
- Detecting rate changes that might affect the user's expectations.
- Potential future "recalculate with current rates" feature (must be manual/explicit).

---

## 8. Historical Claim Protection

**Rule:** A saved claim's `total_amount` (or `meal_amount` for spoilt) is the ground truth. It must never change unless a user explicitly edits it.

**How this is implemented:**
- `addClaim()` calculates and writes `total_amount` once at creation.
- `updateClaim()` only updates `date`, `total_amount`, and `status` — and only when the user explicitly edits a claim.
- `loadClaims()` reads raw stored values.
- `resolveStoredAmount()` reads stored values without any calculation.
- The dashboard totals are sums of stored `total_amount` values.

**What "editing a claim" means:**
- The Edit modal allows changing date, amount, and status.
- Changing the amount is a manual override — the new value is not recalculated from rates.
- `rates_snapshot` and `calculation_inputs` on the existing row are NOT updated when editing.

---

## 9. Dashboard Summary Totals

```
grandTotal   = Σ resolveStoredAmount(claim) for all claims
pendingTotal = Σ resolveStoredAmount(claim) where status == 'Pending'
paidTotal    = Σ resolveStoredAmount(claim) where status == 'Paid'
byType[t]    = Σ resolveStoredAmount(claim) where claimType == t
```

All sums are passed through `roundMoney()` at the end.

---

## 10. Validation Framework

Run `lib/calculations/validationScenarios.js` to verify all formulas.

**Covered scenarios:**
- `roundMoney` — float drift, null input, NaN input, half-up rounding
- `calcTravelAmount` — typical distances, zero, fractional km, large distances
- `calcTotalKm` — home + station combination
- `calcMealAllowance` — none/small/large/double (derived = small + large), unknown type guard
- `calcDoubleMealAllowance` — derived = small + large; missing-rates guard
- `calcSpoiltMealAmount` — Spoilt and Delayed both source `smallMealAllowance`, unknown type guard, legacy `Spoilt / Meal` compatibility
- `calcRecallClaim` — typical recall, travel-only, small/large/double meal, all-zero
- `calcRetainClaim` — with/without overnight, all-zero
- `calcStandbyClaim` — day/night, with/without travel
- `calcSpoiltClaim` — Spoilt, Delayed, legacy `Spoilt / Meal`
- `resolveStoredAmount` — column priority cascade, all-null
- `calcDashboardSummary` — mixed claims, empty array
- Rounding edge cases — 7.5km precision, sum stability, rate change impact

**To run:**
```bash
node lib/calculations/validationScenarios.js
```

---

## 11. Unresolved Business-Rule Ambiguities

These items require confirmation with the current enterprise agreement or pay office before the app is used for compliance-critical tracking:

| # | Topic | Current Assumption | Risk |
|---|---|---|---|
| 1 | Recall meal entitlement threshold | User self-selects none/small/large/double | May not match award threshold (e.g. "4 hours worked = small meal") |
| 2 | Retain hourly allowance formula | User enters retain_amount manually | Cannot auto-calculate retain until formula is confirmed |
| 3 | Overnight cash | User-entered per-claim (no rate) | The previous rate-based overnight model has been removed. If an EA-specified flat overnight rate is ever confirmed, evaluate whether to reintroduce a canonical rate. |
| 4 | Delayed meal allowance | Sourced from `smallMealAllowance` ($10.90) — no separate FRV evidence | ⚠️ UNRESOLVED — confirm against EA whether Delayed differs from the small meal value before relying on Delayed claims |
| 5 | Standby M&D vs Standby rates | Same travel rate applied | Confirm if M&D has a different meal/travel allowance |
| 6 | Night meal for standby = small meal | Sourced from `smallMealAllowance` ($10.90); paid only on Night-shift Standby with arrival ≥ 19:00 (never M&D) | Confirm this equals the EA night meal value |
| 7 | FRV km rate review date | 1 July each year | Set a calendar reminder to review annually |
| 8 | Recall meal entitlement trigger thresholds | User self-selects | EA may define objective hour thresholds for none/small/large/double |

---

## 12. How to Update Rates When the Award Changes

Only the three canonical rates (`kilometreRate`, `smallMealAllowance`, `largeMealAllowance`) are editable — derived allowances move automatically when their canonical inputs change.

1. Update `DEFAULT_RATES` and `RATE_FIELDS` in `lib/calculations/defaultRates.js` with the new values for the relevant canonical rate(s).
2. Update the column defaults on `fat.user_rates` in `supabase/fat-schema.sql` to match (for new users).
3. Update this document with the new values and the review date.
4. Notify existing users to review their saved rates in Settings (they will not auto-update).
5. Run `node lib/calculations/validationScenarios.js` to verify all tests still pass.
6. Deploy and verify on the Vercel preview before merging to main.

If the EA introduces a *new* allowance that is genuinely not derivable from small + large (and is not a per-claim cash field), add a new canonical rate — do **not** reintroduce the removed `doubleMealAllowance`, `spoiltMealAllowance`, `delayedMealAllowance`, `standbyNightMealAllowance`, or `overnightAllowance` keys.

---

*Last updated: 2026-05 (v1.3 — canonical-rate refactor: removed editable double/spoilt/delayed/standby-night meal rates (now derived from `smallMealAllowance` and `largeMealAllowance`) and removed `overnightAllowance` (overnight cash captured per-claim). v1.2 corrections to large meal ($20.55), spoilt meal ($10.90), and the added double meal ($31.45 = small + large) remain in effect.) — Danny Tinitali, Fire Allowance Tracker*
