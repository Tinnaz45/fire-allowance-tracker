# Fire Allowance Tracker — Schema Architecture

> Authoritative reference for FAT's PostgreSQL surface in Supabase.
> Every FAT-owned table, function, RPC, trigger and policy lives in the
> `fat` schema. Only Supabase auth and other apps' shared resources remain
> in `public`.

## Schema ownership map

| Schema   | Ownership                                                           |
|----------|---------------------------------------------------------------------|
| `auth`   | Supabase-managed authentication (do not touch). Only shared resource. |
| `public` | Transitional cross-app debt — **not** read or written by FAT runtime. |
| `fat`    | **Everything Fire Allowance Tracker owns**, including identity (`fat.profiles`). |

The Supabase project hosts multiple apps in one database (FAT, MICA,
CAB, …). The `fat` schema is the FAT app boundary.

## FAT-owned resources

All in the `fat` schema:

### Tables

| Table                     | Purpose                                                       |
|---------------------------|---------------------------------------------------------------|
| `fat.financial_years`     | Per-user FY workspaces (one row marked active).               |
| `fat.claim_sequences`     | Atomic per-FY, per-claim-type sequence counters.              |
| `fat.claim_groups`        | Parent claim group rows (one per user-initiated claim).       |
| `fat.stations`            | Station reference data (48 rows seed; read-only for users).   |
| `fat.profiles`            | **Authoritative FAT identity** (first/last name + email).     |
| `fat.profile_ext`         | FAT operational profile (station, platoon, address …).        |
| `fat.distance_cache`      | v1 per-user home→station distance cache.                      |
| `fat.home_address`        | v4 geocoded home address (one row per user).                  |
| `fat.station_distances`   | v4 user-specific home→station distance estimates.             |
| `fat.recalls`             | Recall claim rows (parent + auto-generated child components). |
| `fat.retain`              | Retain (maint stn N/N) claim rows.                            |
| `fat.standby`             | Standby and M&D claim rows.                                   |
| `fat.spoilt_meals`        | Spoilt + Delayed meal rows (`meal_type` discriminator).       |
| `fat.user_rates`          | Per-user allowance rate overrides (defaults in `defaultRates.js`). |

### Functions

| Function                                                       | Purpose                                                |
|----------------------------------------------------------------|--------------------------------------------------------|
| `fat.set_updated_at()`                                         | Trigger function bumping `updated_at` on UPDATE.       |
| `fat.increment_claim_sequence(user_id, fy_id, claim_type)`     | Atomic next-claim-number issuer (RPC).                 |
| `fat.handle_new_user()`                                        | `SECURITY DEFINER` seeder for `fat.profiles` on `auth.users` insert. |

### Triggers

`set_updated_at BEFORE UPDATE` on every FAT table that has an
`updated_at` column.

### RLS Policies

* `users_manage_own` — `FOR ALL USING (auth.uid() = user_id) WITH CHECK (...)` —
  applied to every per-user FAT table.
* `fat.stations.authenticated_read` — `FOR SELECT USING (auth.role() = 'authenticated')`.
* `fat.stations.service_role_manage` — `FOR ALL` for the service role only.

RLS is enabled on every FAT table.

## Default privilege hardening (APP-93 / GOV-102)

GOV-102 found that role `postgres` carried default ACLs in `fat` granting
*future* tables, sequences and functions to `anon`, `authenticated` and
`service_role` automatically on creation — before any RLS policy existed for
them. Every FAT table has RLS enabled today, so this was fail-open creation
semantics rather than a live hole, but it meant a newly created table was
Data-API-reachable by `anon` for however long it took to add its policy.

[`supabase/canonical/21_harden_default_privileges.sql`](../supabase/canonical/21_harden_default_privileges.sql)
(APP-93) revokes those default grants for `fat` in **DEV**
(`kctctvpobbizhkiqkgqw`). It only changes defaults for objects *not yet
created* — every existing table/sequence/function keeps the grants it already
has. PROD (`wgcqzamuspuqpedqasbc`) carries the same broad defaults per GOV-102
but is untouched by this migration; hardening PROD is a separate, explicitly
approved migration.

**Verified DEV effect of the migration** (see PR evidence for the full probe):
newly created tables and sequences get *no* grant to `anon`/`authenticated`/
`service_role` — owner-only, exactly as intended. Newly created functions also
lose the automatic `anon`/`authenticated`/`service_role` grant. **They do
not**, however, lose PUBLIC execute — see the next section.

### Resolved: `ALTER DEFAULT PRIVILEGES` cannot suppress PUBLIC execute here — now automatically enforced (APP-103)

APP-93 also required that future functions not inherit PUBLIC execute. The
migration includes `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS
FROM PUBLIC` for this, matching the documented PostgreSQL pattern — but
repeated probing in DEV (multiple fresh functions, multiple schemas including
a brand-new throwaway schema, both grant/revoke orderings) showed it has
**no effect** in this Supabase-managed Postgres 17.6 instance: every newly
created function's initial ACL still includes `PUBLIC=EXECUTE`, regardless of
default-privilege configuration. Since every role is implicitly a member of
PUBLIC, this meant `anon`/`authenticated` could call a brand-new `fat`
function via RPC unless it was stripped per-function by hand.

APP-103 re-verified and bounded this directly against shared Supabase DEV
with disposable probes:

* A `fat`-scoped default-privilege entry populated by a **revoke-only**
  statement never persists a `pg_default_acl` row here (there is nothing to
  revoke), so a new function's initial ACL is `NULL` and PostgreSQL falls back
  to its hard-wired default (owner + PUBLIC execute).
* Populating that same default-privilege slot with an explicit **grant**
  (e.g. granting execute to `service_role`) *does* persist a `pg_default_acl`
  row containing no PUBLIC entry — but a function created immediately
  afterwards still received `PUBLIC=EXECUTE` in its ACL regardless.
* No event trigger, extension, or other DDL hook already installed on this
  project explains it — `pg_event_trigger` lists only Supabase's own
  pg_graphql/pg_cron/pg_net/PostgREST hooks, none of which touch function ACLs
  for ordinary `CREATE FUNCTION` statements outside their own extensions —
  and there is no database-wide (schema-less) default-ACL entry for role
  `postgres` either.

The exact internal reason the schema-scoped default-privilege override does
not fully replace PostgreSQL's hard-wired function default could not be
isolated further from SQL alone (it would require inspecting Supabase's
Postgres build); the finding is bounded to **"no `ALTER DEFAULT PRIVILEGES`
configuration tried suppresses PUBLIC execute on new `fat` functions here"**
and accepted as reproducible fact.

What *does* reliably work is a direct, per-function
`REVOKE EXECUTE ON FUNCTION <name>(...) FROM PUBLIC` issued after creation —
every existing `fat` function that has had this applied holds no PUBLIC grant
today. APP-93's gap was that this step was manual and was not applied
consistently.

**Enforcement (APP-103):** rather than continue to rely on every future
migration remembering the manual revoke, a `fat`-scoped DDL event trigger
enforces it automatically —
[`supabase/canonical/22_enforce_no_public_execute_fat_functions.sql`](../supabase/canonical/22_enforce_no_public_execute_fat_functions.sql),
applied to DEV. It fires only on the `CREATE FUNCTION` command tag and
immediately no-ops for any object whose schema is not exactly `fat` — cab,
mica, `public`, and every other schema in this shared database are
unaffected, and no existing function's grants are touched, only functions
created (or replaced) after this migration. Options compared and why an
event trigger was selected over a repo-only CI check are documented in that
migration file's header. DEV-only; PROD hardening is a separate, explicitly
approved migration, matching APP-93's precedent.

**Step 5 below is now automatically enforced** rather than merely mandatory —
but keep doing it explicitly in new migrations anyway, since the event
trigger is defense-in-depth for direct-to-DEV changes, not a reason to stop
writing the revoke where the invariant is meant to live: the migration file
itself.

### Provisioning new fat objects

Because new objects now start with **no** Data API access (tables/sequences)
or owner-only access (functions — PUBLIC execute is stripped automatically as
of APP-103, see above), every new table/sequence/function must opt in
explicitly, in this order:

1. Create the object.
2. For a table: `ALTER TABLE fat.<name> ENABLE ROW LEVEL SECURITY;` and add its
   policy (or policies) — typically `users_manage_own`, mirroring the pattern
   above.
3. Only then grant the specific privileges the app actually needs, to the
   specific roles that need them — never blanket `GRANT ALL`:
   ```sql
   grant select, insert, update, delete on fat.<name> to authenticated;
   grant select, insert, update, delete on fat.<name> to service_role;
   ```
4. For a function meant to be called as an RPC, grant execute to the specific
   role(s) that need it:
   `grant execute on function fat.<name>(...) to authenticated;` (or
   `service_role` only, for server-only routines).
5. **Still write this explicitly in every new migration** — even though the
   `fat_enforce_no_public_execute` event trigger (APP-103) now strips it
   automatically as a backstop:
   ```sql
   revoke execute on function fat.<name>(...) from public;
   ```
   Do this in the same migration that creates the function. Treat the event
   trigger as defense-in-depth for direct-to-DEV changes, not a reason to
   drop this line from the governed migration path.

## Public / shared resources used by FAT

| Resource           | Notes                                                                    |
|--------------------|--------------------------------------------------------------------------|
| `auth.users`       | Supabase auth source-of-truth for `user_id` FKs. **Only** shared resource. |

FAT owns the `on_auth_user_created_fat` trigger on `auth.users`, which runs
`fat.handle_new_user()` to seed a `fat.profiles` row for every new user. This
mirrors MICA's `on_auth_user_created_mica` trigger — the two are independent
and cannot interfere with each other.

`public.profiles` is **not** read or written by FAT runtime as of this
migration. It remains in place as transitional cross-app debt and will be
detached separately.

### Legacy `public` objects removed under GOV-89 (DEV)

Five stale Fire Allowance relations that predated the move to the `fat` schema
were removed from the **DEV** project (`kctctvpobbizhkiqkgqw`):

`public.allowance_breakdowns`, `public.audit_logs`,
`public.calculation_snapshots`, `public.engine_versions`, `public.shifts`.

None was read or written by FAT runtime — no repository file referenced any of
them as a relation, and their contents were legacy NSW Ambulance EAPA test rows
rather than FRV entitlement data. They were dropped in FK-safe order with
explicit `RESTRICT` (never `CASCADE`); `public.profiles` and every `fat`,
`mica`, `cab`, `shared` and `auth` object were left untouched. **After this
cleanup `public` holds exactly one relation in DEV: `public.profiles`.**

The migration, its preflight, validation and full recovery artifacts live in
[`supabase/dev-cleanup/gov-89-stale-public-objects/`](../supabase/dev-cleanup/gov-89-stale-public-objects/).
PROD was **not** touched and still carries these objects.

The four enum types those tables used — `public.allowance_line_type`,
`public.audit_action`, `public.ingestion_source`, `public.shift_status` — were
outside GOV-89's approved scope and remain in place, now unreferenced. Their
disposition belongs to a separate Issue.

## Naming conventions

* All table, column, function, trigger and policy names are `snake_case`.
* No table or function carries a `fat_` prefix — schema namespacing
  replaces the redundant prefix.
* Junction discriminators use a `_type` suffix (`meal_type`,
  `claim_type`, …).
* Triggers maintaining `updated_at` are uniformly named `set_updated_at`.
* Per-user RLS policies are uniformly named `users_manage_own`.

## Client access pattern

All FAT queries go through a schema-scoped Supabase client:

```js
import { supabase, fat } from '@/lib/supabaseClient'

// Auth only — public/auth schemas
await supabase.auth.getSession()

// Every FAT table — fat schema, no fat_ prefix on names
await fat.from('profiles').select(...)
await fat.from('claim_groups').select(...)
await fat.from('spoilt_meals').insert(...)
await fat.rpc('increment_claim_sequence', { ... })
```

Source: [`lib/supabaseClient.js`](../lib/supabaseClient.js).

## Spoilt vs Delayed meals

The app exposes `spoilt` and `delayed_meal` as separate top-level claim
types in the UI dropdown, but they share `fat.spoilt_meals` with a
`meal_type` discriminator (`'Spoilt' | 'Delayed'`). The mapping is
centralised in [`lib/claims/claimTypes.js`](../lib/claims/claimTypes.js):

```js
spoilt       → fat.spoilt_meals, meal_type = 'Spoilt'
delayed_meal → fat.spoilt_meals, meal_type = 'Delayed'
```

This is a single-table single-write architecture. Splitting into
two separate physical tables was considered and rejected — it would
add an unnecessary union read on every claim load with no row-level
benefit.

## PostgREST exposure

Supabase PostgREST must expose the `fat` schema for client queries to
reach it. **This is a one-time manual step:**

* **Dashboard → Project Settings → API → Exposed schemas**
  → add `fat` alongside `public`.

After saving, PostgREST hot-reloads automatically; no app restart
needed. If a query against `fat.*` returns *“The schema must be one of
the following: public, …”*, the schema has not been added.

## Migration notes

* The migration was applied to the **DEV** Supabase project
  (`kctctvpobbizhkiqkgqw`) via MCP migration `fat_schema_migration` and
  follow-up `fat_function_bodies_fix`.
* No data was lost — every FAT table was moved with `ALTER TABLE … SET
  SCHEMA fat` and renamed cleanly. FK constraints, indexes and triggers
  followed automatically; index/constraint names were renamed for
  consistency and triggers were recreated against `fat.set_updated_at`.
* `public.station_distances` (v1 inter-station cache, 0 rows, no code
  references) was dropped — `fat.distance_cache` and
  `fat.station_distances` superseded it.
* `public.set_updated_at()` was dropped — it had no callers outside the
  FAT triggers we replaced.
* The migration has **not** been applied to PROD
  (`wgcqzamuspuqpedqasbc`). PROD still uses the legacy `public.fat_*`
  layout. Re-run [`supabase/fat-schema.sql`](../supabase/fat-schema.sql)
  manually or replay the MCP migration when promoting.
* The earlier file
  `supabase-migration-v3-payment-components.sql` (multi-component
  payments, `fat_payment_components` ledger, `fat_payment_summary` view)
  was never applied. The columns it introduced on the claim tables
  (`payment_status`, `payment_date`, `parent_claim_id`,
  `payment_method`, `component_type`, `component_amount`) are present
  in the live schema; the ledger table itself is not. The ledger
  references in `lib/claims/ClaimsContext.js#updatePaymentStatus` are
  defensively try/catch-wrapped and silently skip when the table is
  absent.
