# Development Workflow

> **Authority:** the root [`CLAUDE.md`](../CLAUDE.md) is the source of truth for
> the repository workflow, and [`.catalyst/app.yml`](../.catalyst/app.yml) is the
> source of truth for identity and routing. This document covers day-to-day
> build/test and Supabase rules; where it touches branching it defers to
> `CLAUDE.md`.

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Production — Vercel auto-deploys on push. **Approved `dev → main` promotion only.** |
| `dev`  | Integration branch — reached **only** by PR merge. |
| `task/<LINEAR-ID>-<desc>` | Issue-owned task branch, worked in an isolated worktree. |

Ordinary work is **not** committed or pushed directly to `dev` or `main` — there
is no direct-write path to either. It happens on an issue-owned task branch and
merges into `dev` via a pull request. The `feat/`, `fix/`, `docs/` and `chore/`
prefixes are **retired**.

---

## Making changes

1. Confirm the Linear Issue that owns this work exists and is classified as a
   **Problem** or an **Idea** (see [`CLAUDE.md`](../CLAUDE.md) §2) — you need its
   identifier for the branch name.
2. Start from current `origin/dev` and cut the issue-owned task branch in an
   isolated worktree:
   ```bash
   git fetch origin --prune
   git ls-remote --heads origin task/<LINEAR-ID>-<short-description>  # expect: no output
   git worktree add -b task/<LINEAR-ID>-<short-description> \
     ../worktrees/<LINEAR-ID> origin/dev
   ```
3. Make your changes in that worktree, on that branch.
4. Run the build to confirm nothing is broken:
   ```bash
   npm run build
   ```
5. Fix any errors before continuing.
6. If tests exist, run them:
   ```bash
   npm test -- --watchAll=false
   ```
7. Fix any test failures before continuing.
8. Push the branch and open a pull request with **base `dev`**:
   ```bash
   git push -u origin task/<LINEAR-ID>-<short-description>
   ```
9. Verify required checks and the Vercel Preview on the PR, then **squash merge**
   into `dev`.
10. **Clean up, in this order** (do not delete the local branch or worktree first):
    ```bash
    # a. Confirm the PR squash-merged into dev, then verify GitHub deleted the
    #    remote head branch. Automatic deletion is the required workflow but is
    #    not guaranteed — if the branch still exists, STOP and report it. Never
    #    run `git push --delete`, and do not change repo settings.
    git ls-remote --heads origin task/<LINEAR-ID>-<short-description>   # expect: no output

    # b. Fetch, check out dev, and fast-forward from origin/dev.
    git fetch origin --prune
    git checkout dev
    git pull --ff-only origin dev

    # c. Prove the merged changes are present in updated dev before deleting.
    git log --oneline -5 dev

    # d. Remove the worktree, then delete the local branch. Squash merge rewrites
    #    the commit identity, so `git branch -d` may refuse even though the
    #    changes are present — only then, and only after step (c) proves
    #    containment, use -D.
    git worktree remove ../worktrees/<LINEAR-ID>
    git branch -d task/<LINEAR-ID>-<short-description>
    # git branch -D task/<LINEAR-ID>-<short-description>   # ONLY if -d refuses AND changes proven in dev
    ```

See [`CLAUDE.md`](../CLAUDE.md) §3 for the full lifecycle, including remote-vs-local
branch cleanup and the squash-merge safety note.

---

## Promoting to production (`dev → main`)

Production is a **separate, explicitly approved** action — never part of ordinary
task flow and never a local direct push presented as the norm.

- DEV work must be completed and verified on `dev` first.
- Promotion is done as an **explicitly approved GitHub action** (`dev → main`),
  with Danny's explicit approval in the current conversation. A merge commit may
  be used; rebase merging is disabled.
- FAT-specific promotion steps — PROD database backup/migration order, Supabase
  schema exposure, validation queries, smoke tests, and rollback — are in
  [`PROD_ROLLOUT_CHECKLIST.md`](PROD_ROLLOUT_CHECKLIST.md).

See [`CLAUDE.md`](../CLAUDE.md) §2 for the production approval gate.

---

## If something breaks

Do **not** promote to `main`. Fix forward on a temporary branch, or revert the
offending change on `dev` via a new PR. To discard uncommitted local work on your
temporary branch:

```bash
# Undo last local commit (keeps changes as unstaged)
git reset HEAD~1

# Or discard unstaged working-tree changes
git checkout -- .
```

---

## Environment variables

- Copy `.env.example` → `.env.local`
- Fill in your Supabase credentials
- Never commit `.env.local`

---

## Supabase rules

- Do NOT modify existing tables
- Do NOT rename columns or tables
- Schema changes must be reviewed before applying
- DEV and PROD Supabase are **separate projects**; PROD migration restrictions and
  ordered canonical migrations apply
- The `fat` schema must remain exposed to PostgREST
- Auth must always be re-tested after any auth-adjacent change
