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
// ─────────────────────────────────────────────────────────────────────────────

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
 * Double meal counts as 1 small + 1 large for tax reporting.
 * See calcMealTaxComponents() for ATO decomposition.
 *
 * @param {object} params
 * @param {'none'|'small'|'large'|'double'} params.mealEntitlement
 * @param {object} rates
 * @returns {number}
 */
export function calcMealAllowance({ mealEntitlement }, rates) {
  switch (mealEntitlement) {
    case 'small':  return roundMoney(safeNum(rates.smallMealAllowance))
    case 'large':  return roundMoney(safeNum(rates.largeMealAllowance))
    case 'double': return roundMoney(safeNum(rates.doubleMealAllowance))
    default:       return 0
  }
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

// ─── Overnight ────────────────────────────────────────────────────────────────

/**
 * Calculate overnight allowance.
 *
 * @param {object} params
 * @param {boolean} params.hasOvernight
 * @param {object} rates
 * @returns {number}
 */
export function calcOvernightAllowance({ hasOvernight }, rates) {
  if (!hasOvernight) return 0
  return roundMoney(safeNum(rates.overnightAllowance))
}

// ─── Recall ───────────────────────────────────────────────────────────────────

/**
 * Calculate the allowance components of a Recall claim.
 *
 * Route: Home → Rostered Stn → Recall Stn → Rostered Stn → Home
 * Total km = (distHomeKm × 2) + (distStnKm × 2)
 *
 * NOTE: Base recall pay is a payroll function — NOT calculated here.
 * total_amount = travel_amount + mealie_amount (allowances only).
 *
 * @param {object} params
 * @param {number} params.distHomeKm        — one-way km, home → rostered station
 * @param {number} params.distStnKm         — one-way km, rostered → recall station
 * @param {'none'|'small'|'large'|'double'} params.mealEntitlement
 * @param {object} rates
 * @returns {{
 *   travelAmount: number,
 *   mealieAmount: number,
 *   totalAmount: number,
 *   totalKm: number,
 *   distHomeKm: number,
 *   distStnKm: number,
 * }}
 */
export function calcRecallClaim({ distHomeKm, distStnKm, mealEntitlement }, rates) {
  const home         = safeNum(distHomeKm)
  const stn          = safeNum(distStnKm)
  const totalKm      = calcRecallTotalKm({ distHomeKm: home, distStnKm: stn })
  const travelAmount = calcTravelAmount({ km: totalKm }, rates)
  const mealieAmount = calcMealAllowance({ mealEntitlement }, rates)
  const totalAmount  = roundMoney(travelAmount + mealieAmount)

  return { travelAmount, mealieAmount, totalAmount, totalKm, distHomeKm: home, distStnKm: stn }
}

/**
 * Build a human-readable Show Calculation breakdown for a Recall claim.
 *
 * @param {object} params  — same as calcRecallClaim params
 * @param {object} rates
 * @param {object} labels  — optional { rosterStation, recallStation }
 * @returns {string[]}     — array of display lines
 */
export function buildRecallCalcLines({ distHomeKm, distStnKm, mealEntitlement }, rates, labels = {}) {
  const home    = safeNum(distHomeKm)
  const stn     = safeNum(distStnKm)
  const totalKm = calcRecallTotalKm({ distHomeKm: home, distStnKm: stn })
  const travel  = calcTravelAmount({ km: totalKm }, rates)
  const meal    = calcMealAllowance({ mealEntitlement }, rates)
  const total   = roundMoney(travel + meal)

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

  if (meal > 0) {
    const mealLabel = { small: 'Small Meal', large: 'Large Meal', double: 'Double Meal' }[mealEntitlement] || 'Meal'
    const mealRate  = mealEntitlement === 'small'  ? rates.smallMealAllowance
                    : mealEntitlement === 'large'  ? rates.largeMealAllowance
                    : rates.doubleMealAllowance
    lines.push('── Meal ──')
    lines.push(`${mealLabel} = $${safeNum(mealRate).toFixed(2)}`)
    if (mealEntitlement === 'double') {
      lines.push('  (counts as 1 small + 1 large for tax)')
    }
  }

  lines.push(`── Total: $${total.toFixed(2)} ──`)
  return lines
}

// ─── Retain ───────────────────────────────────────────────────────────────────

/**
 * Retain meal-allowance thresholds, indexed by shift type.
 *
 * Rule (booked-off time interpreted strictly):
 *   bookedOffTime > large            → 1 Large Meal
 *   bookedOffTime > smallAdditional  → 1 Large + 1 Small
 *   otherwise                        → no meal allowance
 *
 * "Strictly after" mirrors the existing Standby night-meal cutoff (19:00),
 * so the rules behave consistently across the app. Centralised here so that
 * FRV award updates only need to touch these constants — never the UI.
 */
export const RETAIN_MEAL_THRESHOLDS = {
  Day:   { large: '19:00', smallAdditional: '22:00' },
  Night: { large: '09:00', smallAdditional: '13:00' },
}

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
  const smallAt = parseHHMM(thresholds.smallAdditional)
  if (t == null) {
    return { smallCount: 0, largeCount: 0, tier: 'none', label: 'Enter booked off time to check meal eligibility', thresholds }
  }
  if (t > smallAt) {
    return { smallCount: 1, largeCount: 1, tier: 'large+small', label: 'Eligible for 1 Large + 1 Small Meal Allowance', thresholds }
  }
  if (t > largeAt) {
    return { smallCount: 0, largeCount: 1, tier: 'large', label: 'Eligible for 1 Large Meal Allowance', thresholds }
  }
  return { smallCount: 0, largeCount: 0, tier: 'none', label: 'No meal allowance (booked off before threshold)', thresholds }
}

/**
 * Calculate the allowance components of a Retain claim.
 *
 * Meal allowance is auto-derived from shift + bookedOffTime via
 * calcRetainMealEligibility(). retainAmount and overnightCash remain
 * user-entered (the underlying award formula is still unresolved).
 *
 * @param {object} params
 * @param {number}        params.retainAmount
 * @param {number}        params.overnightCash
 * @param {'Day'|'Night'} [params.shift]
 * @param {string}        [params.bookedOffTime]
 * @param {object}        [rates]
 * @returns {{
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
export function calcRetainClaim({ retainAmount, overnightCash, shift, bookedOffTime }, rates = {}) {
  const retain    = roundMoney(safeNum(retainAmount))
  const overnight = roundMoney(safeNum(overnightCash))

  const eligibility = calcRetainMealEligibility({ shift, bookedOffTime })
  const smallRate = safeNum(rates.smallMealAllowance)
  const largeRate = safeNum(rates.largeMealAllowance)
  const mealAmount = roundMoney(
    (eligibility.smallCount * smallRate) + (eligibility.largeCount * largeRate)
  )

  const total = roundMoney(retain + overnight + mealAmount)
  return {
    retainAmount: retain,
    overnightCash: overnight,
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
 */
export function buildRetainCalcLines({ retainAmount, overnightCash, shift, bookedOffTime }, rates) {
  const result = calcRetainClaim({ retainAmount, overnightCash, shift, bookedOffTime }, rates)
  const lines = ['── Retain ──']
  if (result.retainAmount > 0)   lines.push(`Retain allowance: $${result.retainAmount.toFixed(2)}`)
  if (result.overnightCash > 0)  lines.push(`Overnight cash: $${result.overnightCash.toFixed(2)}`)

  if (shift) {
    lines.push('── Meal Eligibility ──')
    lines.push(`Shift: ${shift}`)
    lines.push(`Booked off: ${bookedOffTime || '—'}`)
    const t = RETAIN_MEAL_THRESHOLDS[shift]
    if (t) lines.push(`Thresholds: Large > ${t.large}, +Small > ${t.smallAdditional}`)
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
 * Calculate the allowance components of a Standby or M&D claim.
 *
 * Night meal eligibility: arrival STRICTLY AFTER 19:00.
 * M&D: no meal allowance ever.
 *
 * @param {object} params
 * @param {number}  params.distKm       — return km
 * @param {boolean} params.hasNightMeal — use isStandbyNightMealEligible() to compute
 * @param {object} rates
 * @returns {{ travelAmount: number, nightMealie: number, totalAmount: number }}
 */
export function calcStandbyClaim({ distKm, hasNightMeal }, rates) {
  const travelAmount = calcTravelAmount({ km: distKm }, rates)
  const nightMealie  = hasNightMeal ? roundMoney(safeNum(rates.standbyNightMealAllowance)) : 0
  const totalAmount  = roundMoney(travelAmount + nightMealie)
  return { travelAmount, nightMealie, totalAmount }
}

/**
 * Build Show Calculation lines for a Standby claim.
 *
 * Standby generates three entitlements:
 *   1. Excess Travel       — payslip, km × rate, contributes to totals
 *   2. Small Meal Allowance — petty cash, rate-table value, contributes to totals
 *      (only when shift=Night AND arrived ≥ 19:00)
 *   3. Standby&Dismi       — payroll metadata only, no dollar amount, never
 *                            included in totals. Future OCR/payslip reconciliation
 *                            target. Pay Number is captured at mark-as-paid time,
 *                            not here.
 */
export function buildStandbyCalcLines({ distKm, standbyType, arrivedTime, shift }, rates) {
  const hasNightMeal = isStandbyNightMealEligible({ standbyType, shift, arrivedTime })
  const { travelAmount, nightMealie, totalAmount } = calcStandbyClaim({ distKm: safeNum(distKm), hasNightMeal }, rates)

  const lines = ['── Excess Travel (payslip) ──']
  lines.push(`${safeNum(distKm)} km × $${safeNum(rates.kilometreRate).toFixed(2)}/km = $${travelAmount.toFixed(2)}`)

  // Standby&Dismi — generated payroll entitlement metadata only.
  // No dollar amount, no total contribution; reconciled against payslip later.
  if (standbyType !== 'M&D') {
    lines.push('── Standby&Dismi (payroll entitlement) ──')
    lines.push('Tracked for payslip reconciliation (no dollar amount).')
  }

  if (standbyType === 'M&D') {
    lines.push('── Meal Allowance: None (M&D claims have no meal allowance) ──')
  } else if (hasNightMeal) {
    lines.push('── Small Meal Allowance (petty cash, arrived at or after 19:00) ──')
    lines.push(`$${safeNum(rates.standbyNightMealAllowance).toFixed(2)}`)
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
    if (type === 'recalls') {
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

    if (type === 'standby') {
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
      // Skip rows auto-created from a retain claim — those are accounted for
      // on the parent retain row below (smallMealCount + largeMealCount in
      // calculation_inputs), so the petty-cash-meal child must not double-count.
      const ai = claim.calculation_inputs || {}
      if (ai.autoChild !== 'retain_meal') {
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
  return {
    snapshotAt: new Date().toISOString(),
    kmRate:               rates?.kmRate               ?? 0.99,
    smallMealAllowance:   rates?.smallMealAllowance   ?? 10.90,
    largeMealAllowance:   rates?.largeMealAllowance   ?? 20.55,
    doubleMealAllowance:  rates?.doubleMealAllowance  ?? 31.45,
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
