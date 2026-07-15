// ─── Calculation Engine ────────────────────────────────────────────────────────
// Canonical, centralized financial calculation functions for all claim types.
//
// RULES:
//  - Every monetary result is passed through roundMoney() before returning.
//  - No hardcoded dollar amounts. All rates come from a `rates` parameter.
//  - Functions are pure (no side effects, no Supabase calls, no UI dependencies).
//  - All inputs are validated; invalid/missing values produce 0, never NaN.
//  - These functions are the ONLY place arithmetic on claim amounts should happen.
//
// Consumers must call these functions with the active rates object from useRates().
// See lib/calculations/RatesContext.js.
//
// EXCEPTION — canonical award constants: a small number of award values are
// fixed (not user-editable) and live in defaultRates.js as named exports. The
// retain (Maint Stn N/N) overtime hourly rate is one such constant: it is a
// confirmed payroll rate, never sourced from per-user rates. It is imported
// here so retain $ derivation has a single source of truth.
// ─────────────────────────────────────────────────────────────────────────────

import { RETAIN_OVERTIME_HOURLY_RATE } from './defaultRates.js'

// ─── Rounding ─────────────────────────────────────────────────────────────────

/**
 * Round a monetary value to 2 decimal places using standard half-up rounding.
 * @param {number} value
 * @returns {number}
 */
export function roundMoney(value) {
  if (value == null || !isFinite(value) || isNaN(value)) return 0
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * Safely parse a number from any input. Returns 0 for null/undefined/empty/NaN.
 */
function safeNum(v) {
  const n = Number(v)
  return isFinite(n) && !isNaN(n) ? n : 0
}

// ─── Financial Year Helpers ────────────────────────────────────────────────────

/**
 * Determine the financial year label for a given date.
 * Australian FY: 1 July → 30 June.
 * e.g. 2025-07-01 → '2026FY', 2026-03-15 → '2026FY'
 *
 * @param {Date|string} date
 * @returns {string} e.g. '2026FY'
 */
export function getFYLabel(date) {
  const d = date instanceof Date ? date : new Date(date)
  const year = d.getFullYear()
  const month = d.getMonth() + 1 // 1-indexed
  return month >= 7 ? `${year + 1}FY` : `${year}FY`
}

/**
 * Return the start and end dates for a given FY label.
 * e.g. '2026FY' → { start: '2025-07-01', end: '2026-06-30' }
 *
 * @param {string} label e.g. '2026FY'
 * @returns {{ start: string, end: string }}
 */
export function getFYDateRange(label) {
  const year = parseInt(label.replace('FY', ''), 10)
  return {
    start: `${year - 1}-07-01`,
    end:   `${year}-06-30`,
  }
}

/**
 * Returns today's FY label.
 * @returns {string}
 */
export function currentFYLabel() {
  return getFYLabel(new Date())
}

// ─── Date Formatting ──────────────────────────────────────────────────────────

/**
 * Format a date as DD/MM/YY (Australian operational format).
 * @param {Date|string} date
 * @returns {string} e.g. '12/02/26'
 */
export function formatDateDDMMYY(date) {
  if (!date) return '—'
  const d = date instanceof Date ? date : new Date(date + 'T00:00:00')
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yy = String(d.getFullYear()).slice(-2)
  return `${dd}/${mm}/${yy}`
}

/**
 * Format a date as DD/MM/YYYY (full year).
 * @param {Date|string} date
 * @returns {string} e.g. '12/02/2026'
 */
export function formatDateDDMMYYYY(date) {
  if (!date) return '—'
  const d = date instanceof Date ? date : new Date(date + 'T00:00:00')
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${dd}/${mm}/${yyyy}`
}

// ─── Claim Naming ─────────────────────────────────────────────────────────────

const CLAIM_TYPE_SHORT = {
  recalls:      'Recall',
  retain:       'Retain',
  standby:      'Standby',
  md:           'M&D',
  spoilt:       'Spoilt Meal',
  delayed_meal: 'Delayed Meal',
}

/**
 * Build the display label for a claim group.
 * e.g. 'Recall #16 (12/02/2026)'
 *
 * @param {string} claimType  — 'recalls' | 'retain' | 'standby' | 'spoilt'
 * @param {number} number     — sequential number within FY
 * @param {string|Date} date  — incident date
 * @returns {string}
 */
export function buildClaimLabel(claimType, number, date) {
  const typeName = CLAIM_TYPE_SHORT[claimType] || claimType
  const dateStr  = formatDateDDMMYYYY(date)
  return `${typeName} #${number} (${dateStr})`
}

// ─── Overdue Logic ────────────────────────────────────────────────────────────

const OVERDUE_DAYS = 28

/**
 * Return true if a pending claim is overdue (> 4 weeks since created_at).
 *
 * @param {object} claim — row with status and created_at
 * @returns {boolean}
 */
export function isClaimOverdue(claim) {
  if (!claim) return false
  if ((claim.status || '').toLowerCase() !== 'pending') return false
  if (!claim.created_at) return false
  const created = new Date(claim.created_at)
  const now = new Date()
  const diffDays = (now - created) / (1000 * 60 * 60 * 24)
  return diffDays > OVERDUE_DAYS
}

// ─── Standby Night Meal Eligibility ──────────────────────────────────────────

/**
 * Parse a standby arrival time into total minutes since midnight.
 * Accepts both "HH:MM" (legacy form) and "HHMM" 4-digit numeric string
 * (canonical internal format). Returns null on invalid / empty input.
 *
 * @param {string} t
 * @returns {number|null}
 */
export function parseStandbyArrivedTime(t) {
  if (t == null) return null
  const s = String(t).trim()
  if (!s) return null
  let h, m
  if (s.includes(':')) {
    const [hStr, mStr] = s.split(':')
    h = parseInt(hStr, 10)
    m = parseInt(mStr || '0', 10)
  } else {
    // "1930" → 19h 30m. "930" → 9h 30m. Pad-left to 4 digits.
    const padded = s.padStart(4, '0')
    h = parseInt(padded.slice(0, 2), 10)
    m = parseInt(padded.slice(2, 4), 10)
  }
  if (!isFinite(h) || !isFinite(m)) return null
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return h * 60 + m
}

/**
 * Normalize a standby arrival time to the canonical "HHMM" 4-digit string.
 * Returns null if input cannot be parsed.
 *
 * @param {string} t
 * @returns {string|null}
 */
export function normaliseStandbyArrivedTime(t) {
  const mins = parseStandbyArrivedTime(t)
  if (mins == null) return null
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return String(h).padStart(2, '0') + String(m).padStart(2, '0')
}

/**
 * Determine if a standby claim qualifies for a small meal allowance.
 *
 * Rule: Day standby is NEVER eligible. Night standby is eligible when
 * arrival time is >= 19:00 (19:00 exactly DOES qualify). M&D type claims
 * never receive a meal allowance.
 *
 * @param {object} params
 * @param {string}  params.standbyType  — 'Standby' | 'M&D'
 * @param {string}  params.shift        — 'Day' | 'Night'
 * @param {string}  params.arrivedTime  — "HH:MM" or "HHMM", or empty
 * @returns {boolean}
 */
export function isStandbyNightMealEligible({ standbyType, shift, arrivedTime }) {
  if (standbyType === 'M&D') return false
  if (shift !== 'Night') return false
  const mins = parseStandbyArrivedTime(arrivedTime)
  if (mins == null) return false
  return mins >= 19 * 60
}

// ─── Spoilt / Delayed Meal Window Helpers ────────────────────────────────────

/**
 * Return the rostered meal window for a given shift.
 * Day:   12:00–13:00
 * Night: 18:30–19:30
 *
 * @param {'Day'|'Night'} shift
 * @returns {{ start: string, end: string, label: string }}
 */
export function getMealWindow(shift) {
  if (shift === 'Night') {
    return { start: '18:30', end: '19:30', label: '18:30–19:30' }
  }
  return { start: '12:00', end: '13:00', label: '12:00–13:00' }
}

/**
 * Check if a given time string (HH:MM) falls within the meal window for a shift.
 * Returns 'inside', 'before', or 'after'.
 *
 * @param {string}       timeStr  — 'HH:MM'
 * @param {'Day'|'Night'} shift
 * @returns {'inside'|'before'|'after'|'unknown'}
 */
export function checkTimeInMealWindow(timeStr, shift) {
  if (!timeStr) return 'unknown'
  const window = getMealWindow(shift)

  const toMins = (t) => {
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }

  const t = toMins(timeStr)
  const s = toMins(window.start)
  const e = toMins(window.end)

  if (t < s) return 'before'
  if (t > e) return 'after'
  return 'inside'
}

// ─── Travel ───────────────────────────────────────────────────────────────────

/**
 * Calculate travel reimbursement for a given distance.
 * Formula: km × rates.kilometreRate
 *
 * @param {object} params
 * @param {number} params.km
 * @param {object} rates
 * @returns {number}
 */
export function calcTravelAmount({ km }, rates) {
  const distance = safeNum(km)
  if (distance <= 0) return 0
  return roundMoney(distance * safeNum(rates.kilometreRate))
}

/**
 * Calculate total km for a recall.
 * Recall route: Home → Rostered Stn → Recall Stn → Rostered Stn → Home
 * = (distHomeKm × 2) + (distStnKm × 2)
 *
 * @param {object} params
 * @param {number} params.distHomeKm   — one-way km, home → rostered station
 * @param {number} params.distStnKm    — one-way km, rostered station → recall station
 * @returns {number} — total return km
 */
export function calcRecallTotalKm({ distHomeKm, distStnKm }) {
  const home = safeNum(distHomeKm)
  const stn  = safeNum(distStnKm)
  return roundMoney((home * 2) + (stn * 2))
}

/**
 * Legacy alias — retained for backward compatibility.
 */
export function calcTotalKm({ distHomeKm, distStnKm }) {
  return calcRecallTotalKm({ distHomeKm, distStnKm })
}

// ─── Meals ────────────────────────────────────────────────────────────────────

/**
 * Calculate meal allowance for a recall or standby claim.
 *
 * Double meal is derived = small + large (and also counts as 1 small + 1 large
 * for tax reporting). See calcMealTaxComponents() for ATO decomposition.
 *
 * @param {object} params
 * @param {'none'|'small'|'large'|'double'} params.mealEntitlement
 * @param {object} rates
 * @returns {number}
 */
export function calcMealAllowance({ mealEntitlement }, rates) {
  const small = safeNum(rates.smallMealAllowance)
  const large = safeNum(rates.largeMealAllowance)
  switch (mealEntitlement) {
    case 'small':  return roundMoney(small)
    case 'large':  return roundMoney(large)
    case 'double': return roundMoney(small + large)
    default:       return 0
  }
}

/**
 * Derived double meal allowance = small + large.
 * Exposed so the Settings UI can render the read-only derived value.
 *
 * @param {object} rates
 * @returns {number}
 */
export function calcDoubleMealAllowance(rates) {
  return roundMoney(safeNum(rates?.smallMealAllowance) + safeNum(rates?.largeMealAllowance))
}

/**
 * For tax reporting: decompose a meal entitlement into small + large counts.
 * A double meal counts as 1 small AND 1 large (ATO purposes).
 *
 * @param {'none'|'small'|'large'|'double'} mealEntitlement
 * @returns {{ smallCount: number, largeCount: number }}
 */
export function calcMealTaxComponents(mealEntitlement) {
  switch (mealEntitlement) {
    case 'small':  return { smallCount: 1, largeCount: 0 }
    case 'large':  return { smallCount: 0, largeCount: 1 }
    case 'double': return { smallCount: 1, largeCount: 1 }
    default:       return { smallCount: 0, largeCount: 0 }
  }
}

/**
 * Calculate spoilt/delayed meal allowance.
 * Both Spoilt and Delayed = smallMealAllowance (confirmed FRV).
 *
 * @param {object} params
 * @param {'Spoilt'|'Delayed'} params.mealType
 * @param {object} rates
 * @returns {number}
 */
export const LEGACY_MEAL_TYPE_MAP = {
  'Spoilt / Meal': 'Spoilt',
}

/**
 * Normalise a stored meal_type value.
 * Handles legacy DB records where meal_type = 'Spoilt / Meal'.
 * @param {string|null} mealType
 * @returns {'Spoilt'|'Delayed'}
 */
export function normaliseMealType(mealType) {
  if (!mealType) return 'Spoilt'
  return LEGACY_MEAL_TYPE_MAP[mealType] ?? mealType
}

export function calcSpoiltMealAmount({ mealType }, rates) {
  const canonical = normaliseMealType(mealType)
  if (canonical !== 'Spoilt' && canonical !== 'Delayed') return 0
  return roundMoney(safeNum(rates.smallMealAllowance))
}

// ─── Recall ───────────────────────────────────────────────────────────────────

/**
 * EBA Recall meal entitlement rules.
 *
 * Day-shift recall boundary  = 18:00 (standard finish)
 * Night-shift recall boundary = 08:00 (standard finish)
 * Minimum recall duration that qualifies for any meal = 4h.
 *
 * Day shift:
 *   arrival ≤ 09:59 → 1× Large + 1× Small  (recall spans both meal windows)
 *   arrival ≥ 10:00 → 1× Large only
 * Night shift:
 *   always 1× Large only, never double.
 * Notified recall:
 *   suppresses all entitlements regardless of shift / arrival.
 */
export const RECALL_DAY_CUTOFF        = '09:59' // ≤ this arrival ⇒ Day shift L+S
export const RECALL_SHIFT_END = { Day: '18:00', Night: '08:00' }
export const RECALL_MIN_DURATION_MIN  = 4 * 60  // 4h minimum recall to earn a meal

/**
 * Pure, deterministic Recall meal entitlement calculator.
 *
 * @param {object} params
 * @param {'Day'|'Night'|null} params.shift
 * @param {boolean}            params.notified
 * @param {string}             params.arrivalTime    — 'HH:MM' 24-hour
 * @param {string}             [params.bookedOffTime] — 'HH:MM' 24-hour, optional
 * @returns {{
 *   smallCount: number,
 *   largeCount: number,
 *   mealEntitlement: 'none'|'large'|'double',
 *   tier: 'none'|'large'|'large+small'|'notified',
 *   label: string,
 *   durationMin: number|null,
 *   reason: string,
 * }}
 */
export function calculateRecallMealEntitlements({ shift, notified, arrivalTime, bookedOffTime }) {
  if (notified) {
    return {
      smallCount: 0, largeCount: 0, mealEntitlement: 'none',
      tier: 'notified', durationMin: null,
      label: 'No meal allowances are entitled for Notified Recalls',
      reason: 'notified',
    }
  }
  if (shift !== 'Day' && shift !== 'Night') {
    return {
      smallCount: 0, largeCount: 0, mealEntitlement: 'none',
      tier: 'none', durationMin: null,
      label: 'Select a shift type to determine entitlement',
      reason: 'no-shift',
    }
  }
  const arrival = parseHHMM(arrivalTime)
  if (arrival == null) {
    return {
      smallCount: 0, largeCount: 0, mealEntitlement: 'none',
      tier: 'none', durationMin: null,
      label: 'Enter arrival time to determine entitlement',
      reason: 'no-arrival',
    }
  }
  const endOfShift = parseHHMM(RECALL_SHIFT_END[shift])
  const bookedOff  = parseHHMM(bookedOffTime)
  const endBoundary = bookedOff != null ? bookedOff : endOfShift
  let duration = endBoundary - arrival
  if (duration < 0) duration += 24 * 60

  if (duration < RECALL_MIN_DURATION_MIN) {
    return {
      smallCount: 0, largeCount: 0, mealEntitlement: 'none',
      tier: 'none', durationMin: duration,
      label: `Recall duration ${(duration / 60).toFixed(2)}h below ${RECALL_MIN_DURATION_MIN / 60}h minimum — no meal entitlement`,
      reason: 'below-min-duration',
    }
  }

  if (shift === 'Night') {
    return {
      smallCount: 0, largeCount: 1, mealEntitlement: 'large',
      tier: 'large', durationMin: duration,
      label: '1× Large Meal',
      reason: 'night-large',
    }
  }
  // Day shift
  const cutoff = parseHHMM(RECALL_DAY_CUTOFF)
  if (arrival <= cutoff) {
    return {
      smallCount: 1, largeCount: 1, mealEntitlement: 'double',
      tier: 'large+small', durationMin: duration,
      label: '1× Large Meal + 1× Small Meal',
      reason: 'day-double',
    }
  }
  return {
    smallCount: 0, largeCount: 1, mealEntitlement: 'large',
    tier: 'large', durationMin: duration,
    label: '1× Large Meal',
    reason: 'day-large',
  }
}

/**
 * Calculate the allowance components of a Recall claim.
 *
 * Route: Home → Rostered Stn → Recall Stn → Rostered Stn → Home
 * Total km = (distHomeKm × 2) + (distStnKm × 2)
 *
 * NOTE: Base recall pay is a payroll function — NOT calculated here.
 * total_amount = travel_amount + mealie_amount (allowances only).
 *
 * Meal entitlement is auto-derived from shift / notified / arrival /
 * (optional) booked-off via calculateRecallMealEntitlements(). The caller is
 * expected to pass shift, notified, arrivalTime, bookedOffTime — older
 * callers passing only `mealEntitlement` continue to work via the
 * `mealEntitlement` parameter fallback.
 *
 * @param {object} params
 * @param {number}              params.distHomeKm
 * @param {number}              params.distStnKm
 * @param {'Day'|'Night'|null}  [params.shift]
 * @param {boolean}             [params.notified]
 * @param {string}              [params.arrivalTime]
 * @param {string}              [params.bookedOffTime]
 * @param {'none'|'large'|'double'} [params.mealEntitlement] — legacy fallback
 * @param {object} rates
 */
export function calcRecallClaim({ distHomeKm, distStnKm, shift, notified, arrivalTime, bookedOffTime, mealEntitlement }, rates) {
  const home         = safeNum(distHomeKm)
  const stn          = safeNum(distStnKm)
  const totalKm      = calcRecallTotalKm({ distHomeKm: home, distStnKm: stn })
  const travelAmount = calcTravelAmount({ km: totalKm }, rates)

  let entitlement
  if (shift !== undefined || notified !== undefined || arrivalTime !== undefined || bookedOffTime !== undefined) {
    entitlement = calculateRecallMealEntitlements({ shift, notified: !!notified, arrivalTime, bookedOffTime })
  } else {
    entitlement = {
      mealEntitlement: mealEntitlement || 'none',
      smallCount: mealEntitlement === 'double' ? 1 : 0,
      largeCount: mealEntitlement === 'large' || mealEntitlement === 'double' ? 1 : 0,
      tier: mealEntitlement === 'double' ? 'large+small' : mealEntitlement === 'large' ? 'large' : 'none',
      label: '',
      durationMin: null,
      reason: 'legacy',
    }
  }

  const mealieAmount = calcMealAllowance({ mealEntitlement: entitlement.mealEntitlement }, rates)
  const totalAmount  = roundMoney(travelAmount + mealieAmount)

  return {
    travelAmount, mealieAmount, totalAmount,
    totalKm, distHomeKm: home, distStnKm: stn,
    mealEntitlement: entitlement.mealEntitlement,
    smallCount:      entitlement.smallCount,
    largeCount:      entitlement.largeCount,
    mealTier:        entitlement.tier,
    mealLabel:       entitlement.label,
    mealReason:      entitlement.reason,
    durationMin:     entitlement.durationMin,
  }
}

/**
 * Build a human-readable Show Calculation breakdown for a Recall claim.
 *
 * @param {object} params  — same as calcRecallClaim params
 * @param {object} rates
 * @param {object} labels  — optional { rosterStation, recallStation }
 * @returns {string[]}     — array of display lines
 */
export function buildRecallCalcLines({ distHomeKm, distStnKm, shift, notified, arrivalTime, bookedOffTime, mealEntitlement }, rates, labels = {}) {
  const home    = safeNum(distHomeKm)
  const stn     = safeNum(distStnKm)
  const totalKm = calcRecallTotalKm({ distHomeKm: home, distStnKm: stn })
  const travel  = calcTravelAmount({ km: totalKm }, rates)
  const result  = calcRecallClaim(
    { distHomeKm: home, distStnKm: stn, shift, notified, arrivalTime, bookedOffTime, mealEntitlement },
    rates,
  )
  const meal   = result.mealieAmount
  const total  = result.totalAmount
  const entitlement = result.mealEntitlement

  const rosterLabel = labels.rosterStation || 'Rostered Stn'
  const recallLabel = labels.recallStation || 'Recall Stn'

  const lines = ['── Route ──']
  lines.push(`Home → ${rosterLabel}: ${home} km`)
  if (stn > 0) {
    lines.push(`${rosterLabel} → ${recallLabel}: ${stn} km`)
    lines.push(`${recallLabel} → ${rosterLabel}: ${stn} km (return)`)
  }
  lines.push(`${rosterLabel} → Home: ${home} km (return)`)
  lines.push(`Total: ${totalKm} km × $${safeNum(rates.kilometreRate).toFixed(2)}/km = $${travel.toFixed(2)}`)

  lines.push('── Meal Entitlement ──')
  if (notified) {
    lines.push('Notified Recall — no meal allowances entitled.')
  } else if (shift) {
    lines.push(`Shift: ${shift}`)
    if (arrivalTime) lines.push(`Arrival: ${arrivalTime}`)
    if (result.durationMin != null) {
      lines.push(`Duration to standard shift end: ${(result.durationMin / 60).toFixed(2)}h`)
    }
    lines.push(result.mealLabel || '—')
  } else {
    lines.push('Select a shift type to determine entitlement.')
  }
  if (meal > 0) {
    const small = safeNum(rates.smallMealAllowance)
    const large = safeNum(rates.largeMealAllowance)
    const mealLabel = entitlement === 'large' ? 'Large Meal' : entitlement === 'double' ? 'Large + Small Meal' : 'Meal'
    const mealRate = entitlement === 'large' ? large : entitlement === 'double' ? small + large : 0
    lines.push(`${mealLabel} = $${mealRate.toFixed(2)}`)
    if (entitlement === 'double') {
      lines.push(`  (= $${large.toFixed(2)} large + $${small.toFixed(2)} small; counts as 1 small + 1 large for tax)`)
    }
  }

  lines.push(`── Total: $${total.toFixed(2)} ──`)
  return lines
}

// ─── Retain ───────────────────────────────────────────────────────────────────

/**
 * Retain meal-allowance thresholds, indexed by shift type.
 *
 * New EBA model (inclusive ≥ semantics — clock-displayed threshold counts
 * as qualifying):
 *
 *   bookedOff ≥ large    → 1 Large Meal      (first qualifying threshold)
 *   bookedOff ≥ smallAt  → + 1 Small Meal
 *   then  + 1 Small per additional 2-hour threshold reached.
 *
 * Worked examples (Night shift):
 *   retained until 0959 → 1 Large only
 *   1000                → 1 Large + 1 Small
 *   1200                → 1 Large + 2 Small
 *   1400                → 1 Large + 3 Small
 *
 * Day-shift equivalents shift forward by 10 hours.
 *
 * Centralised here so future EBA changes only touch these constants.
 */
export const RETAIN_MEAL_THRESHOLDS = {
  // smallAt = first small threshold; subsequent smalls add every +2h.
  // Mirrors RETAIN_HOUR_BOUNDARIES (smallAt = rosteredFinish + 2h).
  Day:   { large: '19:00', smallAt: '20:00' },
  Night: { large: '09:00', smallAt: '10:00' },
}

const RETAIN_SMALL_STEP_MIN = 2 * 60

/**
 * FRV retain-hour boundaries, indexed by shift type.
 *
 * rosteredFinish — clock time at which retain accrual begins.
 * minTrigger     — clock time at which a mandatory 4.00h minimum applies.
 * maxFlatEnd     — clock time at which post-minimum 0.25h accrual resumes
 *                  beyond the 4.00h floor.
 *
 * Day shift:   18:00 → 19:00 → 22:00
 * Night shift: 08:00 → 09:00 → 12:00
 */
export const RETAIN_HOUR_BOUNDARIES = {
  Day:   { rosteredFinish: '18:00', minTrigger: '19:00', maxFlatEnd: '22:00' },
  Night: { rosteredFinish: '08:00', minTrigger: '09:00', maxFlatEnd: '12:00' },
}

export const RETAIN_MIN_HOURS  = 4.0
export const RETAIN_MAX_HOURS  = 24.0
export const RETAIN_INCREMENT  = 0.25  // 15 minutes, ceiling-rounded

function parseHHMM(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null
  const m = timeStr.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const mn = parseInt(m[2], 10)
  if (!isFinite(h) || !isFinite(mn)) return null
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null
  return h * 60 + mn
}

/**
 * Calculate FRV-compliant retain hours from shift type + booked-off time.
 *
 * Hours are derived from elapsed time since the rostered finish of the shift:
 *
 *   1. Booked off ≤ rostered finish              → 0.00h (no retain)
 *   2. Between rostered finish and min trigger   → ceil(elapsed / 15 min) × 0.25h
 *   3. At min trigger, up to max flat end        → mandatory 4.00h minimum
 *   4. After max flat end                        → 4.00h + ceil(beyond / 15) × 0.25h
 *   5. Hard cap                                  → 24.00h
 *
 * Day-shift worked examples:
 *   18:15 → 0.25h      (15 min, pre-trigger)
 *   18:25 → 0.50h      (25 min → ceil(25/15)×0.25)
 *   18:55 → 1.00h      (55 min → ceil(55/15)×0.25)
 *   19:00 → 4.00h      (mandatory minimum)
 *   22:00 → 4.00h      (still in mandatory window)
 *   22:01 → 4.25h      (1 min past 22:00 → +0.25h)
 *   22:15 → 4.25h      (15 min past 22:00 → +0.25h)
 *   00:30 → 6.50h      (cross-midnight: 2h30m past 22:00 → 4.00 + 2.50)
 *
 * Night-shift mirrors Day at 08:00/09:00/12:00.
 *
 * Cross-midnight: if booked-off clock time is earlier than rostered finish,
 * elapsed wraps by adding 24h (1440 min). Anything ≥ 24h is capped.
 *
 * Pure / deterministic. Safe to call from UI or persistence layers.
 *
 * @param {object} params
 * @param {'Day'|'Night'} params.shift
 * @param {string}        params.bookedOffTime  — 'HH:MM' 24-hour
 * @returns {{
 *   hours: number,
 *   rulePath: 'no-retain'|'pre-trigger'|'mandatory-minimum'|'post-flat-end'|'capped',
 *   explanation: string,
 *   boundaries: { rosteredFinish: string, minTrigger: string, maxFlatEnd: string }|null,
 *   elapsedMinutes: number|null,
 * }}
 */
export function calcRetainHours({ shift, bookedOffTime }) {
  const boundaries = RETAIN_HOUR_BOUNDARIES[shift] || null
  if (!boundaries) {
    return {
      hours: 0, rulePath: 'no-retain',
      explanation: 'Select a shift type to calculate retain hours.',
      boundaries: null, elapsedMinutes: null,
    }
  }

  const rosteredFinish = parseHHMM(boundaries.rosteredFinish)
  const minTrigger     = parseHHMM(boundaries.minTrigger)
  const maxFlatEnd     = parseHHMM(boundaries.maxFlatEnd)
  const bookedOff      = parseHHMM(bookedOffTime)
  if (bookedOff == null) {
    return {
      hours: 0, rulePath: 'no-retain',
      explanation: 'Enter booked off time to calculate retain hours.',
      boundaries, elapsedMinutes: null,
    }
  }

  let elapsed = bookedOff - rosteredFinish
  if (elapsed < 0) elapsed += 24 * 60   // crossed midnight

  const triggerMin = minTrigger - rosteredFinish     // 60 min
  const flatEndMin = maxFlatEnd  - rosteredFinish    // 240 min (= 4h)

  let hours
  let rulePath
  let explanation

  if (elapsed <= 0) {
    hours = 0
    rulePath = 'no-retain'
    explanation = `Booked off at or before rostered finish (${boundaries.rosteredFinish}) — no retain.`
  } else if (elapsed < triggerMin) {
    hours = Math.ceil(elapsed / 15) * RETAIN_INCREMENT
    rulePath = 'pre-trigger'
    explanation = `${elapsed} min past rostered finish (${boundaries.rosteredFinish}), rounded up to ${hours.toFixed(2)}h in 0.25h increments.`
  } else if (elapsed <= flatEndMin) {
    hours = RETAIN_MIN_HOURS
    rulePath = 'mandatory-minimum'
    explanation = `Booked off between ${boundaries.minTrigger} and ${boundaries.maxFlatEnd} — mandatory minimum 4.00h.`
  } else {
    const beyond = elapsed - flatEndMin
    hours = RETAIN_MIN_HOURS + Math.ceil(beyond / 15) * RETAIN_INCREMENT
    rulePath = 'post-flat-end'
    explanation = `${beyond} min past ${boundaries.maxFlatEnd}, rounded up to ${(hours - RETAIN_MIN_HOURS).toFixed(2)}h beyond the 4.00h minimum (total ${hours.toFixed(2)}h).`
  }

  if (hours > RETAIN_MAX_HOURS) {
    hours = RETAIN_MAX_HOURS
    rulePath = 'capped'
    explanation = `Calculated retain exceeded ${RETAIN_MAX_HOURS}h hard cap — capped at ${RETAIN_MAX_HOURS.toFixed(2)}h.`
  }

  // Snap to 0.25h grid to defend against floating-point drift (e.g. 6.4999…).
  hours = Math.round(hours / RETAIN_INCREMENT) * RETAIN_INCREMENT

  return { hours, rulePath, explanation, boundaries, elapsedMinutes: elapsed }
}

/**
 * Determine retain meal eligibility from shift type + booked-off time.
 * Pure / deterministic — safe to call from UI or persistence layers.
 *
 * @param {object} params
 * @param {'Day'|'Night'} params.shift
 * @param {string}        params.bookedOffTime  — 'HH:MM' 24-hour, or empty
 * @returns {{
 *   smallCount: number,
 *   largeCount: number,
 *   tier: 'none'|'large'|'large+small',
 *   label: string,
 *   thresholds: { large: string, smallAdditional: string }|null,
 * }}
 */
export function calcRetainMealEligibility({ shift, bookedOffTime }) {
  const thresholds = RETAIN_MEAL_THRESHOLDS[shift] || null
  if (!thresholds) {
    return { smallCount: 0, largeCount: 0, tier: 'none', label: 'No meal allowance', thresholds: null }
  }
  const t = parseHHMM(bookedOffTime)
  const largeAt = parseHHMM(thresholds.large)
  const smallAt = parseHHMM(thresholds.smallAt)
  if (t == null) {
    return { smallCount: 0, largeCount: 0, tier: 'none', label: 'Enter booked off time to check meal eligibility', thresholds }
  }

  // Wrap booked-off into elapsed-minutes past the Large threshold so we can
  // count additional small-meal thresholds without piecewise per-hour logic.
  // Large is the first threshold; subsequent Smalls trigger every +1h past
  // smallAt (which itself sits 1h past largeAt). Inclusive comparisons.
  let pastLarge = t - largeAt
  if (pastLarge < 0) pastLarge += 24 * 60

  // Sanity wrap-guard: a booked-off time more than 14h past the Large
  // threshold is almost certainly a typo for the previous day. Treat as
  // not-yet-qualifying so we don't generate dozens of small meals.
  if (pastLarge > 14 * 60) {
    return { smallCount: 0, largeCount: 0, tier: 'none', label: 'No meal allowance (booked off before threshold)', thresholds }
  }
  if (pastLarge < 0) {
    return { smallCount: 0, largeCount: 0, tier: 'none', label: 'No meal allowance (booked off before threshold)', thresholds }
  }

  // Small step: first small at smallAt (= largeAt + 1h); +1 every +2h thereafter.
  const offsetToFirstSmall = smallAt - largeAt
  const smallCount = pastLarge >= offsetToFirstSmall
    ? 1 + Math.floor((pastLarge - offsetToFirstSmall) / RETAIN_SMALL_STEP_MIN)
    : 0

  if (smallCount > 0) {
    return {
      smallCount, largeCount: 1, tier: 'large+small',
      label: `Eligible for 1 Large + ${smallCount} Small Meal Allowance${smallCount > 1 ? 's' : ''}`,
      thresholds,
    }
  }
  return {
    smallCount: 0, largeCount: 1, tier: 'large',
    label: 'Eligible for 1 Large Meal Allowance',
    thresholds,
  }
}

/**
 * Calculate the allowance components of a Retain claim.
 *
 * Retain is hours-first: generated_hours is derived from shift + bookedOffTime
 * via calcRetainHours(). The retain dollar entitlement ("Maint Stn N/N" on FRV
 * payslips) is derived from those hours using the CANONICAL overtime hourly
 * rate (RETAIN_OVERTIME_HOURLY_RATE) — a fixed award rate, NOT a user-editable
 * value. Meal allowance is auto-derived via calcRetainMealEligibility().
 * overnightCash is the only user-entered dollar field (a per-claim cash
 * imprest, not a rate).
 *
 * @param {object} params
 * @param {'Day'|'Night'} params.shift
 * @param {string}        params.bookedOffTime
 * @param {number}        [params.overnightCash]
 * @param {object}        [rates]
 * @returns {{
 *   generatedHours: number,
 *   retainRulePath: string,
 *   retainExplanation: string,
 *   retainHourlyRate: number,
 *   retainAmount: number,
 *   overnightCash: number,
 *   mealAmount: number,
 *   smallCount: number,
 *   largeCount: number,
 *   mealTier: 'none'|'large'|'large+small',
 *   mealLabel: string,
 *   totalAmount: number,
 * }}
 */
export function calcRetainClaim({ shift, bookedOffTime, overnightCash }, rates = {}) {
  const hoursResult     = calcRetainHours({ shift, bookedOffTime })
  const generatedHours  = hoursResult.hours
  // Canonical award rate — never sourced from per-user rates.
  const hourlyRate      = RETAIN_OVERTIME_HOURLY_RATE
  const retain          = roundMoney(generatedHours * hourlyRate)
  const overnight       = roundMoney(safeNum(overnightCash))

  const eligibility = calcRetainMealEligibility({ shift, bookedOffTime })
  const smallRate = safeNum(rates.smallMealAllowance)
  const largeRate = safeNum(rates.largeMealAllowance)
  const mealAmount = roundMoney(
    (eligibility.smallCount * smallRate) + (eligibility.largeCount * largeRate)
  )

  const total = roundMoney(retain + overnight + mealAmount)
  return {
    generatedHours,
    retainRulePath:    hoursResult.rulePath,
    retainExplanation: hoursResult.explanation,
    retainHourlyRate:  hourlyRate,
    retainAmount:      retain,
    overnightCash:     overnight,
    mealAmount,
    smallCount: eligibility.smallCount,
    largeCount: eligibility.largeCount,
    mealTier:   eligibility.tier,
    mealLabel:  eligibility.label,
    totalAmount: total,
  }
}

/**
 * Build Show Calculation lines for a Retain claim.
 *
 * Hours-first: explains the rule path used (pre-trigger, mandatory minimum,
 * post-flat-end, capped) and then derives the Maint Stn N/N dollar amount from
 * the canonical overtime hourly rate. Existing meal-eligibility + overnight-cash
 * framing intact.
 */
export function buildRetainCalcLines({ shift, bookedOffTime, overnightCash }, rates) {
  const result = calcRetainClaim({ shift, bookedOffTime, overnightCash }, rates)
  const lines = ['── Retain Hours ──']
  lines.push(`Shift: ${shift || '—'}`)
  lines.push(`Booked off: ${bookedOffTime || '—'}`)
  const b = RETAIN_HOUR_BOUNDARIES[shift]
  if (b) {
    lines.push(`Rostered finish: ${b.rosteredFinish}; min trigger: ${b.minTrigger}; flat-end: ${b.maxFlatEnd}`)
  }
  lines.push(`Rule: ${result.retainExplanation}`)
  lines.push(`Generated hours: ${result.generatedHours.toFixed(2)}h`)

  if (result.generatedHours > 0) {
    lines.push('── Maint Stn N/N $ (derived) ──')
    lines.push(`${result.generatedHours.toFixed(2)}h × $${result.retainHourlyRate.toFixed(4)}/h = $${result.retainAmount.toFixed(2)}`)
  }

  if (result.overnightCash > 0) {
    lines.push('── Overnight Cash ──')
    lines.push(`Overnight cash: $${result.overnightCash.toFixed(2)}`)
  }

  if (shift) {
    lines.push('── Meal Eligibility ──')
    const t = RETAIN_MEAL_THRESHOLDS[shift]
    if (t) lines.push(`Thresholds: Large ≥ ${t.large}; +Small from ${t.smallAt}, then +1 every 2h`)
    lines.push(result.mealLabel)
    if (result.largeCount > 0) {
      lines.push(`Large meal × ${result.largeCount} = $${(result.largeCount * safeNum(rates.largeMealAllowance)).toFixed(2)}`)
    }
    if (result.smallCount > 0) {
      lines.push(`Small meal × ${result.smallCount} = $${(result.smallCount * safeNum(rates.smallMealAllowance)).toFixed(2)}`)
    }
  }

  lines.push(`── Total: $${result.totalAmount.toFixed(2)} ──`)
  return lines
}

// ─── Standby ──────────────────────────────────────────────────────────────────

/**
 * Muster & Dismiss petty-cash payable kilometres.
 *
 * CONFIRMED RULE: payable one-way km = max(0, A − B) where
 *   A = Home → Rostered Station (one-way km)
 *   B = Home → M&D Station      (one-way km)
 *
 * This is the ONLY correct M&D petty-cash distance. It deliberately does NOT
 * double the value (petty cash = payableKm × kilometreRate, no return leg) and
 * it is unrelated to the rostered↔M&D station distance the field previously
 * used, and to the canonical FRV-matrix *hours* excess-travel entitlement
 * (see lib/fat/engine/generators/musterDismiss.js — that is a payroll
 * comparison, never the petty-cash km).
 *
 * Safety / floors:
 *   - Negative differences (M&D station further from home than the rostered
 *     station) floor to 0 km.
 *   - If EITHER distance is missing / non-finite / negative the result is 0
 *     (not computable → nothing payable). In particular a missing B never
 *     defaults to 0, which would overpay A − 0 = A; it yields 0 payable and the
 *     UI falls back to manual entry.
 *   - Result is rounded to 0.1 km to match the dist_km column precision.
 *
 * @param {object} params
 * @param {number} params.homeToRosteredKm  A — Home → Rostered Station, one-way km
 * @param {number} params.homeToMdKm        B — Home → M&D Station, one-way km
 * @returns {number} payable one-way km, floored at 0
 */
export function calcMdPayableKm({ homeToRosteredKm, homeToMdKm }) {
  // Reject null/undefined/'' explicitly — Number(null) === 0 would otherwise
  // let a missing B pay out A − 0 = A (an overpay). Missing ⇒ not computable ⇒ 0.
  const toNum = (v) => (v === null || v === undefined || v === '') ? NaN : Number(v)
  const a = toNum(homeToRosteredKm)
  const b = toNum(homeToMdKm)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  if (a < 0 || b < 0) return 0
  const diff = a - b
  if (diff <= 0) return 0
  return Math.round(diff * 10) / 10
}

/**
 * Calculate the allowance components of a Standby or M&D claim.
 *
 * Night meal eligibility: arrival STRICTLY AFTER 19:00.
 * M&D: no meal allowance ever.
 *
 * @param {object} params
 * @param {number}  params.distKm       — Standby: return km. M&D: payable km
 *                                        (max(0, Home→Rostered − Home→M&D), no ×2).
 * @param {boolean} params.hasNightMeal — use isStandbyNightMealEligible() to compute
 * @param {object} rates
 * @returns {{ travelAmount: number, nightMealie: number, totalAmount: number }}
 */
export function calcStandbyClaim({ distKm, hasNightMeal }, rates) {
  const travelAmount = calcTravelAmount({ km: distKm }, rates)
  const nightMealie  = hasNightMeal ? roundMoney(safeNum(rates.smallMealAllowance)) : 0
  const totalAmount  = roundMoney(travelAmount + nightMealie)
  return { travelAmount, nightMealie, totalAmount }
}

/**
 * Build Show Calculation lines for a Standby / Muster & Dismiss claim.
 *
 * The claim-creation breakdown is operational: it shows only the amounts the
 * member is claiming (Excess Travel and, for Standby, an eligible Small Meal
 * Allowance). Payroll/reconciliation framing (payslip vs petty cash) is
 * deliberately omitted from the creation UI.
 *
 * Standby&Dismi is NOT shown here — it is generated as internal OCR/payslip
 * reconciliation metadata only (see buildStandbyRow: autoChild
 * 'standby_and_dismi'), carries no dollar amount, and never contributes to
 * totals. Pay Number is captured at mark-as-paid time, not here.
 */
export function buildStandbyCalcLines({ distKm, standbyType, arrivedTime, shift, homeToRosteredKm, homeToMdKm }, rates) {
  // ── Muster & Dismiss: petty-cash km = max(0, Home→Rostered − Home→M&D) ──────
  // The charged/persisted/exported payable km is `distKm` (already the floored
  // difference, set by MdDistanceField). A/B are shown as provenance when the
  // auto-lookup supplied them; the dollar line always derives from `distKm` so
  // display == persisted == exported.
  if (standbyType === 'M&D') {
    const payableKm = safeNum(distKm)
    const { travelAmount, totalAmount } = calcStandbyClaim({ distKm: payableKm, hasNightMeal: false }, rates)
    const hasAB = Number.isFinite(Number(homeToRosteredKm)) && Number.isFinite(Number(homeToMdKm))

    const lines = ['── Excess Travel (Petty Cash) — Home→Rostered minus Home→M&D ──']
    if (hasAB) {
      const a = Math.round(safeNum(homeToRosteredKm) * 10) / 10
      const b = Math.round(safeNum(homeToMdKm) * 10) / 10
      lines.push(`Home → Rostered Station (A): ${a} km`)
      lines.push(`Home → M&D Station (B): ${b} km`)
      lines.push(`Payable km = max(0, A − B) = ${payableKm} km`)
    } else {
      lines.push(`Payable km (manual entry): ${payableKm} km`)
    }
    lines.push(`${payableKm} km × $${safeNum(rates.kilometreRate).toFixed(2)}/km = $${travelAmount.toFixed(2)}`)
    lines.push('── Meal Allowance: None (Muster & Dismiss claims have no meal allowance) ──')
    lines.push(`── Total: $${totalAmount.toFixed(2)} ──`)
    return lines
  }

  const hasNightMeal = isStandbyNightMealEligible({ standbyType, shift, arrivedTime })
  const { travelAmount, nightMealie, totalAmount } = calcStandbyClaim({ distKm: safeNum(distKm), hasNightMeal }, rates)

  const lines = ['── Excess Travel ──']
  lines.push(`${safeNum(distKm)} km × $${safeNum(rates.kilometreRate).toFixed(2)}/km = $${travelAmount.toFixed(2)}`)

  if (hasNightMeal) {
    lines.push('── Small Meal Allowance (arrived at or after 19:00) ──')
    lines.push(`$${safeNum(rates.smallMealAllowance).toFixed(2)}`)
  } else {
    lines.push('── Meal Allowance: None eligible for this shift ──')
  }

  lines.push(`── Total: $${totalAmount.toFixed(2)} ──`)
  return lines
}

// ─── Spoilt / Delayed Meals ───────────────────────────────────────────────────

/**
 * Calculate the total for a spoilt/delayed meal claim.
 *
 * @param {object} params
 * @param {'Spoilt'|'Delayed'} params.mealType
 * @param {object} rates
 * @returns {{ mealAmount: number, totalAmount: number }}
 */
export function calcSpoiltClaim({ mealType }, rates) {
  const canonical  = normaliseMealType(mealType)
  const mealAmount = calcSpoiltMealAmount({ mealType: canonical }, rates)
  return { mealAmount, totalAmount: mealAmount }
}

/**
 * Build Show Calculation lines for a Spoilt/Delayed meal claim.
 */
export function buildSpoiltCalcLines({ mealType, shift, incidentTime, mealInterrupted, returnToStn }, rates) {
  const canonical = normaliseMealType(mealType)
  const amount = calcSpoiltMealAmount({ mealType: canonical }, rates)
  const window = getMealWindow(shift || 'Day')

  const lines = [`── ${mealType} Meal Allowance ──`]
  lines.push(`Rate: $${safeNum(rates.smallMealAllowance).toFixed(2)} (small meal — confirmed FRV rate)`)
  lines.push(`Shift meal window: ${window.label}`)

  if (incidentTime) {
    const status    = checkTimeInMealWindow(incidentTime, shift)
    const indicator = status === 'inside' ? '✓ within window'
                    : status === 'before' ? '← before window'
                    : '→ after window'
    lines.push(`Incident time: ${incidentTime} — ${indicator}`)
  }
  if (mealInterrupted) lines.push(`Meal interrupted at: ${mealInterrupted}`)
  if (returnToStn)     lines.push(`Return to station: ${returnToStn}`)

  lines.push(`── Total: $${amount.toFixed(2)} ──`)
  return lines
}

// ─── Adjusted Amount ─────────────────────────────────────────────────────────

/**
 * Resolve the effective display/payment amount for a claim.
 * If the user has set an adjusted_amount, that overrides the calculated total.
 */
export function resolveEffectiveAmount(claim) {
  if (!claim) return 0
  if (claim.adjusted_amount != null) {
    return roundMoney(Number(claim.adjusted_amount))
  }
  return resolveStoredAmount(claim)
}

/**
 * Return true if a claim has a user override on its amount.
 */
export function isAmountAdjusted(claim) {
  return !!claim && claim.adjusted_amount != null
}

// ─── Dashboard Summaries ──────────────────────────────────────────────────────

/**
 * Compute summary totals from an array of claim rows.
 * Uses the effective amount (adjusted_amount if set, else total_amount).
 *
 * @param {Array} claims
 * @returns {{ grandTotal: number, pendingTotal: number, paidTotal: number, byType: Record<string, number> }}
 */
export function calcDashboardSummary(claims) {
  let grandTotal   = 0
  let pendingTotal = 0
  let paidTotal    = 0
  const byType     = {}

  for (const claim of claims) {
    const amt = resolveEffectiveAmount(claim)
    grandTotal += amt

    const status = (claim.status || '').toLowerCase()
    if (status === 'pending') pendingTotal += amt
    if (status === 'paid')    paidTotal    += amt

    const t = claim.claimType || 'unknown'
    byType[t] = (byType[t] || 0) + amt
  }

  return { grandTotal, pendingTotal, paidTotal, byType }
}

// ─── Tax Summary ──────────────────────────────────────────────────────────────

/**
 * Compute ATO tax-summary components from an array of claims for a financial year.
 * Double meal = 1 small + 1 large for ATO purposes.
 *
 * @param {Array}  claims  - all claims for the FY (mixed types)
 * @param {Object} rates   - current rates object from RatesContext
 * @returns {{
 *   smallMeals: number, smallMealsTotal: number,
 *   largeMeals: number, largeMealsTotal: number,
 *   totalMeals: number,
 *   travelKm: number, travelRate: number, travelTotal: number,
 *   grandTotal: number
 * }}
 */
export function calcTaxSummary(claims, rates) {
  let smallMeals      = 0
  let smallMealsTotal = 0
  let largeMeals      = 0
  let largeMealsTotal = 0
  let travelKm        = 0

  const smallRate  = rates?.smallMealAllowance  || 10.90
  const largeRate  = rates?.largeMealAllowance  || 20.55
  const travelRate = rates?.kilometreRate || rates?.kmRate || 0.99

  for (const claim of claims) {
    const type = (claim.claimType || '').toLowerCase()

    // claimType is stored as 'recalls', 'retain', 'standby', 'spoilt' (table names)
    if (type === 'recalls' && !claim.calculation_inputs?.autoChild) {
      // PARENT recall row only. The auto-children (callback_ops / excess_travel
      // in recalls; petty_cash_meal in spoilt_meals) duplicate the parent's
      // travel km and meal, so they are skipped here — the parent is the single
      // source of truth, mirroring the groupedView container dedupe used for
      // dollar totals. The petty_cash_meal child is excluded in the spoilt
      // branch below.
      // Use pre-computed totalKm from calculation_inputs if available (stores full return route).
      // Fallback: compute full return route as (dist_home_km × 2) + (dist_stn_km × 2).
      // Do NOT use claim.total_km — that column is dist_home_km + dist_stn_km (one-way only).
      const km = Number(
        claim.calculation_inputs?.totalKm ||
        ((Number(claim.dist_home_km || 0) * 2) + (Number(claim.dist_stn_km || 0) * 2))
      )
      travelKm += km
      // Recall mealie (large or double) — counted here for tax summary
      if (claim.mealie_amount > 0) {
        const entitlement = claim.calculation_inputs?.mealEntitlement || 'none'
        if (entitlement === 'double') {
          smallMeals++; smallMealsTotal += smallRate
          largeMeals++; largeMealsTotal += largeRate
        } else if (entitlement === 'large') {
          largeMeals++; largeMealsTotal += largeRate
        }
      }
    }

    if (type === 'standby' || type === 'md') {
      // 'md' (Muster & Dismiss) shares the standby DB table; its excess-travel
      // child rows must be counted here too. M&D never carries a night meal.
      const km = Number(claim.dist_km || 0)
      travelKm += km
      // Night meal if eligible (night_mealie > 0)
      if (Number(claim.night_mealie || 0) > 0) {
        smallMeals++
        smallMealsTotal += smallRate
      }
    }

    if (type === 'spoilt' || type === 'delayed_meal') {
      // Spoilt Meal and Delayed Meal = 1 small meal each for ATO tax purposes.
      // 'delayed_meal' is a virtual claimType mapping to the spoilt DB table.
      // Skip meal children whose entitlement is already counted on a parent
      // operational row, to avoid double-counting:
      //   retain_meal     → counted on the retain parent (smallMealCount/largeMealCount)
      //   petty_cash_meal → counted on the recall parent (mealie_amount + mealEntitlement)
      // Standby small-meal children (standby_small_meal) ARE counted here — the
      // standby parent carries no meal (night_mealie = 0), so this is their only
      // count. Genuine standalone Spoilt/Delayed claims also count here.
      const ai = claim.calculation_inputs || {}
      if (ai.autoChild !== 'retain_meal' && ai.autoChild !== 'petty_cash_meal') {
        smallMeals++
        smallMealsTotal += smallRate
      }
    }

    if (type === 'retain') {
      // Parent retain row carries the auto-derived meal allowance counts in
      // calculation_inputs. Child autoChild='retain_meal' rows in spoilt_meals
      // are excluded above so this is the single source of truth.
      const ai = claim.calculation_inputs || {}
      const sc = Number(ai.smallMealCount || 0)
      const lc = Number(ai.largeMealCount || 0)
      if (sc > 0) { smallMeals += sc; smallMealsTotal += sc * smallRate }
      if (lc > 0) { largeMeals += lc; largeMealsTotal += lc * largeRate }
    }
  }

  const totalMeals = smallMeals + largeMeals
  const travelTotal = roundMoney(travelKm * travelRate)
  const grandTotal  = roundMoney(smallMealsTotal + largeMealsTotal + travelTotal)

  return {
    smallMealCount: smallMeals,
    smallMealTotal: roundMoney(smallMealsTotal),
    largeMealCount: largeMeals,
    largeMealTotal: roundMoney(largeMealsTotal),
    totalMeals,
    travelKm, travelRate, travelTotal,
    grandTotal,
  }
}

// ─── Stored Amount Resolver ───────────────────────────────────────────────────

/**
 * Resolve the persisted total_amount from a claim row.
 * Falls back to 0 if not set (new unsaved claim).
 */
export function resolveStoredAmount(claim) {
  // Spoilt/delayed_meal rows store their amount in meal_amount.
  // total_amount is also written on new rows, but legacy rows may only have meal_amount.
  if (claim.claimType === 'spoilt' || claim.claimType === 'delayed_meal') {
    if (claim.meal_amount != null) return roundMoney(Number(claim.meal_amount))
  }
  return roundMoney(Number(claim.total_amount || 0))
}

// ─── Rate Snapshot ────────────────────────────────────────────────────────────

/**
 * Create a frozen snapshot of the current rates to store with a claim.
 * Ensures the calculation can always be reproduced even after rate changes.
 *
 * @param {Object} rates - from RatesContext
 * @returns {Object}
 */
export function createRateSnapshot(rates) {
  const smallMeal = safeNum(rates?.smallMealAllowance ?? 10.90)
  const largeMeal = safeNum(rates?.largeMealAllowance ?? 20.55)
  return {
    snapshotAt: new Date().toISOString(),
    kmRate:               rates?.kmRate               ?? 0.99,
    kilometreRate:        rates?.kilometreRate        ?? rates?.kmRate ?? 0.99,
    smallMealAllowance:   smallMeal,
    largeMealAllowance:   largeMeal,
    doubleMealAllowance:  roundMoney(smallMeal + largeMeal), // derived
    // Canonical retain (Maint Stn N/N) overtime rate — fixed award value, not
    // user-editable. Captured so historical retain $ amounts reproduce exactly.
    retainHourlyRate:     RETAIN_OVERTIME_HOURLY_RATE,
    recallAllowance:      rates?.recallAllowance       ?? 0,
    retainAllowance:      rates?.retainAllowance       ?? 0,
    standbyAllowance:     rates?.standbyAllowance      ?? 0,
  }
}

// --- Calc Snapshot Builder ---

/**
 * Build a JSONB-ready calc snapshot to store with a claim.
 * Captures inputs, rate snapshot, and human-readable breakdown lines.
 *
 * @param {string}   claimType  - 'recall' | 'retain' | 'standby' | 'spoilt'
 * @param {Object}   inputs     - the raw form inputs
 * @param {Object}   rates      - current rates
 * @param {string[]} lines      - output of buildXxxCalcLines()
 * @returns {Object} JSONB-ready snapshot object
 */
export function buildCalcSnapshot(claimType, inputs, rates, lines = []) {
  return {
    claimType,
    snapshotAt:   new Date().toISOString(),
    inputs:       inputs ?? {},
    rateSnapshot: createRateSnapshot(rates),
    calcLines:    lines,
  }
}
