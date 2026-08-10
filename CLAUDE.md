# CLAUDE.md — Fire Allowance Tracker

> **This file is the source of truth for the repository workflow.**
> Where any other document (README, `docs/`, `.claude/rules.md`, script comments,
> hook messages) disagrees with this file about how work is classified, how
> branches and PRs work, or how production promotion works, **this file wins**.
> Fix the other document to match.
>
> The one exception is **routing facts** — repository owner, branch names,
> hosting, database schema, Linear team. Those live in
> [`.catalyst/app.yml`](.catalyst/app.yml), the machine-readable manifest, and
> this file must agree with it.

Fire Allowance Tracker (FAT) is a Next.js 15 + Supabase app. This document
defines **only** the repository, governance, and Git workflow. It does **not**
change the application, authentication, Supabase, migrations, calculations,
payroll, or OCR behaviour — those safeguards are summarised in §7 and must be
preserved.

---

## 1. Manifest and identity (`.catalyst/app.yml`)

Every Catalyst application carries a manifest at
[`.catalyst/app.yml`](.catalyst/app.yml) declaring `schema: catalyst/app@1`. It
is the machine-readable statement of what this app **is** and where its work
**goes**.

**Read the manifest before acting on identity or routing.** Do not infer any of
the following from folder names, history, or memory — take them from the
manifest:

| Question | Manifest field |
|----------|----------------|
| Which repository owns this app? | `repository.owner` / `repository.name` |
| Which branch is development? | `branches.dev` |
| Which branch is production? | `branches.production` |
| Which PostgreSQL schema does the app own? | `database.schema` |
| Which Linear team and app label route this work? | `linear.team` / `linear.app_label` |

For this repository those resolve to: owner `Catalyst-App-Dev`, dev branch
`dev`, production branch `main`, database schema **`fat`**, Linear team
**Applications** (`APP`) with app label **Fire Allowance Tracker**.

If the manifest and reality disagree, **stop and report it** — raise a Linear
Issue. Do not silently "fix" reality to match the manifest, and do not edit the
manifest to match a state you have not verified. Fields that cannot be
established from repository evidence are **omitted** from the manifest rather
than guessed; adding a guessed field is a governance defect.

---

## 2. Work classification and Issue ownership

### Every branch is owned by a Linear Issue

There is **no anonymous work**. Before any branch is cut, a Linear Issue must
exist in the team named by `linear.team`, carrying the `linear.app_label` for
this app. The Issue's identifier (e.g. `APP-11`) becomes part of the branch
name, so the branch, the PR, and the Issue are traceable to one another.

No Issue → no branch → no PR.

### Classify the work: Problem or Idea

Exactly **two** canonical primary work classifications exist. Every Issue
carries exactly one of them:

| Classification | Meaning |
|----------------|---------|
| **Problem** | Wrong / unexpected / unsafe / unclear behaviour, requiring investigation and root cause **before** a fix. |
| **Idea** | New / different / improved work. **Recording an Idea does not approve its execution.** |

A Problem is not "a small Idea in a hurry". If behaviour is wrong, find the root
cause before writing the fix. An Idea that has been recorded is not thereby
approved — approval to execute is separate.

Issues additionally carry **Scope** (`App-specific` | `Shared`) and **Purpose**
(`Codebase` | `Architecture` | `Governance` | `Automations` | `Services`) labels.
These decide *where an asset belongs*, which matters here: an App-specific
Architecture document belongs in **this** repository, not in a shared governance
repository.

### Keep Issues whole

If work you are doing turns out to contain an independently meaningful, separable
piece — a database cleanup, a change to a different repository, a migration that
stands on its own — **do not absorb it**. Report it as an out-of-scope discovery
and route it to its own Linear Issue. Scope creep that silently performs
cross-repository or database work under an unrelated Issue is a governance
failure, not helpfulness.

---

## 3. Canonical development workflow

`dev` is the **canonical development branch** (`branches.dev`). Production lives
on `main` (`branches.production`). Ordinary work is **never** committed directly
to `dev` or `main` — there is no direct-write path to either. Every task follows
the same loop:

1. **Classify and confirm the Issue** (§2). You need its identifier.

2. **Fetch current `origin/dev`.** Never assume a local ref is up to date.
   ```bash
   git fetch origin --prune
   ```

3. **Create an isolated worktree and the issue-owned task branch**, cut from
   current `origin/dev`. The branch name is
   **`task/<LINEAR-ID>-<short-description>`** — always the `task/` prefix,
   always the Linear identifier:
   ```bash
   git worktree add -b task/APP-11-onboard-fire-allowance-tracker \
     ../worktrees/APP-11 origin/dev
   ```
   An isolated worktree keeps concurrent Issues from colliding in one checkout
   and keeps the primary checkout clean. If a worktree is genuinely impractical,
   a plain branch cut from `origin/dev` with the same name is acceptable — the
   branch naming and the PR target are not negotiable, the worktree is the
   default.

   Before creating it, confirm the branch does not already exist
   (`git ls-remote --heads origin task/<LINEAR-ID>-<short-description>`). If it
   does, stop and report rather than reusing or force-updating it.

4. **Do the work in that worktree, on that branch.** Commit locally.

5. **Push the task branch:**
   ```bash
   git push -u origin task/<LINEAR-ID>-<short-description>
   ```

6. **Open a pull request with base `dev`** — never `main` for ordinary work, and
   never a direct push to `dev`.

7. **Verify required checks and the Vercel Preview deployment** for the PR before
   merging. A green Vercel Preview is the authoritative build signal.

8. **Squash merge is preferred** for task branch → `dev`.

### Retired branch prefixes

`feat/`, `fix/`, `docs/`, and `chore/` are **retired**. They produced branches
that no Issue owned. Do not create them. A branch already in flight under an old
prefix may finish its current PR, but new work uses
`task/<LINEAR-ID>-<short-description>`.

### Post-merge cleanup (order matters)

Do these in order. Do **not** delete the local branch or worktree before local
`dev` has been updated and the changes proven present.

1. **Confirm the PR was squash-merged into `dev`.**
2. **Confirm GitHub deleted the remote PR head branch.** Automatic deletion of
   merged PR head branches is the required workflow, but it is not guaranteed —
   verify it actually happened:
   ```bash
   git ls-remote --heads origin task/<LINEAR-ID>-<short-description>   # expect: no output
   ```
   If the remote branch still exists, **stop and report it**. Do not delete it
   manually — **never run `git push --delete`** — and do not change repository
   settings to force it.
3. **Fetch GitHub:**
   ```bash
   git fetch origin --prune
   ```
4. **Check out local `dev`** and **fast-forward it from `origin/dev`:**
   ```bash
   git checkout dev
   git pull --ff-only origin dev
   ```
5. **Prove the merged changes are present in updated `dev`** before deleting
   anything — e.g. confirm the squash commit is in `git log`:
   ```bash
   git log --oneline -5 dev
   git branch --merged dev | grep task/<LINEAR-ID>-   # may be empty after squash — see note
   ```
6. **Remove the worktree, then delete the local branch:**
   ```bash
   git worktree remove ../worktrees/<LINEAR-ID>
   git branch -d task/<LINEAR-ID>-<short-description>
   ```
   - Use `git branch -d` (safe delete) whenever Git accepts it.
   - Squash merging **rewrites the commit identity** — it collapses the branch's
     commits into a single new commit on `dev` with a different SHA — so
     `git branch -d` may **refuse** deletion even though the changes are safely
     present. Only then, and **only after independently proving** the changes are
     contained in updated `dev` (step 5), use `git branch -D <branch>`. Do **not**
     treat unconditional `git branch -D` as the normal path.

### Remote vs local branch cleanup

- **Remote** head branch: **GitHub** handles this. Automatic deletion of merged
  PR head branches is the required workflow, but not guaranteed — **verify**
  after every merge. If it still exists, stop and report rather than deleting it
  manually or assuming cleanup completed. Repository settings must not be changed
  without explicit approval.
- **Local** branch and worktree: **you** clean these up separately, after `dev`
  is updated and the changes are proven present.

These are separate actions. Confirming the remote branch is gone does **not**
remove the local branch or its worktree.

---

## 4. Production approval gate (`dev → main`)

Production is a **separate, explicitly approved** action, never part of ordinary
task flow.

- `main` **is** production. Vercel auto-deploys production on push to `main`.
- **Never** commit, push, or merge to `main` without **Danny's explicit approval
  in the current conversation.**
- **Stop immediately if the active branch is `main`** — do not edit files and do
  not run any write operation. Halt and ask.
- DEV work must be **completed and verified** on `dev` first.
- Ordinary work **must never** go directly into `main`. It always lands on `dev`
  first via the PR flow in §3.
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

## 5. Branch lifecycle summary

| Stage | Branch | Action |
|-------|--------|--------|
| Classify | — | Linear Issue exists, labelled **Problem** or **Idea**, plus Scope + Purpose |
| Start | `origin/dev` | `git fetch origin --prune`; confirm the task branch does not already exist |
| Cut | `task/<LINEAR-ID>-<desc>` | Create an **isolated worktree** + branch from `origin/dev` |
| Work | `task/<LINEAR-ID>-<desc>` | Commit locally in the worktree |
| Publish | `task/<LINEAR-ID>-<desc>` | Push; open PR with **base `dev`** |
| Verify | PR | Required checks + Vercel Preview green |
| Merge | `task/<LINEAR-ID>-<desc>` → `dev` | **Squash merge** (preferred) |
| Cleanup (remote) | — | GitHub deletes the remote head branch — **verify**; stop and report if not. Never `git push --delete` |
| Sync | `dev` | Fetch → checkout `dev` → `git pull --ff-only origin dev` → prove changes present |
| Cleanup (local) | — | **Then** `git worktree remove`, then `git branch -d` (`-D` only after proving changes are in `dev`) |
| Production | `dev` → `main` | **Separate, explicitly approved** promotion (merge commit) |

---

## 6. Git hooks

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

## 7. FAT-specific safeguards (do not change via workflow cleanup)

Repository-workflow and governance standardisation must **never** contradict or
alter any of the following application safeguards:

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
- FAT owns the **`fat`** schema (`database.schema` in the manifest), and it must
  remain **exposed** to PostgREST (see
  [`docs/FAT_SCHEMA_ARCHITECTURE.md`](docs/FAT_SCHEMA_ARCHITECTURE.md)).

When a task touches any of the above, consult the relevant FAT operational
document in [`docs/`](docs/) before proceeding.
