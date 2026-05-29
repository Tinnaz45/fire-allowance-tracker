// ─── Default Allowance Rates ───────────────────────────────────────────────────
// Single source of truth for all financial rates used in the app.
//
// These are the fallback rates used when a user has not saved their own overrides.
// Source: FRV / FBEU Enterprise Agreement (review annually).
//
// IMPORTANT: Do NOT hardcode these values anywhere else in the app.
// All calculations must import rates from this file OR from the active user
// rates via useRates(). See lib/calculations/RatesContext.js.
//
// ── Rate change history ────────────────────────────────────────────────────────
// 2025-06  Initial values set (ATO-sourced km rate, estimated meal rates)
// 2025-06  CORRECTED: kilometreRate 0.99 → 1.20 (user-confirmed award rate)
//          CORRECTED: smallMealAllowance 16.55 → 10.90 (user-confirmed award rate)
// 2026-05  CORRECTED: largeMealAllowance 21.80 → 20.55 (confirmed from FRV historical allowance sheets)
//          SOURCE:    FRV Allowances 2023FY, FRV Allowances 2025FY, FRV Allowances - Current
// 2026-05  SIMPLIFIED: removed doubleMealAllowance (now derived = small + large),
//          spoiltMealAllowance, delayedMealAllowance, standbyNightMealAllowance
//          (all collapse onto smallMealAllowance), and overnightAllowance
//          (orphaned — overnight cash is user-entered per claim).
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_RATES = {
  // ── Travel ────────────────────────────────────────────────────────────────
  // Per-kilometre reimbursement rate paid on recall and standby claims.
  // Applied to dist_home_km and dist_stn_km fields.
  // SOURCE: User-confirmed award rate. Review annually.
  kilometreRate: 1.20, // $ per km — confirmed award rate 2025

  // ── Meals ─────────────────────────────────────────────────────────────────
  // Canonical meal allowances. Everything else is derived:
  //   double meal = small + large
  //   spoilt/delayed meal = small
  //   standby night meal = small
  // SOURCE: FRV Allowances 2023FY, 2025FY, and Current sheets.
  smallMealAllowance: 10.90, // $ — confirmed FRV award rate
  largeMealAllowance: 20.55, // $ — confirmed FRV award rate (flat — NOT 2× small)

  // ── Recall ────────────────────────────────────────────────────────────────
  // Non-monetary recall thresholds. Not used in dollar calculations directly,
  // but reserved for future auto-entitlement logic.
  recallMinimumHours: 3,    // hours — minimum engagement on recall (UNCONFIRMED)
  recallMealieThreshold: 4, // hours — meal allowance threshold (UNCONFIRMED)

  // ── Retain (Maint Stn N/N) ──────────────────────────────────────────────────
  // Retain hours are auto-generated from shift + booked-off time (see
  // calcRetainHours() in engine.js). The dollar value of the retain entitlement
  // — shown as "Maint Stn N/N" on FRV payslips — is derived:
  //     retain_amount = generated_hours × RETAIN_OVERTIME_HOURLY_RATE
  // The overtime hourly rate is a CANONICAL payroll rate (see the named export
  // RETAIN_OVERTIME_HOURLY_RATE below). It is intentionally NOT a user-editable
  // field: it does not appear in DEFAULT_RATES or RATE_FIELDS, and is never
  // sourced from user_rates. Users must not be able to alter the award rate.

  // ── Rounding ──────────────────────────────────────────────────────────────
  // All monetary values are rounded to 2 decimal places.
  // See engine.js roundMoney() for implementation.
  decimalPlaces: 2,
}

// ─── Canonical retain (Maint Stn N/N) overtime hourly rate ────────────────────
// Confirmed from historical FRV payslips and EBA cl. 128.5 (a shift worker
// retained on duty 60+ minutes past rostered finish is paid a minimum 4 hours
// at double time). The retain dollar entitlement ("Maint Stn N/N") is:
//     retain_amount = generated_hours × RETAIN_OVERTIME_HOURLY_RATE
//
// Payslip evidence (all consistent at $101.0225/h):
//   • Maint Stn N/N   4.00 h = $404.09   (4.00 × 101.0225 = 404.09)
//   • Muster&Dismis   1.00 h = $101.02   (1.00 × 101.0225 → 101.02)
//   • Standby&Dismi   0.50 h = $50.51    (0.50 × 101.0225 → 50.51)
//
// This is a fixed award rate, NOT a user-editable field — it is deliberately
// kept out of DEFAULT_RATES / RATE_FIELDS / user_rates so it cannot be changed
// per user. Update here (with payslip evidence) only when the award changes.
export const RETAIN_OVERTIME_HOURLY_RATE = 101.0225 // $/h — confirmed FRV payslip rate

// ─── Rate field metadata (used by Settings UI) ────────────────────────────────
// Drives the labels, help text, and validation in the Rates Settings page.
// Only canonical rates appear here — derived allowances (double meal, spoilt,
// delayed, standby night meal) compute automatically from smallMealAllowance
// and largeMealAllowance.

export const RATE_FIELDS = [
  {
    key: 'kilometreRate',
    label: 'Kilometre Rate',
    unit: '$/km',
    help: 'Per-kilometre reimbursement rate paid on recall and standby claims. Current confirmed award rate: $1.20/km. Review annually.',
    min: 0.01,
    max: 5.00,
    step: 0.01,
  },
  {
    key: 'smallMealAllowance',
    label: 'Small Meal Allowance',
    unit: '$',
    help: 'Paid when one meal break is disrupted (e.g. recall cutting into a meal break). Also drives spoilt, delayed and standby night meal allowances. Current confirmed award rate: $10.90.',
    min: 0.01,
    max: 200,
    step: 0.01,
  },
  {
    key: 'largeMealAllowance',
    label: 'Large Meal Allowance',
    unit: '$',
    help: 'Full meal allowance for extended shifts. Confirmed FRV award rate: $20.55. This is a flat rate — it is NOT derived as 2× small meal.',
    min: 0.01,
    max: 200,
    step: 0.01,
  },
]
