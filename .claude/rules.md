---
name: Branch and Deployment Rules
description: Governance and workflow rules for the Fire Allowance Tracker repository
type: project
---

# Fire Allowance Tracker — Agent Rules

> **Authority:** the root [`CLAUDE.md`](../CLAUDE.md) is the source of truth for
> the repository workflow, and [`.catalyst/app.yml`](../.catalyst/app.yml) is the
> source of truth for identity and routing. These rules restate their guardrails
> for agent use; if they ever diverge, `CLAUDE.md` and the manifest win.

## Read the manifest first

[`.catalyst/app.yml`](../.catalyst/app.yml) (`schema: catalyst/app@1`) declares
this app's identity and routing. Take these from the manifest, never from memory
or folder names:

- `repository.owner` / `repository.name` — **`Catalyst-App-Dev/fire-allowance-tracker`**
- `branches.dev` / `branches.production` — **`dev`** / **`main`**
- `database.schema` — **`fat`**
- `linear.team` / `linear.app_label` — **Applications** / **Fire Allowance Tracker**

If the manifest and reality disagree, **stop and report it** — raise a Linear
Issue. Do not edit the manifest to match an unverified state, and do not add a
field you cannot establish from repository evidence.

## Strict Rules

- **Every branch is owned by a Linear Issue.** No Issue → no branch → no PR. The
  Issue lives in the `Applications` team and carries the `Fire Allowance Tracker`
  app label.
- **Classify the work first — Problem or Idea.** These are the only two canonical
  primary classifications. A **Problem** is wrong/unexpected/unsafe/unclear
  behaviour needing root cause **before** a fix; an **Idea** is new/different/
  improved work, and **recording an Idea does not approve executing it.** Issues
  also carry Scope (`App-specific` | `Shared`) and Purpose (`Codebase` |
  `Architecture` | `Governance` | `Automations` | `Services`).
- **Work happens on an issue-owned task branch in an isolated worktree.** The
  branch name is **`task/<LINEAR-ID>-<short-description>`** cut from current
  `origin/dev`:
  ```bash
  git fetch origin --prune
  git worktree add -b task/APP-11-onboard-fire-allowance-tracker \
    ../worktrees/APP-11 origin/dev
  ```
  Confirm the branch does not already exist before creating it; if it does, stop
  and report rather than reusing or force-updating it.
- **`feat/`, `fix/`, `docs/` and `chore/` prefixes are retired.** Do not create
  them. New work always uses `task/<LINEAR-ID>-<short-description>`.
- **There is no direct-write path to `dev`.** Ordinary work is never committed or
  pushed straight to `dev` (or `main`) — it merges via a **pull request with base
  `dev`**, squash merge preferred.
- **Post-merge cleanup, in this order** (see [`CLAUDE.md`](../CLAUDE.md) §3):
  confirm the PR squash-merged → **verify** GitHub deleted the remote head branch
  (required workflow, not guaranteed; if it still exists, **stop and report** —
  **never run `git push --delete`** and don't change repo settings) →
  `git fetch origin --prune` → checkout `dev` → `git pull --ff-only origin dev` →
  **prove** the merged changes are in `dev` → **then** `git worktree remove` and
  `git branch -d`. Because squash merge rewrites the commit identity,
  `git branch -d` may refuse; fall back to `git branch -D` **only after**
  independently proving the changes are in `dev`. GitHub handles the remote
  branch; you handle the local branch and worktree separately.
- **Never commit, push, or merge to `main` without approval** — `main` is
  production. Explicitly ask Danny in the current conversation before anything
  targets `main`. Production is a separate, approved `dev → main` promotion.
- **Always verify Vercel Preview before merge** — the PR's Vercel Preview must be
  tested and confirmed working before merge.
- **Keep Issues whole.** If you discover independently meaningful work — a
  database cleanup, a change in another repository, a standalone migration — do
  **not** absorb it into the current Issue. Report it as an out-of-scope discovery
  and route it to its own Linear Issue.

## Active Branch Safety

Before editing any file or running any write operation (commit, push, merge, reset, rebase):

- **Check the active branch first** — verify you are on the Issue's
  `task/<LINEAR-ID>-<short-description>` branch, not on `dev` or `main`.
- **Stop immediately if the active branch is `main`** — do not edit files and do
  not run any write operation; halt and ask Danny.
- **Stop if the active branch is `dev`** — ordinary work does not belong there.
  Cut the issue-owned task branch first.
- **Never modify `main` without approval** — do not commit, push, merge, reset,
  rebase, or otherwise modify `main` without Danny's explicit approval in the
  current conversation.

## Branch Structure

| Branch | Role |
|---|---|
| `task/<LINEAR-ID>-<desc>` | Issue-owned task branch in an isolated worktree — the only place ordinary work happens |
| `dev` | Integration branch — reached **only** by PR merge; Vercel preview |
| `main` | Production — Vercel production deployment; explicitly approved promotion only |

## Merge Checklist

Before any `dev → main` merge:
- [ ] Build passes (`npm run build`)
- [ ] Vercel preview URL tested
- [ ] No console errors on key flows
- [ ] User has explicitly confirmed merge is approved
