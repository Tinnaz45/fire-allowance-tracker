-- ███████████████████████████████████████████████████████████████████████████████
-- ██                                                                           ██
-- ██  ⚠️  SUPERSEDED — HISTORICAL ONLY — DO NOT REPLAY  ⚠️                     ██
-- ██                                                                           ██
-- ██  This file is OBSOLETE. It is retained for rollout/audit history only.    ██
-- ██                                                                           ██
-- ██  CANONICAL ARCHITECTURE:                                                  ██
-- ██    • fat.* bounded-domain schema is canonical.                            ██
-- ██    • supabase/fat-schema.sql is the AUTHORITATIVE schema definition.      ██
-- ██    • The legacy public.fat_* flat layout below is OBSOLETE.               ██
-- ██                                                                           ██
-- ██  REPLAY RISK:                                                             ██
-- ██    Replaying this file may FAIL because public.fat_set_updated_at()       ██
-- ██    no longer exists. Triggers reference a function that has been removed  ██
-- ██    as part of the fat.* bounded-domain migration.                         ██
-- ██                                                                           ██
-- ██  DO NOT execute this file against any environment (dev, staging, prod).   ██
-- ██  For schema changes, modify supabase/fat-schema.sql instead.              ██
-- ██                                                                           ██
-- ███████████████████████████████████████████████████████████████████████████████

-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — MIGRATION v4: DISTANCE ESTIMATION & CACHING TABLES
-- File: supabase-migration-v4-distance-tables.sql
--
-- PURPOSE:
--   Create the two tables required by the Distance Estimation + Caching System:
--     1. fat_home_address       — geocoded home coordinates + version tracking
--     2. fat_station_distances  — per-user, per-station cached driving distances
--
-- These tables replace fat_distance_cache (v2) with a richer schema that supports:
--   - Address change detection via hash + version
--   - Staleness tracking (is_stale, stale_reason)
--   - Separate estimated vs. confirmed distances
--   - Station geocode coordinate caching (avoids re-geocoding same station)
--   - Confirmation source tracking ('auto' accepted vs 'manual' override)
--
-- SAFETY GUARANTEES:
--   • ADDITIVE ONLY — fat_distance_cache (v2) is NOT dropped or modified
--   • All CREATE TABLE statements use IF NOT EXISTS — safe to rerun
--   • All CREATE POLICY blocks use DO $$ IF NOT EXISTS guards
--   • All CREATE TRIGGER blocks use DO $$ IF NOT EXISTS guards
--   • fat_set_updated_at() from v2 is already present — no re-creation needed
--
-- BRANCH: dev only — DO NOT merge to main without user testing sign-off
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. fat_home_address
--
-- Stores the geocoded lat/lng for a user's home address.
-- One row per user (user_id is the primary key).
-- address_hash: normalised address string used as change-detection fingerprint.
-- address_version: incremented each time the address hash changes. Used by
--   fat_station_distances to detect staleness without re-geocoding.
-- geocode_status: 'ok' | 'failed' | 'pending'
--   - 'ok'      = geocoded successfully; lat/lng are valid
--   - 'failed'  = geocoding failed; lat/lng are null; don't retry until address changes
--   - 'pending' = row created but geocoding not yet attempted
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.fat_home_address (
  user_id          uuid primary key references auth.users on delete cascade,
  address_text     text not null,
  address_hash     text not null,
  lat              numeric(10, 6) default null,
  lng              numeric(10, 6) default null,
  geocoded_at      timestamptz    default null,
  geocode_status   text not null  default 'pending'
                     check (geocode_status in ('ok', 'failed', 'pending')),
  address_version  integer not null default 1,
  updated_at       timestamptz    default now()
);

alter table public.fat_home_address enable row level security;

-- RLS: users can only read and manage their own home address record
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'fat_home_address'
      and policyname = 'fat: users manage own home address'
  ) then
    create policy "fat: users manage own home address"
      on public.fat_home_address
      for all
      using (auth.uid() = user_id);
  end if;
end $$;

-- updated_at trigger using FAT-owned function (fat_set_updated_at from v2)
do $$ begin
  if not exists (
    select 1 from pg_trigger
    where tgname  = 'fat_set_home_address_updated_at'
      and tgrelid = 'public.fat_home_address'::regclass
  ) then
    create trigger fat_set_home_address_updated_at
      before update on public.fat_home_address
      for each row execute procedure public.fat_set_updated_at();
  end if;
end $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. fat_station_distances
--
-- Per-user, per-station cache of home-to-station driving distances.
-- One row per (user_id, station_id) pair — unique constraint enforces this.
-- station_id is an unconstrained integer (no FK to fat_stations) to allow
-- caching distances to stations not yet in the fat_stations seed list.
--
-- Key columns:
--   home_address_hash     - fingerprint of the home address used for this calculation
--   home_address_version  - matches fat_home_address.address_version at calculation time
--   estimated_distance_km - raw output from Nominatim + OSRM routing
--   confirmed_distance_km - value the user explicitly accepted or manually entered
--   confirmation_source   - 'auto' (estimate accepted) | 'manual' (user override)
--   confirmed_at          - when the user confirmed this distance
--   station_lat/lng       - cached station geocode coords (avoids re-geocoding)
--   is_stale              - set true by markAllDistancesStale() when home address changes
--   stale_reason          - human-readable reason code (e.g. 'home_address_changed')
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.fat_station_distances (
  id                    uuid    default gen_random_uuid() primary key,
  user_id               uuid    references auth.users on delete cascade not null,
  station_id            integer not null,

  -- Home address fingerprint at time of calculation
  home_address_hash     text    default null,
  home_address_version  integer default null,

  -- Distance values
  estimated_distance_km numeric(6, 1) default null,
  confirmed_distance_km numeric(6, 1) default null,
  confirmation_source   text   default null
                          check (confirmation_source in ('auto', 'manual')),
  confirmed_at          timestamptz default null,

  -- Station geocode cache (avoids Nominatim re-calls for same station)
  station_lat           numeric(10, 6) default null,
  station_lng           numeric(10, 6) default null,
  station_geocoded_at   timestamptz    default null,

  -- Staleness tracking
  is_stale              boolean not null default false,
  stale_reason          text    default null,

  -- Audit
  updated_at            timestamptz default now(),

  -- One cache row per user + station pair
  unique (user_id, station_id)
);

alter table public.fat_station_distances enable row level security;

-- RLS: users can only read and manage their own station distance records
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'fat_station_distances'
      and policyname = 'fat: users manage own station distances'
  ) then
    create policy "fat: users manage own station distances"
      on public.fat_station_distances
      for all
      using (auth.uid() = user_id);
  end if;
end $$;

-- updated_at trigger using FAT-owned function
do $$ begin
  if not exists (
    select 1 from pg_trigger
    where tgname  = 'fat_set_station_distances_updated_at'
      and tgrelid = 'public.fat_station_distances'::regclass
  ) then
    create trigger fat_set_station_distances_updated_at
      before update on public.fat_station_distances
      for each row execute procedure public.fat_set_updated_at();
  end if;
end $$;

-- Indexes for common query patterns
-- Lookup by user + station (most frequent: cache check on claim form load)
create index if not exists idx_fat_station_distances_user_station
  on public.fat_station_distances(user_id, station_id);

-- Staleness sweep (mark-stale queries all distances for a user)
create index if not exists idx_fat_station_distances_user_stale
  on public.fat_station_distances(user_id, is_stale);


-- ─────────────────────────────────────────────────────────────────────────────
-- POST-MIGRATION VALIDATION CHECKLIST
-- Run these queries in the Supabase SQL editor after applying:
--
-- 1. Both tables exist:
--    SELECT tablename FROM pg_tables
--    WHERE schemaname = 'public'
--    AND tablename IN ('fat_home_address', 'fat_station_distances')
--    ORDER BY tablename;
--    -- Expected: 2 rows
--
-- 2. RLS is enabled on both tables:
--    SELECT tablename, rowsecurity FROM pg_tables
--    WHERE schemaname = 'public'
--    AND tablename IN ('fat_home_address', 'fat_station_distances');
--    -- Expected: rowsecurity = true for both
--
-- 3. Policies exist:
--    SELECT tablename, policyname FROM pg_policies
--    WHERE schemaname = 'public'
--    AND tablename IN ('fat_home_address', 'fat_station_distances')
--    ORDER BY tablename;
--    -- Expected: 1 policy per table
--
-- 4. Triggers exist:
--    SELECT tgname, tgrelid::regclass FROM pg_trigger
--    WHERE tgname IN (
--      'fat_set_home_address_updated_at',
--      'fat_set_station_distances_updated_at'
--    );
--    -- Expected: 2 rows
--
-- 5. Unique constraint on fat_station_distances:
--    SELECT indexname FROM pg_indexes
--    WHERE schemaname = 'public' AND tablename = 'fat_station_distances'
--    ORDER BY indexname;
--    -- Expected: primary key + unique constraint + 2 named indexes
--
-- 6. fat_home_address schema check:
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'fat_home_address'
--    ORDER BY ordinal_position;
--    -- Expected: user_id, address_text, address_hash, lat, lng,
--    --           geocoded_at, geocode_status, address_version, updated_at
--
-- 7. fat_station_distances schema check:
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'fat_station_distances'
--    ORDER BY ordinal_position;
--    -- Expected: id, user_id, station_id, home_address_hash, home_address_version,
--    --           estimated_distance_km, confirmed_distance_km, confirmation_source,
--    --           confirmed_at, station_lat, station_lng, station_geocoded_at,
--    --           is_stale, stale_reason, updated_at
-- ─────────────────────────────────────────────────────────────────────────────
