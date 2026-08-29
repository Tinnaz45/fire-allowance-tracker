# APP-92 — Remove unreferenced legacy Fire Allowance public enums (DEV)

Linear Issue: **APP-92** (Applications · Problem · Architecture · App-specific,
Fire Allowance Tracker), an out-of-scope discovery from **GOV-89**.

Target: **DEV Supabase project `kctctvpobbizhkiqkgqw`**.
**Production (`wgcqzamuspuqpedqasbc`) is out of scope and must not receive this
migration** — PROD was never touched by GOV-89 and still carries the five
tables these enums originally served, so PROD still uses them.

---

## What this package removes

Exactly four legacy enum types, and nothing else:

| # | Type | Labels |
|---|------|--------|
| 1 | `public.allowance_line_type` | `ordinary, saturday, sunday, public_holiday, overtime_1_5x, overtime_2x, on_call, non_rostered_on_call, call_out, ph_call_out, call_back, fbt_draft, fbt_submitted` |
| 2 | `public.audit_action` | `shift_created, shift_updated, shift_archived, snapshot_created, breakdown_written, export_generated, import_completed` |
| 3 | `public.ingestion_source` | `manual, ocr_upload, etcs_parse, ai_draft, batch_import, system` |
| 4 | `public.shift_status` | `draft, confirmed, archived` |

## What this package preserves

`public.profiles`, everything in `fat`, `mica`, `cab`, `shared`, all of `auth`
(including the `on_auth_user_created_fat` seed trigger), every Supabase/platform
schema, and every other `public` object. The `public` schema itself is never
dropped, and its relation count does not change — only its enum-type count
moves, 4 → 0.

---

## Execution ordering

| # | File | Type | Notes |
|---|------|------|-------|
| 0 | `00_preflight_inspect.sql` | read-only | Proves the four types are still unreferenced and records the protected-surface baseline. Run and read this first. |
| 1 | `01_drop_legacy_public_enums.sql` | **DDL — destructive** | Guarded drops. Applied to DEV as migration `app92_drop_unreferenced_legacy_public_enums_v1`. |
| 2 | `02_validate.sql` | read-only | Proves the four are gone and every protected surface is unchanged. |
| 99 | `99_recover.sql` | DDL | Recreates the four types with their exact captured labels. Self-contained — needs no surviving database state. |

---

## Why these four are safe to remove

- **Lineage.** GOV-89 (`../gov-89-stale-public-objects/`) removed the five
  `public` tables that were these types' only consumers, and deliberately left
  the types in place because they were outside its approved scope. Its
  `02_validate.sql` section G already recorded them as "now unreferenced — see
  out-of-scope note."
- **Live DEV proof, not inference.** APP-92's own `00_preflight_inspect.sql`
  re-proves this directly against DEV, not from the repository or from GOV-89's
  historical record: zero columns in any schema are typed to any of the four
  (checked across the whole database, not just `fat`/`mica`/`cab`/`shared`/
  `public` — DEV is shared with other apps such as `daily_emom` and
  `snowmen`); zero function/procedure bodies in any schema name them; zero
  check constraints reference them; and the only `pg_depend` entries on their
  type OIDs are Postgres' own internal enum-to-array-type bookkeeping (e.g.
  `_allowance_line_type`), not an external consumer.
- **Repository search.** The four names appear nowhere in application code —
  only in the GOV-89 cleanup artifacts and in
  [`docs/FAT_SCHEMA_ARCHITECTURE.md`](../../../docs/FAT_SCHEMA_ARCHITECTURE.md),
  which documents the same "removed tables, orphaned types" fact in prose.
  Repository silence alone was **not** treated as proof — the live DEV catalog
  queries above are.
- **PROD is unaffected either way.** PROD never received GOV-89, so PROD still
  has the five original tables and these types are still live there. This
  migration targets DEV only and never touches PROD.

## Why no `CASCADE`

Every `DROP TYPE` is written `RESTRICT`, which is Postgres' default for types.
Because nothing depends on these types, `RESTRICT` succeeds; if preflight had
missed a dependant, `RESTRICT` would abort the statement instead of silently
taking that dependant down with it. Guard 1 in `01` re-checks live column usage
and `pg_depend` immediately before the drops, so a dependency introduced
between preflight and migration would also abort the migration rather than
being silently pushed through.

## Guards

`01` refuses to start unless all four target types are present as enums in
`public`, no column anywhere is typed to any of them, and no external
dependant appears in `pg_depend` for any of their OIDs. It refuses to finish
unless all four are gone, `public.profiles` is unchanged, the `public`
relation count (not enum-type count) is unchanged, the `fat` / `mica` / `cab` /
`shared` counts are unchanged, `auth.users` is unchanged, and
`on_auth_user_created_fat` plus `fat.handle_new_user()` are intact. Every guard
raises, which rolls the whole migration back.

## Protected-surface baseline (DEV, before migration)

`02_validate.sql` section D must reproduce these exactly, except
`public enum types`, which goes **4 → 0**.

| Surface | Before |
|---|---|
| `fat` relations | 37 |
| `fat` functions | 26 |
| `mica` relations | 36 |
| `cab` relations | 16 |
| `shared` relations | 1 |
| `public` relations | 1 |
| `public` enum types | 4 → **0 after** |
| `auth.users` rows | 2 |
| `auth` triggers | 3 |

## Recovery

`99_recover.sql` recreates the four types with the exact labels captured live
by `00_preflight_inspect.sql` section A (byte-identical to the definitions
GOV-89's own `99_recover.sql` already carries, since GOV-89 captured the same
four types). There is no data to replay — an enum type carries no rows of its
own, and 00/01 already proved nothing referenced these types — so recreating
the type with its original labels fully reverses the drop.

Grants are not replayed: `typacl` was `NULL` for all four before the drop
(00 section F), meaning only Postgres' default type privileges applied.
Recreating the type re-establishes that default automatically.

## Out-of-scope discovery

None identified. This package's own preflight is the mechanism GOV-89 asked
the follow-up Issue to run; no further orphaned objects were found while
investigating these four types.

## Do not

- Do not apply `01` to Production.
- Do not add `CASCADE` to any drop.
- Do not widen the drop set if a guard fires — a guard firing means the
  dependency surface changed and the finding must be reported.
- Do not retroactively expand GOV-89 or absorb unrelated cleanup into this
  Issue.
