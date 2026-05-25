#!/usr/bin/env bash
# merge-to-main.sh — Fire Allowance Tracker
#
# Safe production release script.
# Replaces the manual four-command merge workflow with verified, abort-on-error promotion.
#
# Usage:
#   npm run release
#   bash scripts/merge-to-main.sh
#
# What it checks:
#   BEFORE MERGE
#     - No unfinished merge, rebase, or cherry-pick in progress
#     - Working tree is clean (no uncommitted changes)
#     - Current branch is dev (correct starting point)
#   AFTER CHECKOUT MAIN
#     - git branch --show-current confirms we are actually on main
#   AFTER MERGE
#     - HEAD SHA changed (merge produced a new commit)
#     - Detects and aborts on "Already up to date" with clear message
#   AFTER PUSH
#     - Fetches remote and compares local main SHA to origin/main SHA
#     - Fails if they diverge (push silently failed or was a no-op)
#     - Prints deployed commit SHA as confirmation
#   ALWAYS
#     - Returns to dev branch before exiting (success or failure)

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Helpers ───────────────────────────────────────────────────────────────────
step()  { echo -e "\n${CYAN}▶ $*${NC}"; }
ok()    { echo -e "  ${GREEN}✓ $*${NC}"; }
warn()  { echo -e "  ${YELLOW}⚠ $*${NC}"; }
fail()  { echo -e "\n  ${RED}✗ RELEASE ABORTED: $*${NC}\n"; exit 1; }

# ── Cleanup: always return to dev ─────────────────────────────────────────────
# Runs on EXIT (success or failure) as long as we got past the initial checks.
RETURN_TO_DEV=false
cleanup() {
  if [ "$RETURN_TO_DEV" = true ]; then
    CURRENT=$(git branch --show-current 2>/dev/null || echo "")
    if [ "$CURRENT" != "dev" ]; then
      echo ""
      warn "Returning to dev branch..."
      git checkout dev --quiet 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   Fire Allowance Tracker — Release       ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"

# ═══════════════════════════════════════════════════════════════════════════════
# PRE-FLIGHT CHECKS
# ═══════════════════════════════════════════════════════════════════════════════
step "Pre-flight checks..."

# 1. Must be inside a git repo
git rev-parse --git-dir > /dev/null 2>&1 || fail "Not inside a git repository."

# 2. No unfinished operations
if [ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ]; then
  fail "Unfinished merge in progress. Resolve or abort it first:\n       git merge --abort"
fi
if [ -f "$(git rev-parse --git-dir)/rebase-merge/interactive" ] || \
   [ -d "$(git rev-parse --git-dir)/rebase-merge" ] || \
   [ -d "$(git rev-parse --git-dir)/rebase-apply" ]; then
  fail "Unfinished rebase in progress. Resolve or abort it first:\n       git rebase --abort"
fi
if [ -f "$(git rev-parse --git-dir)/CHERRY_PICK_HEAD" ]; then
  fail "Unfinished cherry-pick in progress. Resolve or abort it first:\n       git cherry-pick --abort"
fi
ok "No unfinished git operations"

# 3. Working tree must be clean
if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "Working tree has uncommitted changes.\n       Commit or stash them before releasing:\n       git stash"
fi
ok "Working tree is clean"

# 4. Must be on dev branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "dev" ]; then
  fail "Must be on 'dev' branch to release. Currently on: '${CURRENT_BRANCH}'\n       Run: git checkout dev"
fi
ok "On dev branch"

# Enable cleanup trap now that pre-flight passed
RETURN_TO_DEV=true

# 5. Record dev HEAD SHA before merge (used to detect "already up to date")
DEV_SHA=$(git rev-parse HEAD)

# ═══════════════════════════════════════════════════════════════════════════════
# CHECKOUT MAIN
# ═══════════════════════════════════════════════════════════════════════════════
step "Switching to main..."

git checkout main --quiet
ACTUAL_BRANCH=$(git branch --show-current)
if [ "$ACTUAL_BRANCH" != "main" ]; then
  fail "git checkout main reported success but branch is '${ACTUAL_BRANCH}'.\n       Detached HEAD or ref corruption — investigate before retrying."
fi
ok "Now on main (confirmed)"

# Record main SHA before merge
MAIN_PRE_MERGE_SHA=$(git rev-parse HEAD)

# ═══════════════════════════════════════════════════════════════════════════════
# MERGE DEV → MAIN
# ═══════════════════════════════════════════════════════════════════════════════
step "Merging dev → main..."

# Run merge; if it fails (conflict), abort cleanly and return to dev
if ! git merge dev --no-edit 2>&1; then
  echo ""
  warn "Merge failed — likely a conflict. Aborting merge..."
  git merge --abort 2>/dev/null || true
  fail "Merge conflict detected.\n       Switch to dev, resolve conflicts manually, then re-run:\n       git checkout dev\n       git merge main   (integrate any changes from main into dev)\n       # resolve conflicts\n       npm run release"
fi

MAIN_POST_MERGE_SHA=$(git rev-parse HEAD)

# Detect "Already up to date" — SHA unchanged means nothing was merged
if [ "$MAIN_POST_MERGE_SHA" = "$MAIN_PRE_MERGE_SHA" ]; then
  warn "Already up to date — dev contains no new commits since last release."
  warn "Nothing to push. Release skipped."
  echo ""
  echo -e "  ${YELLOW}If this is unexpected, check: git log main..dev${NC}"
  echo ""
  exit 0
fi

ok "Merge produced new commit"
echo -e "  Pre-merge  main:  ${MAIN_PRE_MERGE_SHA:0:8}"
echo -e "  Post-merge main:  ${MAIN_POST_MERGE_SHA:0:8}"

# ═══════════════════════════════════════════════════════════════════════════════
# PUSH MAIN → REMOTE
# ═══════════════════════════════════════════════════════════════════════════════
step "Pushing main to origin..."

git push origin main

# Fetch remote state to verify push landed
step "Verifying push reached remote..."
git fetch origin main --quiet

LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse origin/main)

if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  fail "Remote SHA mismatch after push!\n       Local  main: ${LOCAL_SHA:0:8}\n       Remote main: ${REMOTE_SHA:0:8}\n       The push may have failed silently. Check your network and remote state."
fi

ok "Remote SHA verified — push confirmed"

# ═══════════════════════════════════════════════════════════════════════════════
# SUCCESS
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║   ✓  RELEASE SUCCESSFUL                  ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Deployed commit: ${BOLD}${LOCAL_SHA:0:8}${NC}"
echo -e "  Vercel will auto-deploy from main shortly."
echo -e "  To monitor: https://vercel.com/dashboard"
echo ""

# cleanup() trap will return to dev on EXIT
