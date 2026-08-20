# GOV-89 — Remove stale Fire Allowance public-schema objects (DEV)

Linear Issue: **GOV-89** (Governance Systems · Problem · Architecture · Shared),
execution workstream of project **GOV-8 — DEV public schema cleanup**.

Target: **DEV Supabase project `kctctvpobbizhkiqkgqw`**.
**Production (`wgcqzamuspuqpedqasbc`) is out of scope and must not receive this
migration.**

---

## What this package removes

Exactly five legacy relations, and nothing else:

| # | Object | Rows at capture |
|---|--------|-----------------|
| 1 | `public.allowance_breakdowns` | 0 |
| 2 | `public.audit_logs` | 1 |
| 3 | `public.calculation_snapshots` | 1 |
| 4 | `public.shifts` | 1 |
| 5 | `public.engine_versions` | 1 |

## What this package preserves

`public.profiles`, everything in `fat`, `mica`, `cab`, `shared`, all of `auth`
(including the `on_auth_user_created_fat` seed trigger), every Supabase/platform
schema, and the four `public` enum types — see *Out-of-scope discovery* below.
The `public` schema itself is never dropped.

---

## Execution ordering

| # | File | Type | Notes |
|---|------|------|-------|
| 0 | `00_preflight_inspect.sql` | read-only | Proves the dependency surface and records the protected-surface baseline. Run and read this first. |
| 1 | `01_drop_stale_public_objects.sql` | **DDL — destructive** | Guarded drops in FK-safe order. Applied to DEV as migration `gov89_drop_stale_public_fat_objects_v1`. |
| 2 | `02_validate.sql` | read-only | Proves the five are gone and every protected surface is unchanged. |
| 99 | `99_recover.sql` | DDL + DML | Full rebuild and data replay. Self-contained — needs no surviving database state. |

---

## Why these five are safe to remove

- **Architecture.** `docs/FAT_SCHEMA_ARCHITECTURE.md` records `public` as
  transitional cross-app debt that FAT runtime neither reads nor writes. Every
  FAT-owned object lives in `fat`.
- **Manifest.** `.catalyst/app.yml` declares `database.schema: fat`.
- **Runtime.** All FAT queries go through the schema-scoped client in
  `lib/supabaseClient.js` (`supabase.schema('fat')`). No file in this repository
  references any of the five as a database relation — the only textual matches
  for "shifts" are UI copy and platoon-roster prose.
- **Content.** The rows are legacy NSW Ambulance EAPA test data
  (`engine_versions.eba_reference = 'NSW Ambulance EAPA Grade 9, EBA 2024'`,
  `salary_class_code = 'EAPA9'`, an audit row tagged
  `m7_t3_sql_validation`). That is a different pay domain entirely from FAT's
  hours-first FRV entitlement model, and confirms the objects are not
  FAT-runtime-owned.

## Proven dependency surface (DEV, before migration)

`public` held **six** relations: the five above plus `public.profiles`.

Eight foreign keys touch the drop set, and every one of them is accounted for:

**Outbound to `auth.users`** — do not block a drop and do not modify `auth.users`:

| Constraint | Rule |
|---|---|
| `allowance_breakdowns_user_id_fkey` | `ON DELETE SET NULL` |
| `audit_logs_user_id_fkey` | `ON DELETE SET NULL` |
| `calculation_snapshots_user_id_fkey` | `ON DELETE SET NULL` |
| `shifts_user_id_fkey` | `ON DELETE SET NULL` |

**Inbound — every one originates inside the drop set:**

| Child | Parent | Rule |
|---|---|---|
| `allowance_breakdowns` | `calculation_snapshots` | `ON DELETE RESTRICT` |
| `allowance_breakdowns` | `shifts` | `ON DELETE RESTRICT` |
| `calculation_snapshots` | `engine_versions` | *(no action)* |
| `calculation_snapshots` | `shifts` | `ON DELETE RESTRICT` |

**No** table outside the drop set references any of the five. There are **no**
dependent views, materialized views or rules anywhere in the database; **no**
function or procedure in `fat`, `mica`, `cab`, `shared` or `public` names them;
**no** triggers; and none belong to a realtime publication.

## Why no `CASCADE`

Every `DROP TABLE` is written `RESTRICT`. That is Postgres' default, but writing
it out makes the guarantee visible and turns any unexpected external dependant
into an aborted migration rather than silent collateral damage. The drop
**order** is what makes `RESTRICT` sufficient — each table goes only after
everything referencing it is already gone:

```
1. allowance_breakdowns   (references snapshots + shifts; nothing references it)
2. audit_logs             (standalone)
3. calculation_snapshots  (its only referrer, allowance_breakdowns, is gone)
4. shifts                 (both referrers gone)
5. engine_versions        (its only referrer, calculation_snapshots, is gone)
```

RLS policies and indexes are *internal* dependencies of their own table. They are
removed with it and never require `CASCADE`.

## Guards

`01` refuses to start unless `public.profiles` exists, schema `fat` and
`fat.profiles` exist, all five targets are present, and no FK, view/rule or
routine outside the drop set touches them. It refuses to finish unless all five
are gone, `public` holds exactly `public.profiles` with unchanged row/column/
constraint counts, the `fat` / `mica` / `cab` / `shared` counts are unchanged,
the four public enum types survive, `auth.users` is unchanged, and
`on_auth_user_created_fat` plus `fat.handle_new_user()` are intact. Every guard
raises, which rolls the whole migration back.

## Protected-surface baseline (DEV, before migration)

`02_validate.sql` section D must reproduce these exactly, except
`public relations`, which goes **6 → 1**.

| Surface | Before |
|---|---|
| `fat` relations | 37 |
| `fat` functions | 25 |
| `mica` relations | 36 |
| `cab` relations | 16 |
| `shared` relations | 1 |
| `public` relations | 6 → **1 after** |
| `public` enum types | 4 |
| `auth.users` rows | 2 |
| `auth` triggers | 3 |

## Recovery

`99_recover.sql` rebuilds all five relations — columns, defaults, nullability,
checks, primary/unique keys, indexes, RLS and policies — and replays the exact
four rows captured before the drop.

The recovery data lives **in this file**, not in a backup table, because GOV-89
forbids writing new objects into any protected schema. Four rows fit comfortably
in the repository, which makes the artifact self-contained and replayable into an
empty `public` schema.

The owning `auth` user is resolved defensively: every `user_id` column is
`ON DELETE SET NULL`, so if that account no longer exists the restore stores
`NULL` instead of failing the foreign key. The temp table it uses disappears with
the session.

Grants are not replayed. The five carried nothing but Supabase's standard
public-schema default privileges, which are re-applied automatically on
recreation; RLS is what actually constrained access, and it is restored in full.

## Out-of-scope discovery — orphaned enum types

`public.allowance_line_type`, `public.audit_action`, `public.ingestion_source`
and `public.shift_status` are used **only** by the five dropped tables, so they
are unreferenced afterwards.

GOV-89 approves five *relations*, not these types. They are deliberately left in
place and `02_validate.sql` section G asserts their survival. Removing them is an
independently meaningful change that belongs to its own Linear Issue — absorbing
it here would be scope creep (CLAUDE.md §2, *Keep Issues whole*).

## Do not

- Do not apply `01` to Production.
- Do not add `CASCADE` to any drop.
- Do not widen the drop set if a guard fires — a guard firing means the
  dependency surface changed and the finding must be reported.
- Do not drop the `public` schema.
