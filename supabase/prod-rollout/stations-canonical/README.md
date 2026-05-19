# PROD rollout — fat.stations canonical FRV cutover

Authoritative source: **FRV Allowances - Current.xlsx → "Stations" tab.**
Apply on PROD only after the same package has been validated on DEV.

## Execution ordering

| # | File | Type | Notes |
|---|---|---|---|
| 0 | `00_preflight_inspect.sql` | read-only | Inspect schema, FKs, and any user/claim rows currently holding station ids. |
| 1 | `01_snapshot_existing.sql` | DDL + DML | Creates `fat._stations_pre_frv_backup` — rollback source. |
| 2 | `02_schema_extension.sql` | DDL (additive) | Adds `district`, `street_address`, `suburb`, `postcode` (all nullable). |
| 3 | `03_canonical_import.sql` | DML | Wipes `fat.stations`, re-seeds the 82 canonical FRV rows. |
| 4 | `04_validate.sql` | read-only | Cardinality, completeness, gap parity, FK safety, runtime parity. |
| 99 | `99_rollback.sql` | DDL + DML | Restores from snapshot; optional schema revert in a commented section. |

## Behaviour guarantees

- **Additive only.** No existing columns are altered or dropped, no constraints added, no triggers/RLS touched.
- **Existing IDs preserved as canonical FRV station numbers** (1–96 with 14 documented gaps). The pre-cutover backup retains whatever id mapping was previously in place.
- **FK compatibility.** Only `fat.profile_ext.station_id` references `fat.stations.id`. Its `ON DELETE SET NULL` rule means `DELETE FROM fat.stations` cannot fail; rows whose station no longer exists are merely nulled.
- **Non-FK references (recalls / retain / standby / spoilt_meals).** These are integer columns without FK constraints. `00_preflight_inspect.sql` (item 4) enumerates them; `04_validate.sql` (item F) verifies none point at a missing id post-cutover. If pre-flight returns ids that disappear in `03`, prepare an `UPDATE … SET station_id = NULL` (or remap) **before** running `03`.
- **Runtime parity.** The app selects only `(id, name, abbreviation [, is_active])`. New columns are not selected, so no client code change is needed for the cutover itself.

## Canonical dataset summary

- **Active rows:** 82
- **Reserved/missing gaps (14):** 17, 21, 36, 37, 49, 65, 69, 74, 75, 76, 77, 78, 79, 83
- **Districts (9):** Central (12), Eastern (11), North & West Regional (6), Northern (12), Southern 1 (9), Southern 2 (8), Western 1 (9), Western 2 (10), Western 3 (5)
- **Abbreviation format:** `FS01`–`FS96` (zero-padded to 2 digits to match the FRV slot)

## DO NOT

- Do not merge this folder to `main` until PROD execution is authorised.
- Do not run `03_canonical_import.sql` without first taking `01_snapshot_existing.sql`.
- Do not run `99_rollback.sql`'s `ROLLBACK B` section unless you have already run `ROLLBACK A` in the same window — dropping the new columns first would lose the data added by `03`.
