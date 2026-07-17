# CLAUDE.md — Fire Allowance Tracker

> **This file is the source of truth for the repository workflow.**
> Where any other document (README, `docs/`, `.claude/rules.md`, script comments,
> hook messages) disagrees with this file about how branches, PRs, or production
> promotion work, **this file wins**. Fix the other document to match.

Fire Allowance Tracker (FAT) is a Next.js 15 + Supabase app. This document
defines **only** the repository and Git workflow. It does **not** change the
application, authentication, Supabase, migrations, calculations, payroll, or OCR
behaviour — those safeguards are summarised at the end and must be preserved.

---

## 1. Canonical development workflow

`dev` is the **default and canonical development branch**. Production lives on
`main`. Every task follows the same loop:

1. **Start from current `origin/dev`.** Fetch first; never assume local `dev` is
   up to date.
   ```bash
   git fetch origin
   git checkout dev
   git pull --ff-only origin dev
   ```
2. **Create a temporary branch** for the task — a feature, fix, docs, or task
   branch cut from current `origin/dev`:
   ```bash
   git checkout -b <type>/<short-description> origin/dev
   ```
   Use a clear prefix: `feat/`, `fix/`, `docs/`, `chore/`, `task/`.
3. **Do the work on that temporary branch.** Never commit ordinary work directly
   to `dev` or `main`.
4. **Push the temporary branch** to GitHub:
   ```bash
   git push -u origin <type>/<short-description>
   ```
5. **Open a pull request into `dev`** (never into `main` for ordinary work).
6. **Verify required checks and the Vercel Preview deployment** for the PR before
   merging. A green Vercel Preview is the authoritative build signal.
7. **Squash merge is preferred** for temporary branch → `dev`.

### Post-merge cleanup (order matters)

Do these in order. Do **not** delete the local branch before local `dev` has been
updated and the changes proven present.

1. **Confirm the PR was squash-merged into `dev`.**
2. **Confirm GitHub deleted the remote PR source branch.** Automatic deletion of
   merged PR source branches is the required workflow, but it is not guaranteed —
   verify it actually happened (e.g. `git ls-remote --heads origin <branch>`
   returns nothing, or the branch is gone on GitHub). If the remote branch still
   exists, **stop and report it** — do not delete it manually and do not change
   repository settings to force it.
3. **Fetch GitHub:**
   ```bash
   git fetch origin --prune
   ```
4. **Check out local `dev`:**
   ```bash
   git checkout dev
   ```
5. **Fast-forward local `dev` from `origin/dev`:**
   ```bash
   git pull --ff-only origin dev
   ```
6. **Prove the merged changes are present in updated `dev`** before deleting
   anything — e.g. confirm the squash commit is in `git log`, or that the source
   branch's changes are contained:
   ```bash
   git log --oneline -5 dev
   git branch --merged dev | grep <type>/<short-description>   # may be empty after squash — see note
   ```
7. **Delete the local source branch:**
   ```bash
   git branch -d <type>/<short-description>
   ```
   - Use `git branch -d` (safe delete) whenever Git accepts it.
   - Squash merging **rewrites the commit identity** — it collapses the branch's
     commits into a single new commit on `dev` with a different SHA — so
     `git branch -d` may **refuse** deletion even though the changes are safely
     present. Only then, and **only after independently proving** the source
     branch's changes are contained in updated `dev` (step 6), use
     `git branch -D <branch>`. Do **not** treat unconditional `git branch -D` as
     the normal path.

### Remote vs local branch cleanup

- **Remote** source branch: **GitHub** handles this. Automatic deletion of merged
  PR source branches is the required workflow, but not guaranteed — **verify**
  after every merge. If it still exists, stop and report rather than deleting it
  manually or assuming cleanup completed. Repository settings must not be changed
  without explicit approval.
- **Local** source branch: **Claude Code / you** delete this separately, after
  `dev` is updated and the changes are proven present — `git branch -d`, falling
  back to `git branch -D` only when squash-rewritten identity blocks the safe
  delete (see step 7).

These are two separate actions. Confirming the remote branch is gone does **not**
remove the local branch.

---

## 2. Production approval gate (`dev → main`)

Production is a **separate, explicitly approved** action, never part of ordinary
task flow.

- `main` **is** production. Vercel auto-deploys production on push to `main`.
- **Never** commit, push, or merge to `main` without **Danny's explicit approval
  in the current conversation.**
- DEV work must be **completed and verified** on `dev` first.
- Ordinary feature / fix / docs / task work **must never** go directly into
  `main`. It always lands on `dev` first via the PR flow above.
- Promotion `dev → main` is done as an **explicitly approved GitHub action**
  (open a PR from `dev` into `main`, or use the approved promotion step in
  [`docs/PROD_ROLLOUT_CHECKLIST.md`](docs/PROD_ROLLOUT_CHECKLIST.md)). A
  **merge commit** may be used for `dev → main`. **Rebase merging is disabled.**
- A local `git merge` + `git push origin main` from a workstation is **not** the
  documented production path and must not be presented as the normal workflow.

FAT-specific production promotion — database migration order, Supabase exposure,
schema validation, smoke tests, rollback anchors, and financial-integrity
checks — is governed by [`docs/PROD_ROLLOUT_CHECKLIST.md`](docs/PROD_ROLLOUT_CHECKLIST.md).
Consult it for any `dev → main` promotion. It does not override the approval gate
above.

---

## 3. Branch lifecycle summary

| Stage | Branch | Action |
|-------|--------|--------|
| Start | `origin/dev` | Fetch; cut a temporary branch |
| Work | `<type>/<desc>` | Commit locally |
| Publish | `<type>/<desc>` | Push; open PR **into `dev`** |
| Verify | PR | Required checks + Vercel Preview green |
| Merge | `<type>/<desc>` → `dev` | **Squash merge** (preferred) |
| Cleanup (remote) | — | GitHub deletes the remote source branch (required workflow) — **verify** it happened; stop and report if not |
| Sync | `dev` | Fetch → checkout `dev` → `git pull --ff-only origin dev` → prove changes present |
| Cleanup (local) | — | **Then** delete local branch: `git branch -d` (fall back to `-D` only after proving changes are in `dev`) |
| Production | `dev` → `main` | **Separate, explicitly approved** promotion (merge commit) |

---

## 4. Git hooks

Repository hooks live in `scripts/hooks/` and are installed into `.git/hooks/`
by `scripts/install-hooks.mjs`. This runs automatically via the `prepare` script
in `package.json` on `npm install`. To (re)install manually:

```bash
node scripts/install-hooks.mjs
```

- **`pre-commit`** — blocks empty/truncated/syntactically-invalid staged source
  files and invalid `package.json`.
- **`pre-push`** — blocks a push to `origin/main` unless you are actually on the
  `main` branch, preventing silent false-success deploys. It points you back to
  this PR workflow.

Emergency bypass exists (`git commit --no-verify`, `git push --no-verify`) but is
for genuine emergencies only.

---

## 5. FAT-specific safeguards (do not change via workflow cleanup)

Repository-workflow standardisation must **never** contradict or alter any of the
following application safeguards:

- Client-side Supabase authentication; **no middleware**; current session
  handling and auth flow unchanged.
- Service-role key usage is **server-side only**.
- **DEV and PROD Supabase are separate projects**; PROD migration restrictions
  and ordered canonical migrations apply.
- Vercel **DEV/PROD environment separation** is preserved.
- **Payments feature flag** defaults stay as configured (Payments is dark in PROD
  via feature flag).
- **Payslip OCR safeguards:** no production OCR stub fallback; PII and retention
  review gates apply before any real OCR read in production.
- **Hours-first entitlements**; **no implicit hours-to-dollars conversion.**
- **Duplicate-detection and over-allocation protections** stay intact.
- Calculation rules, financial verification requirements, and schema guardrails
  stay intact — see [`docs/CALCULATION_RULES.md`](docs/CALCULATION_RULES.md) and
  [`docs/FINANCIAL_VERIFICATION_CHECKLIST.md`](docs/FINANCIAL_VERIFICATION_CHECKLIST.md).
- **Re-test authentication** after any auth-adjacent change.
- The `fat` schema must remain **exposed** to PostgREST (see
  [`docs/FAT_SCHEMA_ARCHITECTURE.md`](docs/FAT_SCHEMA_ARCHITECTURE.md)).

When a task touches any of the above, consult the relevant FAT operational
document in [`docs/`](docs/) before proceeding.
