// ─── Feature flags ────────────────────────────────────────────────────────────
// Centralised, SSR-safe feature gates. Each resolver is a PURE function of
// NEXT_PUBLIC_* env vars (and NODE_ENV) only — no `window`, no React — so it
// evaluates identically on the server and the client (no hydration mismatch) and
// can be imported from any client component, page, or server route.
//
// ── Payments / Reconciliation feature ────────────────────────────────────────
// The recovered Payments + payslip-reconciliation surface (the `/payments` and
// `/payments/imports` routes and the Payments nav tab) depends on canonical /
// reconciliation / payslip backend that is applied in DEV but NOT yet in PROD.
// Until the PROD schema rollout (fat-parity phases 3–6) completes, it must stay
// hidden from production users.
//
// Resolution order for isPaymentsEnabled():
//   1. Explicit override — NEXT_PUBLIC_PAYMENTS_ENABLED = true|1|on  / false|0|off
//   2. Local dev server   — NODE_ENV !== 'production'                → ON (localhost)
//   3. DEV deployment     — NEXT_PUBLIC_SUPABASE_URL targets DEV ref → ON
//   4. Anything else (PROD / unknown target)                        → OFF
//      (fail-safe: the feature is never exposed unless positively enabled)
// ─────────────────────────────────────────────────────────────────────────────

// DEV (Testing) Supabase project ref — the same identifier the DEV-only test
// scripts guard on. PROD (Live) is `wgcqzamuspuqpedqasbc`.
const DEV_SUPABASE_REF = 'kctctvpobbizhkiqkgqw'

/**
 * Parse a tri-state boolean env flag. Returns true/false for recognised values,
 * or undefined when unset/blank/unrecognised so the caller falls through to its
 * environment defaults.
 * @param {string|undefined} raw
 * @returns {boolean|undefined}
 */
function parseBoolFlag(raw) {
  if (raw == null) return undefined
  const v = String(raw).trim().toLowerCase()
  if (v === '') return undefined
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(v)) return true
  if (['0', 'false', 'off', 'no', 'disabled'].includes(v)) return false
  return undefined
}

/**
 * Is the Payments / Reconciliation feature enabled in this environment?
 * SSR-safe and deterministic (env-only). See the resolution order above.
 * @returns {boolean}
 */
export function isPaymentsEnabled() {
  // 1. Explicit override always wins (set NEXT_PUBLIC_PAYMENTS_ENABLED in any env).
  const explicit = parseBoolFlag(process.env.NEXT_PUBLIC_PAYMENTS_ENABLED)
  if (explicit !== undefined) return explicit

  // 2. Local dev server (`npm run dev`) → enabled.
  if (process.env.NODE_ENV !== 'production') return true

  // 3. Built/deployed: enable only when pointed at the DEV Supabase project.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (url.includes(DEV_SUPABASE_REF)) return true

  // 4. PROD (or any unrecognised target) → disabled, fail-safe.
  return false
}
