# FAT — PROD Rollout Execution Checklist

> **Authoritative, operator-ready.** Promotes the reconciled `fat.*` architecture
> and recall-leg auto-distance system from DEV → PROD/`main`.
> Follow phases in order. Do **not** skip a Go/No-Go gate.
>
> | Item                     | Value                                                                  |
> |--------------------------|------------------------------------------------------------------------|
> | DEV Supabase project ref | `kctctvpobbizhkiqkgqw`                                                 |
> | PROD Supabase project ref| `wgcqzamuspuqpedqasbc`                                                 |
> | Source branch            | `dev` @ `f9d6543`                                                      |
> | Target branch            | `main` (Vercel **auto-deploys** on push)                               |
> | Canonical DDL            | [`supabase/fat-schema.sql`](../supabase/fat-schema.sql)                |
> | Audit                    | [`FAT_SCHEMA_AUDIT_REPORT.md`](../FAT_SCHEMA_AUDIT_REPORT.md)          |
> | PROD users at rollout    | **None** (greenfield — orphaned `public.fat_*` may be retained as cold rollback) |

---

## Operator preconditions (one-time)

- [ ] You have **owner** access to the Supabase PROD project (`wgcqzamuspuqpedqasbc`).
- [ ] You have **push** rights to `origin/main`.
- [ ] You can read Vercel deployment logs for the PROD project.
- [ ] Local working tree is at branch `dev`, clean, in sync with `origin/dev`.
- [ ] You have the PROD env vars on file (`NEXT_PUBLIC_SUPABASE_URL`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`) — these are already configured in Vercel; do **not** rotate during rollout.

---

## Phase 0 — Local preflight

**Goal:** confirm `dev` is exactly the state we intend to ship.

```powershell
git fetch --all --prune
git checkout dev
git status                                  # MUST report: nothing to commit, working tree clean
git rev-parse HEAD                          # expect: f9d6543... (or newer with the same audit lineage)
git log --oneline main..dev                 # review every commit that will land on main
npm ci                                       # clean install — fail fast on lockfile drift
npm run build                                # MUST end with "Compiled successfully"
```

**Expected success:** `next build` prints `✓ Compiled successfully` and `✓ Generating static pages (14/14)`.

**Stop if:**
- build fails for any reason other than the known benign warnings listed in
  `FAT_SCHEMA_AUDIT_REPORT.md#build-status`.
- `git status` shows any uncommitted/untracked code change.
- `main..dev` includes a commit you did not author or do not recognise.

---

## Phase 1 — PROD database backup (mandatory rollback anchor)

**Goal:** create an undo point **before** any DDL.

1. Open Supabase Dashboard → project `wgcqzamuspuqpedqasbc` → **Database → Backups**.
2. Note the most recent automatic backup timestamp (PITR window or daily backup).
3. Trigger a **manual on-demand backup** if the menu allows; otherwise rely on PITR.
4. Record the backup label / restore-to timestamp in your run log.

**Go/No-Go Gate 1:** a known-good restore point exists, dated within the last hour.
If not, **stop** — do not proceed without a snapshot.

---

## Phase 2 — Apply `fat` schema to PROD

**Goal:** create the `fat` schema, tables, RPC, triggers, RLS, and grants on PROD.

> Approach: run [`supabase/fat-schema.sql`](../supabase/fat-schema.sql) verbatim.
> Every statement is idempotent (`create … if not exists`, `create or replace`).
> Legacy `public.fat_*` tables are **not touched** — they remain in place as a
> cold rollback artefact and can be dropped later in a separate cleanup PR.

### 2a. Open SQL editor

- Supabase Dashboard → project `wgcqzamuspuqpedqasbc` → **SQL Editor → New query**.
- Paste the **entire** contents of `supabase/fat-schema.sql`.
- Do **not** modify it in the editor.

### 2b. Execute

- Press **Run**.
- Watch for any red error message in the output panel.

**Expected success:** every statement reports `Success. No rows returned.`
The migration runs in well under 5 seconds.

**Failure indicators:**
- `permission denied for schema auth` → you are connected as the wrong role; abort.
- `relation "fat.X" already exists` on a **non-idempotent** statement → unexpected;
  capture full error and **stop** before running anything else.
- Any `ERROR:` referencing FK targets `auth.users` → the project is not a Supabase
  project; abort.

**Go/No-Go Gate 2:** SQL editor reports success for every statement. No red errors.

---

## Phase 3 — Expose `fat` schema to PostgREST

**Goal:** make `fat.*` reachable from the anon/authenticated client.

Without this step the runtime will fail with
*"The schema must be one of the following: public, …"*.

1. Supabase Dashboard → **Project Settings → API → Exposed schemas**.
2. Current value should read `public`. **Add** `fat` (comma-separated).
3. Save. PostgREST hot-reloads automatically; no app restart required.

**Verification:** in the SQL editor:

```sql
select current_setting('pgrst.db_schemas', true);
```

**Expected success:** result contains `fat`.

**Stop if:** the value does not contain `fat` after a Save + page refresh.

---

## Phase 4 — PROD schema validation (read-only SQL)

Run these queries in the Supabase SQL editor **in order**. Every assertion is a
Go/No-Go condition. Stop on the first failure.

### 4a. Schema exists

```sql
select schema_name from information_schema.schemata where schema_name = 'fat';
```
**Pass:** 1 row.

### 4b. Tables present (expect 13)

```sql
select table_name
from information_schema.tables
where table_schema = 'fat'
order by table_name;
```
**Pass — must list exactly these 13:**
`claim_groups, claim_sequences, distance_cache, financial_years, home_address,
profile_ext, recalls, retain, spoilt_meals, standby, station_distances, stations,
user_rates`.

### 4c. RLS enabled on every FAT table

```sql
select relname, relrowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'fat' and c.relkind = 'r'
order by relname;
```
**Pass:** every row has `relrowsecurity = true`. Zero rows with `false`.

### 4d. Policies present

```sql
select tablename, policyname
from pg_policies
where schemaname = 'fat'
order by tablename, policyname;
```
**Pass — expect 14 policies:**
- 12 × `users_manage_own` (financial_years, claim_sequences, claim_groups, profile_ext,
  distance_cache, home_address, station_distances, recalls, retain, standby,
  spoilt_meals, user_rates).
- 1 × `authenticated_read` on `stations`.
- 1 × `service_role_manage` on `stations`.

### 4e. RPC present and callable

```sql
select proname, pg_get_function_identity_arguments(oid) as args
from pg_proc
where pronamespace = 'fat'::regnamespace
order by proname;
```
**Pass — must list:**
- `increment_claim_sequence(uuid, uuid, text)`
- `set_updated_at()`

### 4f. Generated/typed columns sane

```sql
select column_name, data_type, is_generated
from information_schema.columns
where table_schema = 'fat' and table_name = 'recalls'
  and column_name in ('total_km','dist_home_km','dist_stn_km')
order by column_name;
```
**Pass:** `total_km` shows `is_generated = ALWAYS`. `dist_home_km`/`dist_stn_km` are `numeric`.

### 4g. Stations seed data

```sql
select count(*) from fat.stations;
```
**Pass:** count > 0 (the DEV reference has 48). If count = 0, populate from a seed
script **before** going further — the station picker will be empty otherwise.

> Seed source: copy rows from DEV using the dashboard table editor's "Export → SQL",
> or replay any pre-existing seed file. **No new seed script is to be authored here.**

**Go/No-Go Gate 4:** Phases 4a–4g all pass. If 4g fails and you cannot seed
stations from a known-good source, **stop** and unblock seeding first.

---

## Phase 5 — Merge `dev` → `main` (locally, no push yet)

**Goal:** prepare `main` to deploy, but stay reversible until you push.

```powershell
git checkout main
git pull --ff-only origin main
git merge --ff-only dev
git log --oneline -1                        # expect HEAD = f9d6543 (or current dev HEAD)
```

**Stop if:** `--ff-only` rejects the merge. That means `main` has commits not on
`dev` — investigate before continuing. **Do not** create a merge commit to "fix"
this; resolve out of band.

> No push yet. Vercel only triggers on push to `origin/main`.

---

## Phase 6 — Deploy (push to `main`)

**Goal:** trigger the Vercel auto-deploy now that PROD DB is ready.

**Go/No-Go Gate 6:** Phases 1–5 all green. PROD DB has `fat.*`. `fat` is in
Exposed schemas. Local `main` is fast-forwarded to `dev`. Local build passes.

If any of the above is **no**, do not push.

```powershell
git push origin main
```

Immediately:

1. Open Vercel Dashboard → fire-allowance-tracker → **Deployments**.
2. Confirm a new deployment from commit `f9d6543` (or the dev HEAD you pushed) is
   building against the `main` branch.
3. Watch the build log to completion.

**Expected success:** deployment status `Ready` within ~2 min. No build error.
Vercel is the build and deployment system; a `Ready` deployment is the
authoritative signal that the build succeeded.

**Failure indicators:**
- Vercel build fails → triage from build log; if it's a schema-runtime mismatch,
  proceed to Phase 9 (Rollback).

---

## Phase 7 — PROD smoke tests (browser, against PROD URL)

**Goal:** confirm the live deployment talks to `fat.*` correctly.

Open the PROD URL in a private/incognito window. Sign in (or sign up a fresh
test account). Execute the open-items list from
[`FAT_SCHEMA_AUDIT_REPORT.md#open-items-for-dev-testing`](../FAT_SCHEMA_AUDIT_REPORT.md)
**in this order**:

1. **Profile load + save** — open Profile → set/edit home address, rostered
   station, platoon → Save. Reload page. Expect values to persist.
   *Touches `fat.profile_ext`.*

2. **Station picker** — Recall claim form → station dropdown shows a populated
   list. *Touches `fat.stations` (RLS `authenticated_read`).*

3. **Create one of each claim type** — Recall, Retain, Standby, Spoilt, Delayed
   Meal. Save. Each must appear in the dashboard claim list.
   *Touches `fat.recalls / retain / standby / spoilt_meals` + RPC
   `fat.increment_claim_sequence`.*

4. **FY switcher** — create a new FY in Settings → switch → confirm claim list
   filters by `financial_year_id`. *Touches `fat.financial_years`.*

5. **Distance estimator (recall-leg auto-distance)** — set home address; create a
   Recall against a station with no cached row; estimator fills the leg distance;
   confirm/override and persist.
   *Touches `fat.home_address` + `fat.station_distances`.*

6. **Grouped-claim reconciliation** — mark a sub-claim Paid; observe parent
   `parent_status` recompute. *Touches `fat.claim_groups` parent-status logic.*

7. **User rates round-trip** — Settings → user rates → set an override → save →
   reload → verify. *Touches `fat.user_rates`.*

**Pass criteria:** all 7 succeed without error. Browser dev-tools console shows
no `PGRST` / `schema must be one of` errors.

**Go/No-Go Gate 7:** all 7 smoke tests green. If any fail, capture the failing
network request + response and proceed to Phase 9.

---

## Phase 8 — Post-deploy verification

- [ ] Tag the released commit:
  ```powershell
  git tag -a prod-fat-rollout-2026-05-17 -m "fat.* schema live on PROD"
  git push origin prod-fat-rollout-2026-05-17
  ```
- [ ] In Vercel, mark the deployment **Production** (it should already be — confirm).
- [ ] Add a one-liner to the run log: PROD ref, deployment ID, time, operator.
- [ ] Leave legacy `public.fat_*` tables **in place** for at least 7 days as a
      cold rollback artefact. Their cleanup is a separate, follow-up PR.

---

## Phase 9 — Rollback procedures

Pick the smallest blast-radius option that resolves the failure.

### 9a. App-only rollback (runtime broken, DB fine)

Use when smoke tests fail but the schema/RLS look correct, or when the build
itself fails after push.

```powershell
git checkout main
git revert --no-edit HEAD                   # creates a clean revert commit
git push origin main                        # Vercel auto-deploys the revert
```

Vercel can **also** be rolled back from the dashboard: Deployments → previous
green deployment → **Promote to Production**. This is faster than the git
revert and should be the first move if the production app is visibly broken.

After the dashboard promote, still create the git revert so `main` HEAD reflects
production. Otherwise the next push will re-deploy the broken commit.

### 9b. Database rollback (schema/RLS misconfiguration)

Use when DDL on Phase 2 left PROD in an inconsistent state.

Option 1 — Drop the `fat` schema (greenfield only, **no users yet**):

```sql
drop schema if exists fat cascade;
```

This removes every FAT-owned object. Safe **only** because there are no real
users; if any user has signed up between Phase 2 and now, prefer Option 2.

Option 2 — Restore PROD from the Phase 1 backup:

- Supabase Dashboard → Database → Backups → restore the snapshot captured in
  Phase 1.
- Confirm restore completes.
- Remove `fat` from **Exposed schemas** if it is no longer present.

Either option must be followed by Phase 9a to revert the app to a `public.fat_*`-
compatible commit.

### 9c. Exposed-schema rollback (PostgREST denying `fat.*` queries)

If smoke tests fail with `schema must be one of the following: public, …`:

- Re-open **Project Settings → API → Exposed schemas**.
- Confirm `fat` is present and **saved**.
- Hard-refresh the browser (PostgREST hot-reloads; client may have cached).
- If the value is correct and queries still fail, fall to 9a.

---

## Manual checkpoints (operator-attention summary)

| Gate                  | What you must verify by hand                                                |
|-----------------------|-----------------------------------------------------------------------------|
| Gate 1 — Backup       | A restore point dated within the last hour exists for PROD.                 |
| Gate 2 — DDL applied  | `fat-schema.sql` ran with no red errors.                                    |
| Gate 3 — Exposure     | `fat` listed under **Exposed schemas** and `current_setting` returns it.    |
| Gate 4 — Validation   | All seven 4a–4g read-only SQL checks pass, stations seeded.                 |
| Gate 5 — FF merge     | `main` fast-forwards cleanly to `dev` with no merge commit.                 |
| Gate 6 — Push timing  | Push only **after** Gates 1–5 are green; never the other way round.         |
| Gate 7 — Smoke tests  | All seven browser flows succeed against PROD.                               |

---

## Out of scope (do **not** do during this rollout)

- Drop legacy `public.fat_*` tables. (Separate cleanup PR after 7-day soak.)
- Apply `supabase-migration-v3-payment-components.sql` to PROD.
- Author new migrations.
- Refactor `routeLegEngine` or any claims engine.
- Upgrade Next.js, Supabase JS, or any dependency.
- Add ESLint/TypeScript.
- Change auth or RLS shape beyond what `fat-schema.sql` defines.
- Rotate Supabase keys or Vercel env vars.

---

## Run log template

Fill this in as you execute. Keep it with the run record.

```
Operator:           ____________________
Date/time start:    ____________________  (UTC)
PROD backup ID:     ____________________
Phase 2 DDL run at: ____________________  result: ✅ / ❌  notes:
Exposed schemas:    public, fat            verified at: ______
Validation 4a–4g:   ✅ / ❌                  notes:
Stations count:     ______
Local main HEAD:    ____________________  (sha after FF)
Pushed at:          ____________________
Vercel deploy ID:   ____________________  status: ✅ / ❌
Smoke 1–7:          ✅ / ❌                  failing step:
Released tag:       prod-fat-rollout-________________
Outcome:            ROLLED OUT / ROLLED BACK
```
