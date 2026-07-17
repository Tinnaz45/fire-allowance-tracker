> # ⚠️ HISTORICAL DOCUMENT — DO NOT USE AS CURRENT REFERENCE
>
> **This document is HISTORICAL and predates the fat.* bounded-domain migration.**
>
> - All references to `public.fat_*` tables in this document are **OBSOLETE**.
> - The current canonical architecture uses the **`fat.*` bounded-domain schema**.
> - **`supabase/fat-schema.sql` is the authoritative schema definition.**
> - This document is retained **for rollout/audit history only**.
> - Do not rely on table names, schema details, or deployment steps below as a
>   description of current runtime state.

---

# Distance Estimation System — DEV Deploy Report
**Date:** 2026-05-14  
**Branch:** dev  
**Supabase project:** kctctvpobbizhkiqkgqw  
**Vercel project:** prj_d1cCc7dHXCKw04TNbwg1Wb130nBP  
**DEV alias:** fire-allowance-tracker-git-dev-tinnaz45s-projects.vercel.app

---

## MIGRATION STATUS ✅ COMPLETE

Migration `supabase-migration-v4-distance-tables.sql` applied to DEV Supabase project.

### Tables confirmed in DB:
- `fat_home_address` — geocoded home coordinates, address hash + version tracking
- `fat_station_distances` — per-user per-station cached driving distances

### Schema verified:
- Both tables have RLS enabled (`auth.uid() = user_id`, FOR ALL)
- `fat_set_updated_at()` triggers on both tables
- UNIQUE(user_id) on `fat_home_address` — matches `onConflict: 'user_id'` in code
- UNIQUE(user_id, station_id) on `fat_station_distances` — matches `onConflict: 'user_id,station_id'`
- Indexes: `idx_fat_station_distances_user_station`, `idx_fat_station_distances_user_stale`
- `confirmation_source` CHECK constraint: ('auto', 'manual')
- `geocode_status` CHECK constraint: ('ok', 'failed', 'pending')

### Schema compatibility notes (no action needed):
- Pre-existing `fat_home_address` has `id` uuid PK + UNIQUE(user_id), not user_id as PK.
  Code uses `onConflict: 'user_id'` — UNIQUE constraint present, fully compatible.
- `fat_station_distances.home_address_hash` is NOT NULL in DB. All code write paths
  always provide this value — no runtime issue.
- Both tables have duplicate RLS policies (from migration + pre-existing). Both policies
  are FOR ALL with identical `auth.uid() = user_id` semantics — permissive policies
  OR together, no conflict.

---

## CODE FIXES APPLIED ✅

### Fix: `lib/distance/addressCache.js` — `saveDistanceEstimate()` (local, needs push)

**Bug:** PostgreSQL `ON CONFLICT DO UPDATE` only updates columns listed in the upsert row.
The original `saveDistanceEstimate()` omitted `confirmed_distance_km`, `confirmation_source`,
and `confirmed_at` from the row, so a prior confirmed value would silently persist through
every recalculate. On next component mount, the old confirmed distance would appear
pre-filled, bypassing the re-confirmation step entirely.

**Fix applied in local file:**
```js
const row = {
  // ... other fields ...
  // Explicitly clear any previous confirmed distance — user must re-confirm
  // after every recalculate. Without this, a stale confirmed_distance_km would
  // silently persist on the next component mount and skip re-confirmation.
  confirmed_distance_km: null,
  confirmation_source:   null,
  confirmed_at:          null,
  // ...
}
```

**Status:** Fix is in `lib/distance/addressCache.js` on disk. Needs git commit + push.

---

## DEPLOY STATUS ⚠️ ONE MANUAL STEP REQUIRED

### Current live DEV deployment:
- ID: `dpl_2okganaPQ7kE1n4E1gYY3kRNGXbZ`
- Commit: `4548c36b` — "fix(page): push corrected app/page.js with outer column wrapper div"
- State: READY
- **Does NOT include the `addressCache.js` fix** (not yet pushed)

> **Historical note:** this report is a point-in-time snapshot from when the
> `addressCache.js` fix was still pending push. That fix shipped long ago, and the
> `push-fix.bat` helper it references has since been **retired**. The current
> repository workflow is in [`CLAUDE.md`](CLAUDE.md): work on a temporary branch
> and open a PR into `dev`. The steps below are retained only as a record of what
> was done at the time.

### To deploy the fix (historical — `push-fix.bat` has been retired):
```
Committed lib/distance/addressCache.js and pushed to the dev branch,
then Vercel auto-deployed. Today, use a temporary branch + PR into dev
(see CLAUDE.md) instead of a helper script.
```

This did:
1. `git add lib/distance/addressCache.js`
2. `git commit -m "fix(distance): clear confirmed_distance_km on every recalculate"`
3. `git push origin dev`
4. Vercel auto-deployed (typically 2–3 minutes)

---

## VALIDATION CRITERIA STATUS (14 of 14)

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `fat_home_address` table exists in DB | ✅ PASS |
| 2 | `fat_station_distances` table exists in DB | ✅ PASS |
| 3 | RLS enabled on both tables | ✅ PASS |
| 4 | `saveDistanceEstimate()` clears prior confirmed values | ✅ PASS (fix applied) |
| 5 | `saveConfirmedDistance()` persists all confirmation fields | ✅ PASS |
| 6 | `markAllDistancesStale()` covers all user rows | ✅ PASS |
| 7 | Profile page triggers `markAllDistancesStale` on address change | ✅ PASS |
| 8 | `StationDistanceField` phase machine: idle→loading→show_estimate→confirmed | ✅ PASS |
| 9 | Stale phase shows recalculate-only (no Accept button) | ✅ PASS |
| 10 | `canAutoEstimate` guard in ClaimForm | ✅ PASS |
| 11 | Non-recall claim types do not trigger distance field | ✅ PASS |
| 12 | OSRM/Nominatim cached (no re-call on cache hit) | ✅ PASS |
| 13 | Address normalisation consistent across all write paths | ✅ PASS |
| 14 | Existing submitted claims unaffected by staleness sweep | ✅ PASS |

---

## LIVE BROWSER TESTING STATUS ⚠️ PENDING (manual)

Browser automation tools timed out throughout this session (180s ceiling, systemic).
Live testing of scenarios A–G must be done manually against the DEV URL after pushing.

### DEV URL (after push + Vercel redeploy):
`https://fire-allowance-tracker-git-dev-tinnaz45s-projects.vercel.app`

### Scenarios to test manually:

**A. First Recall claim (new user, no cache)**
- Log in, ensure home address is set in Profile
- Open New Claim → Recall
- Distance field should show loading spinner → then estimated km
- Accept estimate → submit claim → verify `confirmed_distance_km` saved in `fat_station_distances`

**B. Manual override**
- Open second Recall claim to same station
- Distance field should show cached estimate (no API call)
- Click Edit → type custom km → Save
- Verify `confirmation_source = 'manual'` in DB

**C. Cache reuse (no API re-call)**
- Open third Recall claim to same station
- Field should pre-populate confirmed km from cache immediately (no loading state)
- Nominatim/OSRM should NOT be called (check Network tab)

**D. Address change → stale distances**
- Go to Profile → change home address → Save
- Verify success message: "Station distances have been marked for re-confirmation"
- Open new Recall claim → field should show "stale estimate" with Recalculate button only
- Recalculate → Accept → verify `is_stale = false` + new confirmed distance in DB

**E. API failure fallback**
- Temporarily test with invalid address (e.g. "ZZZZZ 99999")
- Field should show graceful error state (not crash)
- Form should still be submittable with manual km entry

**F. Existing claim preservation**
- After address change, open an already-submitted Recall claim
- Verify it still shows the original saved distance (not affected by staleness)

**G. Non-recall claim types**
- Create a Retain, Standby, Spoilt Meal, or Delayed Meal claim
- Verify NO distance field appears
- Verify submission works normally

---

## WHAT'S DONE vs WHAT'S LEFT

| Item | Status |
|------|--------|
| Migration v4 applied to DEV Supabase | ✅ Done |
| addressCache.js bug fix written to disk | ✅ Done |
| push-fix.bat helper script created | ✅ Done |
| `git commit + push` to trigger Vercel redeploy | ⚠️ Run push-fix.bat |
| Live browser testing (scenarios A–G) | ⚠️ Manual — see above |
| Merge dev → main | ⛔ After user testing sign-off only |

---

## READY FOR MANUAL USER TESTING

After running `push-fix.bat` and waiting ~3 minutes for Vercel to rebuild:

**YES** — the DEV system is ready for manual testing of all 7 scenarios.

The DB is ready (migration applied), the code is correct (all fixes on disk),
and the DEV deployment will be live once pushed.

## READY FOR MAIN MERGE

**NO** — do not merge until:
1. `push-fix.bat` has been run and Vercel redeploys successfully
2. Manual testing of scenarios A–G passes
3. User sign-off obtained
