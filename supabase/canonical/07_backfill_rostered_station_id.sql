-- ─── 07 · Backfill fat.profiles.rostered_station_id ──────────────────────────
-- Populates the canonical rostered-station column the entitlement engine reads
-- (lib/fat/engine/context.js § buildEngineContext) from the prototype source of
-- truth the Profile UI has historically written (fat.profile_ext.station_id).
--
-- WHY: Until the Profile save workflow was updated (app/profile/page.js) no
-- production code wrote fat.profiles.rostered_station_id, so excess-travel
-- entitlement generation was silently suppressed for real users even though the
-- engine, bridge, rates, and matrix were all live. This one-time backfill brings
-- existing rows into sync; the UI change keeps new saves in sync going forward.
--
-- SAFETY / IDEMPOTENCY:
--   • Only fills or corrects rows where profile_ext.station_id is set AND the
--     current rostered_station_id diverges (is distinct from) it.
--   • Never NULLs an existing rostered_station_id when profile_ext.station_id is
--     null (conservative — preserves any value the engine already relies on).
--   • profile_ext is read-only here; no prototype field is modified.
--   • Re-runnable: a second run touches zero rows.
--
-- SCOPE: applied to DEV (project kctctvpobbizhkiqkgqw). NOT applied to PROD —
-- run as part of the canonical PROD rollout once the UI change ships.

update fat.profiles p
set    rostered_station_id = e.station_id
from   fat.profile_ext e
where  e.user_id = p.id
  and  e.station_id is not null
  and  p.rostered_station_id is distinct from e.station_id;

-- Validation (expect zero diverged rows after the update):
--   select count(*) from fat.profiles p
--   join fat.profile_ext e on e.user_id = p.id
--   where e.station_id is not null
--     and p.rostered_station_id is distinct from e.station_id;
