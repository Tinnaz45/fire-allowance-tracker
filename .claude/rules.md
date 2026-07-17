---
name: Branch and Deployment Rules
description: Workflow rules for the Fire Allowance Tracker repository
type: project
---

# Fire Allowance Tracker — Branch Rules

> **Authority:** the root [`CLAUDE.md`](../CLAUDE.md) is the source of truth for
> the repository workflow. These rules restate its guardrails for agent use; if
> they ever diverge, `CLAUDE.md` wins.

## Strict Rules

- **`dev` is the default development branch** — production lives on `main`.
- **Ordinary work uses a temporary branch** (`feat/…`, `fix/…`, `docs/…`,
  `chore/…`, `task/…`) cut from current `origin/dev`. Do **not** commit ordinary
  work directly to `dev` or `main`.
- **Merge via a pull request into `dev`** — squash merge preferred.
- **Post-merge cleanup, in this order** (see [`CLAUDE.md`](../CLAUDE.md) §1):
  confirm the PR squash-merged → **verify** GitHub deleted the remote source
  branch (required workflow, not guaranteed; if it still exists, **stop and
  report** — don't delete it manually or change repo settings) → `git fetch` →
  checkout `dev` → `git pull --ff-only origin dev` → **prove** the merged changes
  are in `dev` → **then** delete the local branch with `git branch -d`. Because
  squash merge rewrites the commit identity, `git branch -d` may refuse; fall back
  to `git branch -D` **only after** independently proving the changes are in
  `dev`. GitHub handles the remote branch; you handle the local branch separately.
- **Never commit, push, or merge to `main` without approval** — `main` is
  production. Explicitly ask Danny in the current conversation before anything
  targets `main`. Production is a separate, approved `dev → main` promotion.
- **Always verify Vercel Preview before merge** — the PR's Vercel Preview must be
  tested and confirmed working before merge.

## Active Branch Safety

Before editing any file or running any write operation (commit, push, merge, reset, rebase):

- **Check the active branch first** — verify the current branch before any edit or write; `dev` is the default development branch for all work.
- **Stop immediately if the active branch is `main`** — do not edit files or run any write operation; halt and ask Danny to switch to `dev`.
- **Never modify `main` without approval** — do not commit, push, merge, reset, rebase, or otherwise modify `main` without Danny's explicit approval in the current conversation.

## Branch Structure

| Branch | Role |
|---|---|
| `dev` | Active development, Vercel preview |
| `main` | Stable production, Vercel production deployment |

## Merge Checklist

Before any `dev → main` merge:
- [ ] Build passes (`npm run build`)
- [ ] Vercel preview URL tested
- [ ] No console errors on key flows
- [ ] User has explicitly confirmed merge is approved
