@echo off
cd /d "%~dp0"
echo.
echo === FAT Distance Cache Fix — Git Push ===
echo.
echo Committing addressCache.js fix and pushing to dev branch...
echo.

git add lib/distance/addressCache.js
git commit -m "fix(distance): clear confirmed_distance_km on every recalculate

saveDistanceEstimate() now explicitly sets confirmed_distance_km,
confirmation_source, and confirmed_at to null in every upsert row.

Without this, PostgreSQL ON CONFLICT DO UPDATE only updates columns
present in the SET clause — a prior confirmed_distance_km would silently
persist through a recalculate, bypassing the re-confirmation step on
next component mount.

Matches comment in file: user must re-confirm after every recalculate."

git push origin dev

echo.
echo Done. Check Vercel for the new deployment:
echo https://vercel.com/tinnaz45s-projects/fire-allowance-tracker
echo.
echo DEV branch alias:
echo https://fire-allowance-tracker-git-dev-tinnaz45s-projects.vercel.app
echo.
pause
