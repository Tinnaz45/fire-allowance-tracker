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
2. Confirm the PROD env (`SUPABASE_SERVICE_ROLE_KEY` = PROD key). OCR stays OFF
   until a valid provider key + PII review (see *OCR availability* below) — the
   feature works fully on manual entry without it.
3. Set `NEXT_PUBLIC_PAYMENTS_ENABLED=true` for a canary, then broaden.
4. Once stable, the env-default (DEV-ref) logic can remain; the explicit override is
   the canary/rollback lever.

## OCR availability (separate from this flag)

Automatic payslip-screenshot OCR is gated **independently** of `isPaymentsEnabled()`,
by whether a real provider key is configured server-side — NOT by the feature flag.
This prevents the deterministic **stub** extractor (which fabricates sample payslip
lines) from ever reaching a user when no provider is set up (e.g. PROD has no
`OPENAI_API_KEY`).

- Single source of truth: **`lib/fat/services/payslipExtraction.js` →
  `isRealOcrAvailable()` / `resolveExtractionAdapter()`**.
- **No provider key** → `resolveExtractionAdapter()` returns `null` →
  `POST /api/payslip/extract` returns **503 `ocr_unavailable`** and the **"Extract
  lines" UI is hidden** (the page probes `GET /api/payslip/extract` →
  `{ available }`). Manual entry, reconciliation, payment records, and screenshot
  *storage* are unaffected.
- **Provider key set** (`OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` with
  `PAYSLIP_OCR_PROVIDER=anthropic`) → real OCR runs.
- The stub is reachable only by explicit dev opt-in (`PAYSLIP_OCR_ALLOW_STUB`, never
  honored in production) or by tests injecting it directly — it is never an automatic
  fallback. So enabling the Payments flag in a key-less environment is safe: users
  cannot generate fabricated lines.

## Related

- `lib/featureFlags.js` — the resolver.
- `lib/fat/services/payslipExtraction.js` — `isRealOcrAvailable` / `resolveExtractionAdapter`.
- `app/api/payslip/extract/route.js` — 503 gate + `GET` availability probe.
- `components/payments/PaymentsDisabled.js` — the controlled unavailable view.
- `supabase/prod-rollout/fat-parity/README.md` — the backend rollout runbook.
