# Final branch disposition — 2026-07-15

Base: `dev` (tip `15b5e25`). Goal: reduce the repo to **`dev` + `main` only**.
This report resolves the four remaining unmerged branches. **No branches were
merged, deleted, or migrated** — this is analysis + a plan only.

## Headline findings

1. **The Payments rollout gate the two feature-flag branches propose is ALREADY
   on `dev`, in a superior form.** The merged `feature-flag-relational-schema`
   work gives `dev` a full three-layer gate — global env flag → authenticated
   user → per-user DB whitelist row — wired into **every** Payments surface
   (both pages, the nav tab, and the API route with a server-side 403).
   → **Neither feature-flag branch should be merged.** The task's original
   premise ("merge the focused Payments whitelist branch") is obsolete.

2. **The canonical dual-write implementation is abandoned on `dev`** (dev
   persists entitlements directly). Its migrations **collide** with dev's
   existing `04_`/`05_` canonical migrations. → Do not revive.

3. **One valuable rule is NOT on `dev`:** the Further-From-Home (FFH)
   excess-travel payability gate. Captured in
   `docs/SALVAGE_FROM_CANONICAL_BRANCHES.md` for human review before deletion.

## Evidence — Payments gating already on `dev`
| Surface | dev gate |
|---|---|
| `app/payments/page.js` | `isPaymentsEnabled()` **and** `featureEnabled(flags,'payments')` → `<PaymentsDisabled/>` |
| `app/payments/imports/page.js` | same two-condition gate |
| `app/api/payslip/extract/route.js` | `hasFeature('payments',{userId})` — global flag **and** per-user DB row; **403** on POST, `available:false` on GET |
| `components/nav/AppNav.js` | tab hidden unless `isPaymentsEnabled() && featureEnabled(flags,'payments')` |
| `lib/features/hasFeature.js` | conjunction: global flag **AND** authed user **AND** `(user_id,feature_name)` row |
| `supabase/canonical/19_user_feature_flags.sql` | the per-user feature table (already on dev) |

The `payments-user-whitelist` branch's "UUID-only allow-list" is a **cruder,
env-var** version of dev's **relational, RLS-capable** per-user table. Merging it
would be a regression, and (being ~months behind) its diff would also revert
current dev work (petty-cash tests, `MdDistanceField`, `lib/features/*`).

## Disposition table

| Branch | Unique value vs current `dev` | Disposition |
|---|---|---|
| `claude/per-user-feature-flags-92fgrj` | none — per-user flags already on dev (`lib/features/*` + `19_user_feature_flags.sql`) | **Delete** (salvage: none required) |
| `claude/payments-user-whitelist-n97b3y` | none — whitelist already on dev via per-user table; only a `test-payments-authorization.mjs` script is portable | **Delete** (optionally port the test — see plan) |
| `claude/sweet-lovelace-Gyd6s` | FFH rule (salvaged) + dual-write (abandoned) | **Delete** after salvage doc lands |
| `claude/beautiful-ptolemy-Um7jb` | audit docs (referenced in salvage doc) | **Delete** after salvage doc lands |
| `claude/vibrant-thompson-VXGuq` | subset of sweet-lovelace | **Delete** |
| `claude/add-station-distances-BYF9b` | feature commit already patch-identical in dev | **Delete** |
| `claude/great-dijkstra-db1yg` | only `.claude/settings.local.json` | **Delete** |
| `claude/audit-md-petty-cash-km-452ssi` | is the current dev tip | **Delete** |
| `claude/feature-flag-relational-schema-j64t08` | merged | **Delete** |
| `claude/laughing-sagan-d9K1h` | merged | **Delete** |
| `claude/loving-meitner-T4Rph` | merged | **Delete** |
| `feat/payslip-reconciliation-recovery` | merged | **Delete** |

Result after deletion: **`dev` + `main` only.** (Plus this working branch,
`claude/branch-audit-cleanup-3l8giq`, which carries these reports — delete it
once they're reviewed/merged into dev.)

## "Merge-ready Payments whitelist" plan — outcome: no merge needed
Per objective 5, a merge-ready whitelist branch was to be prepared *if it remains
sound*. **It does not remain the right move**: `dev` already implements a strictly
more capable version. Recommended actions instead:
1. **Do not merge** `payments-user-whitelist-n97b3y` or `per-user-feature-flags-92fgrj`.
2. *(Optional, low priority)* Port `scripts/test-payments-authorization.mjs` from
   the whitelist branch onto `dev` as a regression test for the existing gate,
   after re-pointing it at `hasFeature`/`featureEnabled` (currently written
   against the old `lib/featureFlags.js` API). Verify it against dev's 403 path.
3. Confirm the per-user table (`19_user_feature_flags.sql`) is applied in the DEV
   Supabase project (do **not** apply from here — migrations are out of scope).

## Migration conflict check (TESTS objective)
- `sweet-lovelace` `04_dual_write_provenance.sql` / `05_ffh_home_distances.sql`
  **conflict** with dev's `04_seed_rates.sql` / `05_seed_station_distance_matrix.sql`
  (same ordinals). **Do not apply.**
- `per-user-feature-flags` `19_user_feature_flags.sql` differs from the version
  already on dev; dev already carries two `19_*` files
  (`19_seed_spring_street_station.sql`, `19_user_feature_flags.sql`). No new
  migration should be introduced from these branches.

## Risks requiring human review
1. **FFH excess-travel gate** — decide whether it's a real gap on `dev` (see
   salvage doc §1). If yes, reimplement the pure `ffh.js` predicate into the
   current engine; do not resurrect the branch/migrations.
2. **Branch deletion is blocked from automation** — the git relay returns
   **HTTP 403** on delete pushes (write scope = working branch only) and no
   ref-delete API is exposed. A maintainer must run the deletions.
3. Confirm DEV Supabase has `user_feature_flags` applied so the per-user gate
   actually resolves in the DEV deployment.

## Deletion commands (maintainer runs; after salvage docs are reviewed)
```sh
git push origin --delete claude/audit-md-petty-cash-km-452ssi
git push origin --delete claude/feature-flag-relational-schema-j64t08
git push origin --delete claude/laughing-sagan-d9K1h
git push origin --delete claude/loving-meitner-T4Rph
git push origin --delete feat/payslip-reconciliation-recovery
git push origin --delete claude/add-station-distances-BYF9b
git push origin --delete claude/great-dijkstra-db1yg
git push origin --delete claude/vibrant-thompson-VXGuq
git push origin --delete claude/per-user-feature-flags-92fgrj
git push origin --delete claude/payments-user-whitelist-n97b3y
git push origin --delete claude/sweet-lovelace-Gyd6s
git push origin --delete claude/beautiful-ptolemy-Um7jb
# and finally, once these reports are merged into dev:
# git push origin --delete claude/branch-audit-cleanup-3l8giq
```
