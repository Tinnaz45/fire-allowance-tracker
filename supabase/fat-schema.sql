-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — fat SCHEMA (authoritative reference)
--
-- This file is the canonical reference for the FAT-owned database surface.
-- It can be replayed against an empty Supabase project to bring up FAT from
-- scratch. The same DDL is applied to live projects via the Supabase MCP
-- migration `fat_schema_migration` (and the consolidated state has been moved
-- here for human review and onboarding).
--
-- See docs/FAT_SCHEMA_ARCHITECTURE.md for the schema-ownership map and
-- design rationale.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── Schema and grants ────────────────────────────────────────────────────────

create schema if not exists fat;

grant usage on schema fat to anon, authenticated, service_role;
alter default privileges in schema fat grant all     on tables    to anon, authenticated, service_role;
alter default privileges in schema fat grant all     on sequences to anon, authenticated, service_role;
alter default privileges in schema fat grant execute on functions to anon, authenticated, service_role;


-- ─── Trigger function: keeps updated_at fresh on UPDATE ───────────────────────

create or replace function fat.set_updated_at()
returns trigger
language plpgsql
set search_path = fat, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ─── Per-user FY workspaces ───────────────────────────────────────────────────

create table if not exists fat.financial_years (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  label       text not null,
  start_date  date not null,
  end_date    date not null,
  is_active   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (user_id, label)
);


-- ─── Atomic per-FY claim sequence numbering ───────────────────────────────────

create table if not exists fat.claim_sequences (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  financial_year_id  uuid not null references fat.financial_years(id) on delete cascade,
  claim_type         text not null,
  next_seq           integer not null default 1,
  unique (user_id, financial_year_id, claim_type)
);

create or replace function fat.increment_claim_sequence(
  p_user_id           uuid,
  p_financial_year_id uuid,
  p_claim_type        text
) returns integer
language plpgsql
security definer
set search_path = fat, pg_temp
as $$
declare
  v_seq integer;
begin
  insert into fat.claim_sequences (user_id, financial_year_id, claim_type, next_seq)
  values (p_user_id, p_financial_year_id, p_claim_type, 2)
  on conflict (user_id, financial_year_id, claim_type)
  do update set next_seq = fat.claim_sequences.next_seq + 1
  returning next_seq - 1 into v_seq;

  if v_seq is null then
    v_seq := 1;
  end if;
  return v_seq;
end;
$$;

revoke all on function fat.increment_claim_sequence(uuid, uuid, text) from public, anon;
grant  execute on function fat.increment_claim_sequence(uuid, uuid, text) to authenticated, service_role;


-- ─── Parent claim group rows (one per user-initiated claim) ───────────────────

create table if not exists fat.claim_groups (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  financial_year_id  uuid not null references fat.financial_years(id) on delete cascade,
  label              text not null,
  claim_type         text not null,
  claim_number       integer not null,
  incident_date      date,
  incident_number    text,
  parent_status      text not null default 'Pending'
                       check (parent_status in ('Pending','Paid','Disputed')),
  overdue_at         timestamptz,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);


-- ─── Stations reference data (shared, read-only for users) ────────────────────

create table if not exists fat.stations (
  id            integer primary key,
  name          text not null,
  abbreviation  text,
  region        text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);


-- ─── Authoritative FAT identity profile (mirrors mica.profiles pattern) ──────
-- fat.profiles owns FAT's identity surface (first/last name + email). Each
-- row is auto-seeded by the on_auth_user_created_fat trigger below, so a FAT
-- profile exists for every authenticated user without any client-side bootstrap.
-- public.profiles is transitional cross-app debt and is NOT read by FAT runtime.

create table if not exists fat.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  first_name  text not null default '',
  last_name   text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);


-- ─── FAT-specific profile extension (per-user, operational data) ──────────────

create table if not exists fat.profile_ext (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  station_id             integer references fat.stations(id) on delete set null,
  rostered_station_label text,
  platoon                text check (platoon in ('A','B','C','D','Z')),
  pay_number             text,
  home_address           text,
  home_dist_km           numeric(6,1) default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);


-- ─── Distance estimation (v1 cache + v4 home/station distance) ────────────────

create table if not exists fat.distance_cache (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  home_address      text not null,
  station_id        integer not null,
  distance_km       numeric(6,1) not null,
  source            text,
  user_override_km  numeric(6,1),
  calculated_at     timestamptz not null default now(),
  unique (user_id, home_address, station_id)
);

create table if not exists fat.home_address (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null unique references auth.users(id) on delete cascade,
  address_text       text not null,
  address_hash       text,
  lat                numeric(9,6),
  lng                numeric(9,6),
  geocoded_at        timestamptz,
  geocode_status     text,
  address_version    integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists fat.station_distances (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  station_id               integer not null,
  home_address_hash        text,
  home_address_version     integer,
  estimated_distance_km    numeric(6,1),
  confirmed_distance_km    numeric(6,1),
  confirmation_source      text,
  confirmed_at             timestamptz,
  station_lat              numeric(9,6),
  station_lng              numeric(9,6),
  station_geocoded_at      timestamptz,
  is_stale                 boolean not null default false,
  stale_reason             text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (user_id, station_id)
);

create index if not exists idx_station_distances_user_stale
  on fat.station_distances (user_id, is_stale);
create index if not exists idx_station_distances_user_station
  on fat.station_distances (user_id, station_id);


-- ─── Claim tables (Recall / Retain / Standby / Spoilt+Delayed meals) ──────────
-- Each holds both parent and auto-generated child component rows. The
-- meal_type column on fat.spoilt_meals discriminates Spoilt vs Delayed; the
-- app surfaces them as two virtual claim types but stores them in one table.

create table if not exists fat.recalls (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  date                date not null,
  rostered_stn_id     integer,
  recall_stn_id       integer,
  rostered_stn_label  text,
  recall_stn_label    text,
  platoon             text,
  shift               text check (shift in ('Day','Night')),
  arrived             text,
  dist_home_km        numeric(6,1) default 0,
  dist_stn_km         numeric(6,1) default 0,
  total_km            numeric(6,1) generated always as (dist_home_km + dist_stn_km) stored,
  travel_amount       numeric(8,2),
  mealie_amount       numeric(8,2),
  total_amount        numeric(8,2),
  adjusted_amount     numeric(8,2),
  notes               text,
  pay_number          text,
  payslip_pay_nbr     text,
  status              text default 'Pending' check (status in ('Pending','Paid','Disputed')),
  payment_status      text check (payment_status in ('Pending','Paid')),
  payment_date        timestamptz,
  attachment_url      text,
  ocr_source          jsonb,
  rates_snapshot      jsonb,
  calc_snapshot       jsonb,
  calculation_inputs  jsonb,
  home_address_snap   text,
  incident_number     text,
  claim_number        integer,
  financial_year_id   uuid references fat.financial_years(id) on delete set null,
  claim_group_id      uuid references fat.claim_groups(id)    on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists fat.retain (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  date               date not null,
  station_id         integer,
  platoon            text,
  shift              text check (shift in ('Day','Night')),
  booked_off_time    text,
  rmss_number        text,
  is_firecall        boolean default false,
  overnight_cash     numeric(8,2) default 0,
  -- Hours-first retain (FRV rule). generated_hours is derived from shift +
  -- booked_off_time by calcRetainHours(). The Maint Stn N/N dollar entitlement
  -- (retain_amount) is derived = generated_hours × retain_rate_used, where
  -- retain_rate_used is the CANONICAL FRV overtime hourly rate snapshot
  -- (RETAIN_OVERTIME_HOURLY_RATE in defaultRates.js — a fixed award rate, NOT
  -- user-editable). The snapshot is stored so historical claims reproduce
  -- exactly even if the award rate changes later.
  generated_hours    numeric(6,2),
  retain_rate_used   numeric(8,2),
  retain_amount      numeric(8,2),
  total_amount       numeric(8,2),
  adjusted_amount    numeric(8,2),
  pay_number         text,
  payslip_pay_nbr    text,
  status             text default 'Pending' check (status in ('Pending','Paid','Disputed')),
  payment_status     text check (payment_status in ('Pending','Paid')),
  payment_date       timestamptz,
  rates_snapshot     jsonb,
  calc_snapshot      jsonb,
  calculation_inputs jsonb,
  claim_number       integer,
  financial_year_id  uuid references fat.financial_years(id) on delete set null,
  claim_group_id     uuid references fat.claim_groups(id)    on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Backfill new retain columns on existing deployments (idempotent).
alter table fat.retain add column if not exists generated_hours  numeric(6,2);
alter table fat.retain add column if not exists retain_rate_used numeric(8,2);

create table if not exists fat.standby (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  date               date not null,
  standby_type       text check (standby_type in ('Standby','M&D')),
  rostered_stn_id    integer,
  standby_stn_id     integer,
  shift              text check (shift in ('Day','Night')),
  arrived            text,
  arrived_time       text,
  dist_km            numeric(6,1) default 0,
  travel_amount      numeric(8,2) default 0,
  night_mealie       numeric(8,2) default 0,
  total_amount       numeric(8,2),
  adjusted_amount    numeric(8,2),
  notes              text,
  free_from_home     boolean default false,
  pay_number         text,
  payslip_pay_nbr    text,
  status             text default 'Pending' check (status in ('Pending','Paid','Disputed')),
  payment_status     text check (payment_status in ('Pending','Paid')),
  payment_date       timestamptz,
  rates_snapshot     jsonb,
  calc_snapshot      jsonb,
  calculation_inputs jsonb,
  claim_number       integer,
  financial_year_id  uuid references fat.financial_years(id) on delete set null,
  claim_group_id     uuid references fat.claim_groups(id)    on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists fat.spoilt_meals (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  date               date not null,
  meal_type          text check (meal_type in ('Spoilt','Delayed','Large','Double','Spoilt / Meal')),
  station_id         integer,
  claim_stn_id       integer,
  platoon            text,
  shift              text check (shift in ('Day','Night')),
  call_time          text,
  call_number        text,
  meal_amount        numeric(8,2) default 22.80,
  total_amount       numeric(8,2),
  adjusted_amount    numeric(8,2),
  claim_date         date,
  pay_number         text,
  status             text default 'Pending' check (status in ('Pending','Paid','Disputed')),
  payment_status     text check (payment_status in ('Pending','Paid')),
  payment_date       timestamptz,
  rates_snapshot     jsonb,
  calc_snapshot      jsonb,
  calculation_inputs jsonb,
  incident_time      text,
  meal_interrupted   text,
  return_to_stn      text,
  attachment_url     text,
  ocr_source         jsonb,
  claim_number       integer,
  financial_year_id  uuid references fat.financial_years(id) on delete set null,
  claim_group_id     uuid references fat.claim_groups(id)    on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);


-- ─── User allowance rate overrides ────────────────────────────────────────────

-- Only canonical editable rates are persisted. Derived allowances
-- (double meal = small + large; spoilt/delayed/standby night meal =
-- small_meal_allowance) compute at read time — no override column needed.
-- Overnight cash is captured per-claim on the retain row, not as a rate.
create table if not exists fat.user_rates (
  id                            uuid primary key default gen_random_uuid(),
  user_id                       uuid not null unique references auth.users(id) on delete cascade,
  kilometre_rate                numeric(8,4),
  small_meal_allowance          numeric(8,2),
  large_meal_allowance          numeric(8,2),
  -- DEPRECATED (2026-05): retain is now hours-only — there is no configurable
  -- retain hourly rate and no derived retain dollar amount. The app no longer
  -- reads or writes this column. Left in place (nullable) to avoid a
  -- destructive migration; safe to drop in a future cleanup migration.
  retain_hourly_rate            numeric(8,2),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

-- Backfill: add the column to existing deployments (idempotent). Retained for
-- backward compatibility only — see DEPRECATED note above.
alter table fat.user_rates add column if not exists retain_hourly_rate numeric(8,2);


-- ─── updated_at triggers ──────────────────────────────────────────────────────

create trigger set_updated_at before update on fat.claim_groups       for each row execute function fat.set_updated_at();
create trigger set_updated_at before update on fat.stations           for each row execute function fat.set_updated_at();
create trigger set_updated_at before update on fat.profiles           for each row execute function fat.set_updated_at();
create trigger set_updated_at before update on fat.profile_ext        for each row execute function fat.set_updated_at();
create trigger set_updated_at before update on fat.home_address       for each row execute function fat.set_updated_at();
create trigger set_updated_at before update on fat.station_distances  for each row execute function fat.set_updated_at();
create trigger set_updated_at before update on fat.recalls            for each row execute function fat.set_updated_at();
create trigger set_updated_at before update on fat.retain             for each row execute function fat.set_updated_at();
create trigger set_updated_at before update on fat.standby            for each row execute function fat.set_updated_at();
create trigger set_updated_at before update on fat.spoilt_meals       for each row execute function fat.set_updated_at();
create trigger set_updated_at before update on fat.user_rates         for each row execute function fat.set_updated_at();


-- ─── Row-Level Security ───────────────────────────────────────────────────────

alter table fat.financial_years   enable row level security;
alter table fat.claim_sequences   enable row level security;
alter table fat.claim_groups      enable row level security;
alter table fat.profiles          enable row level security;
alter table fat.profile_ext       enable row level security;
alter table fat.distance_cache    enable row level security;
alter table fat.home_address      enable row level security;
alter table fat.station_distances enable row level security;
alter table fat.recalls           enable row level security;
alter table fat.retain            enable row level security;
alter table fat.standby           enable row level security;
alter table fat.spoilt_meals      enable row level security;
alter table fat.user_rates        enable row level security;
alter table fat.stations          enable row level security;

create policy users_manage_own on fat.financial_years   for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy users_manage_own on fat.claim_sequences   for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy users_manage_own on fat.claim_groups      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy users_manage_own on fat.profiles          for all using (auth.uid() = id)      with check (auth.uid() = id);
create policy users_manage_own on fat.profile_ext       for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy users_manage_own on fat.distance_cache    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy users_manage_own on fat.home_address      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy users_manage_own on fat.station_distances for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy users_manage_own on fat.recalls           for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy users_manage_own on fat.retain            for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy users_manage_own on fat.standby           for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy users_manage_own on fat.spoilt_meals      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy users_manage_own on fat.user_rates        for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy authenticated_read  on fat.stations for select using (auth.role() = 'authenticated');
create policy service_role_manage on fat.stations for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');


-- ─── Auth.users → fat.profiles auto-seed (FAT-only trigger, parallel to MICA) ──
-- Each app in the shared database adds its OWN trigger on auth.users so it can
-- maintain its OWN authoritative profile row without any cross-app coupling.
-- This trigger is independent of mica.handle_new_user / public.handle_new_user.

create or replace function fat.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = fat, pg_catalog
as $$
begin
  insert into fat.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_fat on auth.users;
create trigger on_auth_user_created_fat
  after insert on auth.users
  for each row execute function fat.handle_new_user();


-- ─── Final grants ─────────────────────────────────────────────────────────────

grant select, insert, update, delete on all tables    in schema fat to authenticated;
grant usage, select                  on all sequences in schema fat to authenticated;
grant execute                        on all functions in schema fat to authenticated;
grant all                            on all tables    in schema fat to service_role;
grant all                            on all sequences in schema fat to service_role;
grant all                            on all functions in schema fat to service_role;

-- The bulk grant above intentionally hands authenticated EXECUTE on every fat
-- function. Trigger-only functions are revoked here so they cannot be invoked
-- via /rest/v1/rpc/*. Keep this block LAST in the file.
revoke all on function fat.handle_new_user() from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════════
-- TRAVEL SUBSYSTEM (FRV Index(hr) matrix + Google routing source metadata)
--
-- Strictly additive. The standalone replayable migration lives at
--   supabase/fat-schema-travel.sql
-- and is mirrored here for the from-scratch bootstrap path. See
-- docs/FAT_SCHEMA_ARCHITECTURE.md for the architecture map.
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists fat.travel_matrix_versions (
  id               uuid primary key default gen_random_uuid(),
  label            text not null,
  source_filename  text,
  unit             text not null default 'hours'
                     check (unit in ('hours','minutes','km')),
  is_active        boolean not null default false,
  imported_at      timestamptz not null default now(),
  imported_by      uuid references auth.users(id) on delete set null,
  notes            text,
  cell_count       integer not null default 0,
  station_count    integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (label)
);

create index if not exists idx_travel_matrix_versions_active
  on fat.travel_matrix_versions (is_active) where is_active;

create table if not exists fat.travel_matrix_cells (
  id              uuid primary key default gen_random_uuid(),
  version_id      uuid not null references fat.travel_matrix_versions(id) on delete cascade,
  station_a_id    integer not null,
  station_b_id    integer not null,
  value           numeric(8,3) not null,
  created_at      timestamptz not null default now(),
  check (station_a_id <= station_b_id),
  check (value >= 0),
  unique (version_id, station_a_id, station_b_id)
);

create index if not exists idx_travel_matrix_cells_lookup
  on fat.travel_matrix_cells (version_id, station_a_id, station_b_id);

create table if not exists fat.station_aliases (
  id          uuid primary key default gen_random_uuid(),
  alias       text not null,
  alias_norm  text not null,
  station_id  integer not null references fat.stations(id) on delete cascade,
  source      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (alias_norm)
);

create index if not exists idx_station_aliases_station
  on fat.station_aliases (station_id);

create trigger set_updated_at before update on fat.travel_matrix_versions for each row execute function fat.set_updated_at();
create trigger set_updated_at before update on fat.station_aliases        for each row execute function fat.set_updated_at();

alter table fat.travel_matrix_versions enable row level security;
alter table fat.travel_matrix_cells    enable row level security;
alter table fat.station_aliases        enable row level security;

create policy authenticated_read  on fat.travel_matrix_versions for select using (auth.role() = 'authenticated');
create policy service_role_manage on fat.travel_matrix_versions for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy authenticated_read  on fat.travel_matrix_cells for select using (auth.role() = 'authenticated');
create policy service_role_manage on fat.travel_matrix_cells for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy authenticated_read  on fat.station_aliases for select using (auth.role() = 'authenticated');
create policy service_role_manage on fat.station_aliases for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create or replace function fat.travel_matrix_lookup(
  p_origin_id integer,
  p_dest_id   integer
) returns table (
  value           numeric(8,3),
  unit            text,
  version_id      uuid,
  version_label   text
)
language sql
stable
security invoker
set search_path = fat, pg_temp
as $$
  select c.value, v.unit, v.id as version_id, v.label as version_label
    from fat.travel_matrix_versions v
    join fat.travel_matrix_cells    c on c.version_id = v.id
   where v.is_active
     and c.station_a_id = least   (p_origin_id, p_dest_id)
     and c.station_b_id = greatest(p_origin_id, p_dest_id)
   limit 1;
$$;

revoke all on function fat.travel_matrix_lookup(integer, integer) from public, anon;
grant  execute on function fat.travel_matrix_lookup(integer, integer) to authenticated, service_role;

alter table fat.recalls
  add column if not exists google_km_home  numeric(6,1),
  add column if not exists google_km_stn   numeric(6,1),
  add column if not exists routing_source  text,
  add column if not exists travel_calc_at  timestamptz;

alter table fat.standby
  add column if not exists google_km_oneway   numeric(6,1),
  add column if not exists matrix_hours       numeric(6,2),
  add column if not exists matrix_version_id  uuid references fat.travel_matrix_versions(id),
  add column if not exists routing_source     text,
  add column if not exists travel_calc_at     timestamptz;

grant select, insert, update, delete on fat.travel_matrix_versions to authenticated, service_role;
grant select, insert, update, delete on fat.travel_matrix_cells    to authenticated, service_role;
grant select, insert, update, delete on fat.station_aliases        to authenticated, service_role;
