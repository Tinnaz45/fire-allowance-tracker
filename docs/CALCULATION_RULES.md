# Fire Allowance Tracker — Calculation Rules

**Version:** 1.2  
**Last reviewed:** 2026-05 (large meal, double meal, and spoilt meal corrected from FRV historical allowance records)  
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
- `kilometre_rate` — ATO per-kilometre reimbursement rate (default: $0.99/km for 2024-25).

### Meal Component (`mealie_amount`)

| Entitlement | Amount | Source | Condition |
|---|---|---|---|
| `none`   | $0.00 | — | No meal break disrupted |
| `small`  | `smallMealAllowance` ($10.90)  | ✅ Confirmed FRV | One disrupted meal break |
| `large`  | `largeMealAllowance` ($20.55)  | ✅ Confirmed FRV | Full meal allowance (extended shift). **Flat confirmed rate — NOT derived as 2× small.** |
| `double` | `doubleMealAllowance` ($31.45) | ✅ Confirmed FRV | Double meal allowance. Source: FRV Allowances 2023FY, 2025FY, and Current. |

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

| Meal Type | Formula | Amount | Source |
|---|---|---|---|
| `Spoilt`  | `rates.spoiltMealAllowance`  | $10.90 | ✅ Confirmed FRV (2023FY, 2025FY, Current) |
| `Delayed` | `rates.delayedMealAllowance` | $10.90 | ⚠️ UNRESOLVED — no FRV evidence found; placeholder only |

**Note (Spoilt):** A legacy hardcoded SQL schema default of $22.80 was previously in use. This has been removed from the schema default and replaced by the confirmed FRV rate of $10.90. Existing rows with the old value ($22.80) will continue to display correctly via `resolveStoredAmount()` — historical claim amounts are never recalculated.

**Note (Delayed):** No FRV allowance evidence was found for the delayed meal rate. The current placeholder value ($10.90) must be confirmed against the enterprise agreement before the app is used for compliance-critical Delayed claim tracking.

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

```
night_mealie = standbyNightMealAllowance   (if Night shift)
             = 0                           (if Day shift)
```

Default `standbyNightMealAllowance`: $10.90 (assumed equal to `smallMealAllowance`).

**⚠️ ASSUMPTION:** Night meal on standby equals small meal allowance. Confirm this is correct for all standby types (Standby vs M&D) in the current enterprise agreement.

---

## 5. Retain Claims (`retain` table)

### What a Retain Claim Covers

A retain claim is paid for remaining available at station past the rostered book-off time.

```
total_amount = retain_amount + overnight_cash
```

**⚠️ UNRESOLVED — CRITICAL:** The formula for `retain_amount` (base retain allowance) has not been confirmed from the enterprise agreement. The current implementation treats `retain_amount` as a **user-entered value**. The actual formula likely involves:

- Hours retained (booked-off time to departure time)
- A per-hour allowance rate from the award

Until this is confirmed, `retainAllowancePerHour` in `defaultRates.js` is set to 0. **This must be resolved before the app is used for retain claim tracking.**

`overnight_cash` is always user-entered — it represents an overnight component that the user has independently determined from their pay advice.

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

### Default Rates

Defined in `lib/calculations/defaultRates.js`. Used when a user has no saved overrides.

| Rate Key | Default | Status | Description |
|---|---|---|---|
| `kilometreRate` | $1.20/km | ✅ Confirmed | Award rate (user-confirmed 2025) |
| `smallMealAllowance` | $10.90 | ✅ Confirmed | Single disrupted meal (confirmed FRV) |
| `largeMealAllowance` | $20.55 | ✅ Confirmed | Full meal allowance (confirmed FRV — flat rate, NOT 2× small) |
| `doubleMealAllowance` | $31.45 | ✅ Confirmed | Double meal allowance (confirmed FRV 2023FY, 2025FY, Current) |
| `spoiltMealAllowance` | $10.90 | ✅ Confirmed | Spoilt meal (fire call interrupts break) (confirmed FRV) |
| `delayedMealAllowance` | $10.90 | ⚠️ UNRESOLVED | Delayed past rostered meal break — no FRV evidence found; placeholder only |
| `overnightAllowance` | $0.00 | User-set | Overnight stay; must be set per user |
| `standbyNightMealAllowance` | $10.90 | ⚠️ Unconfirmed | Night standby meal (assumed = small meal) |

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
- `calcMealAllowance` — none/small/large/double, unknown type guard
- `calcSpoiltMealAmount` — Spoilt ($10.90 confirmed), Delayed (placeholder), unknown type guard
- `calcOvernightAllowance` — active/inactive
- `calcRecallClaim` — typical recall, travel-only, small/large/double meal, all-zero
- `calcRetainClaim` — with/without overnight, all-zero
- `calcStandbyClaim` — day/night, with/without travel
- `calcSpoiltClaim` — Spoilt, Delayed
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
| 3 | Overnight allowance | User-entered via rate settings | Default is $0; must be set per user |
| 4 | Delayed meal allowance | $10.90 (placeholder — no FRV evidence) | ⚠️ UNRESOLVED — must confirm from enterprise agreement before relying on Delayed claims |
| 5 | Standby M&D vs Standby rates | Same travel rate applied | Confirm if M&D has a different meal/travel allowance |
| 6 | Night meal for standby = small meal | standbyNightMealAllowance = $10.90 | Confirm this equals smallMealAllowance in the award |
| 7 | ATO km rate review date | 1 July each year | Set a calendar reminder to review annually |
| 8 | Recall meal entitlement trigger thresholds | User self-selects | EA may define objective hour thresholds for none/small/large/double |

---

## 12. How to Update Rates When the Award Changes

1. Update `DEFAULT_RATES` in `lib/calculations/defaultRates.js` with the new values.
2. Update the column defaults on `fat.user_rates` in `supabase/fat-schema.sql` to match (for new users).
3. Update this document with the new values and the review date.
4. Notify existing users to review their saved rates in Settings (they will not auto-update).
5. Run `node lib/calculations/validationScenarios.js` to verify all tests still pass.
6. Deploy and verify on the Vercel preview before merging to main.

---

*Last updated: 2026-05 (v1.2 — large meal corrected to $20.55 from FRV records; double meal $31.45 added; spoilt meal corrected to $10.90; delayed meal flagged UNRESOLVED; doubleMealAllowance added to engine and rate snapshot) — Danny Tinitali, Fire Allowance Tracker*
