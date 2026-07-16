---
name: Branch and Deployment Rules
description: Workflow rules for the Fire Allowance Tracker repository
type: project
---

# Fire Allowance Tracker — Branch Rules

## Strict Rules

- **Never commit to main** — `main` is production-only and protected
- **Always use `dev` branch** — all development work goes here
- **Require confirmation before merging to main** — explicitly ask the user before opening or merging any PR targeting `main`
- **Always verify Vercel preview before merge** — the `dev` Vercel preview must be tested and confirmed working before `dev → main` is merged

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
