-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — TRAVEL SUBSYSTEM (additive migration)
--
-- Adds the FRV Index(hr) travel matrix tables and the per-claim routing-source
-- columns needed by the bounded travel subsystem (Google Maps KM automation +
-- FRV matrix decimal-hour lookup).
--
-- Strictly ADDITIVE:
--   - Creates new tables in the `fat` schema.
--   - Adds nullable columns to fat.recalls and fat.standby.
--   - Does NOT alter, drop, rename, or repurpose any existing column or row.
--   - Does NOT touch fat.station_distances (browser OSRM cache) — that remains
--     the v4 home→rostered cache and is still used as a fallback path.
--
-- Idempotent: every statement uses `if not exists`, `add column if not exists`,
-- or guarded `do $$ … $$` blocks, so this file can be replayed safely.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── Travel matrix versioning ────────────────────────────────────────────────
-- Each import of the FRV "Index (hr)" tab produces one version row plus a set
-- of sparse cell rows. Exactly one version SHOULD be active at any time; the
-- API route reads `is_active = true`. Versioning lets us roll forward without
-- destructive churn — an old version's cells stay intact for reference.

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


-- ─── Travel matrix cells (sparse, bidirectional, canonical-ordered) ──────────
-- Each (origin, dest) pair is stored ONCE with station_a_id <= station_b_id.
-- Lookups for either direction use:
--   where station_a_id = LEAST($1,$2) and station_b_id = GREATEST($1,$2)
-- Same-station (a == b) cells with value 0 are allowed but optional.
--
-- value is in `unit` declared on the parent version row (defaults to hours).
-- Stations referenced here MUST exist in fat.stations — bad alias entries are
-- caught at import time, not by an FK to avoid cascading deletes on version
-- swaps for previously-deleted-but-still-referenced ids.

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


-- ─── Station name aliases (for header parsing during matrix import) ──────────
-- The FRV spreadsheet uses station name variants ("Sunshine", "FS44",
-- "FS 44 Sunshine", "Glen Iris (Malvern)") that don't all map cleanly to
-- fat.stations.name. The parser writes resolved aliases here so future imports
-- pick up the prior mapping automatically.

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


-- ─── updated_at triggers ─────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'fat.travel_matrix_versions'::regclass
       and tgname  = 'set_updated_at'
  ) then
    create trigger set_updated_at before update on fat.travel_matrix_versions
      for each row execute function fat.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'fat.station_aliases'::regclass
       and tgname  = 'set_updated_at'
  ) then
    create trigger set_updated_at before update on fat.station_aliases
      for each row execute function fat.set_updated_at();
  end if;
end$$;


-- ─── Row-Level Security ──────────────────────────────────────────────────────
-- Matrix data is shared reference data (not per-user). Authenticated users can
-- read; only service_role writes. This mirrors fat.stations.

alter table fat.travel_matrix_versions enable row level security;
alter table fat.travel_matrix_cells    enable row level security;
alter table fat.station_aliases        enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='travel_matrix_versions'
                    and policyname='authenticated_read') then
    create policy authenticated_read on fat.travel_matrix_versions
      for select using (auth.role() = 'authenticated');
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='travel_matrix_versions'
                    and policyname='service_role_manage') then
    create policy service_role_manage on fat.travel_matrix_versions
      for all using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;

  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='travel_matrix_cells'
                    and policyname='authenticated_read') then
    create policy authenticated_read on fat.travel_matrix_cells
      for select using (auth.role() = 'authenticated');
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='travel_matrix_cells'
                    and policyname='service_role_manage') then
    create policy service_role_manage on fat.travel_matrix_cells
      for all using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;

  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='station_aliases'
                    and policyname='authenticated_read') then
    create policy authenticated_read on fat.station_aliases
      for select using (auth.role() = 'authenticated');
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname='fat' and tablename='station_aliases'
                    and policyname='service_role_manage') then
    create policy service_role_manage on fat.station_aliases
      for all using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;
end$$;


-- ─── Bidirectional cell lookup RPC ───────────────────────────────────────────
-- Returns the value (hours/etc.) for an ordered or reversed station pair from
-- the currently-active matrix version. NULL when no cell exists for the pair.

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


-- ─── Per-claim routing-source columns (additive, nullable) ───────────────────
-- These are STRICTLY ADDITIVE — old code paths that wrote only the canonical
-- dist_* columns keep working unchanged. New code paths that go through the
-- travel API persist matching source metadata so the calc can be reproduced
-- later and the user can see which provider produced each leg.

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


-- ─── Final grants (idempotent) ───────────────────────────────────────────────

grant select, insert, update, delete on fat.travel_matrix_versions to authenticated, service_role;
grant select, insert, update, delete on fat.travel_matrix_cells    to authenticated, service_role;
grant select, insert, update, delete on fat.station_aliases        to authenticated, service_role;
