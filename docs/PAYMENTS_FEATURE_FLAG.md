# Payments / Reconciliation Feature Flag

The recovered **Payments + payslip-reconciliation** feature set (the `/payments`
and `/payments/imports` routes, the Payments nav tab, and their services) depends
on canonical / reconciliation / payslip backend that is live in **DEV** but **not
yet in PROD**. Until the PROD schema rollout (`fat-parity` phases 3–6) completes,
the feature must stay hidden from production users. This flag makes that safe — the
code can live on `main` without exposing an unbacked feature.

## What the flag gates

| Surface | Behaviour when **OFF** |
|---|---|
| Payments nav tab (`components/nav/AppNav.js`) | Not rendered. |
| `/payments` (`app/payments/page.js`) | Renders a controlled "unavailable" page; **no auth or backend calls fire**. |
| `/payments/imports` (`app/payments/imports/page.js`) | Same controlled unavailable page. |

Single source of truth: **`lib/featureFlags.js` → `isPaymentsEnabled()`**. It is a
pure function of `NEXT_PUBLIC_*` env vars + `NODE_ENV` (no `window`, no React), so
it evaluates identically on the server and the client — no hydration mismatch — and
is safe to import anywhere (client component, page, or server route).

## Resolution order

`isPaymentsEnabled()` returns the first rule that applies:

1. **Explicit override** — `NEXT_PUBLIC_PAYMENTS_ENABLED` = `true|1|on|yes|enabled`
   → ON, or `false|0|off|no|disabled` → OFF. (Unset / blank / unrecognised falls
   through.)
2. **Local dev server** — `NODE_ENV !== 'production'` (`npm run dev`) → **ON**.
3. **DEV deployment** — `NEXT_PUBLIC_SUPABASE_URL` targets the DEV Supabase project
   (`kctctvpobbizhkiqkgqw`) → **ON**.
4. **Anything else** (PROD, or any unrecognised target) → **OFF** — fail-safe: the
   feature is never exposed unless positively enabled.

## Default behaviour (no env var set)

| Environment | Signal | Flag |
|---|---|---|
| localhost (`npm run dev`) | `NODE_ENV=development` | **ON** |
| localhost (prod build, DEV creds) | DEV Supabase ref | **ON** |
| DEV deployment | DEV Supabase ref | **ON** |
| **PROD deployment** | PROD Supabase ref | **OFF** |

## Overriding

Set `NEXT_PUBLIC_PAYMENTS_ENABLED` (it is a `NEXT_PUBLIC_` var, inlined at **build
time** — a Vercel redeploy is required for a change to take effect):

- Force **on** anywhere (e.g. a PROD canary once the backend is rolled out):
  `NEXT_PUBLIC_PAYMENTS_ENABLED=true`
- Force **off** in DEV (e.g. to preview the disabled experience):
  `NEXT_PUBLIC_PAYMENTS_ENABLED=false`

## Rollout sequence (do NOT flip the PROD flag before the backend exists)

1. Apply `fat-parity` phases **3 → 4 → 5 → 6** to PROD (see
   `supabase/prod-rollout/fat-parity/README.md`), validating each phase.
2. Confirm the PROD env (`SUPABASE_SERVICE_ROLE_KEY` = PROD key; OCR off or
   `PAYSLIP_OCR_PROVIDER=stub` until a valid key + PII review).
3. Set `NEXT_PUBLIC_PAYMENTS_ENABLED=true` for a canary, then broaden.
4. Once stable, the env-default (DEV-ref) logic can remain; the explicit override is
   the canary/rollback lever.

## Related

- `lib/featureFlags.js` — the resolver.
- `components/payments/PaymentsDisabled.js` — the controlled unavailable view.
- `supabase/prod-rollout/fat-parity/README.md` — the backend rollout runbook.
