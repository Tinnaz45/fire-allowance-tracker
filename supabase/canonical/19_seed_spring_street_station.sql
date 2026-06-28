-- ─── Seed: Spring Street operational location ────────────────────────────────
-- Adds "Spring Street" as a normal fat.stations record so it is selectable
-- everywhere a station can be selected (Rostered/Profile, Recall, Standby, M&D).
--
-- Spring Street is a non-fire-station operational location, so it is seeded
-- OUTSIDE the FRV numbered range (1–96) at id 100 to avoid any collision with
-- existing or future FRV station numbers. It is otherwise a completely normal
-- station row — no special-case logic anywhere in the app. Selectors query
-- `fat.stations where is_active = true`, so this insert is all that's required.
--
-- Spring Street is NOT a fire station, so its abbreviation is NULL. The app
-- treats abbreviation as the "is this a numbered fire station?" signal: fire
-- stations (abbreviation "FS45") display as "FS45 - Brooklyn"; a NULL
-- abbreviation displays the bare name ("Spring Street") with no fabricated FS
-- number. Station identity is carried by the explicit numeric id (NOT parsed
-- from the visible label), so a NULL abbreviation does not affect selection,
-- persistence, distance or entitlement resolution.
--
-- It has no station_distance_matrix / station_time_matrix cells. Matrix lookups
-- for absent pairs already return null (the matrix is sparse, ~41% dense), so
-- Standby/M&D excess-travel simply generates no leg for it — graceful, no error.
-- Recall distance is address/Google-Maps based and is unaffected.
--
-- Idempotent: safe to re-run. DEV only — not part of the FRV canonical import.
-- ─────────────────────────────────────────────────────────────────────────────

insert into fat.stations
  (id, name, abbreviation, district, region, street_address, suburb, postcode, is_active)
values
  (100, 'Spring Street', null, 'Central', null, '215 Spring Street', 'Melbourne', '3000', true)
on conflict (id) do update set
  name           = excluded.name,
  abbreviation   = excluded.abbreviation,
  district       = excluded.district,
  street_address = excluded.street_address,
  suburb         = excluded.suburb,
  postcode       = excluded.postcode,
  is_active      = excluded.is_active,
  updated_at     = now();
