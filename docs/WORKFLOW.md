# Development Workflow

> **Authority:** the root [`CLAUDE.md`](../CLAUDE.md) is the source of truth for
> the repository workflow. This document covers day-to-day build/test and
> Supabase rules; where it touches branching it defers to `CLAUDE.md`.

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Production — Vercel auto-deploys on push. **Approved `dev → main` promotion only.** |
| `dev`  | Default development branch — features land here first, via PRs. |
| `<type>/<desc>` | Temporary task branch (`feat/`, `fix/`, `docs/`, `chore/`, `task/`). |

Ordinary work is **not** committed directly to `dev` or `main`. It happens on a
temporary branch and merges into `dev` via a pull request.

---

## Making changes

1. Start from current `origin/dev` and cut a temporary branch:
   ```bash
   git fetch origin
   git checkout -b <type>/<short-description> origin/dev
   ```
2. Make your changes on that branch.
3. Run the build to confirm nothing is broken:
   ```bash
   npm run build
   ```
4. Fix any errors before continuing.
5. If tests exist, run them:
   ```bash
   npm test -- --watchAll=false
   ```
6. Fix any test failures before continuing.
7. Push the branch and open a pull request **into `dev`**:
   ```bash
   git push -u origin <type>/<short-description>
   ```
8. Verify required checks and the Vercel Preview on the PR, then **squash merge**
   into `dev`.
9. GitHub deletes the remote branch automatically; delete your local branch
   yourself and sync `dev`:
   ```bash
   git checkout dev
   git branch -d <type>/<short-description>
   git pull --ff-only origin dev
   ```

See [`CLAUDE.md`](../CLAUDE.md) §1 for the full lifecycle, including remote-vs-local
branch cleanup.

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
