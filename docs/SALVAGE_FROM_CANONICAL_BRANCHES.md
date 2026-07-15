# Salvage from canonical / dual-write branches — 2026-07-15

Preserves the still-useful ideas from the three canonical-entitlement branches
**before they are deleted**. The **dual-write implementation itself is abandoned**
(see disposition report) — `dev` persists canonical entitlements directly
(`lib/fat/engine/persistEntitlements.js`) and never adopted the transitional
dual-write layer. Nothing below should be merged as-is; it is captured so the
business knowledge is not lost with the branches.

Source branches (all last touched 2026-06-02):
- `claude/sweet-lovelace-Gyd6s` — code + tests + docs
- `claude/beautiful-ptolemy-Um7jb` — audit docs
- `claude/vibrant-thompson-VXGuq` — strict subset of sweet-lovelace

---

## 1. ⭐ Further-From-Home (FFH) excess-travel payability rule — NOT on dev

The single most valuable item. A documented **audit finding** that is **not
implemented on `dev`**. `dev`'s docs (`ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md`)
mark `excess_travel_standby` / `excess_travel_md` as "Resolved (matrix-hours)"
but encode **no payability gate** — dev computes the excess-travel *magnitude*
from the FRV matrix without deciding *whether* it is payable.

Source: `lib/fat/engine/ffh.js` on `claude/sweet-lovelace-Gyd6s`.

### The rule
> Excess Travel (Standby and M&D) is payable **only** when the station the member
> was sent to (standby / M&D "target" station) is **further from the member's
> home** than their **rostered** station.
>
> **`FFH = (home → target station) > (home → rostered station)`**
>
> - FFH decides **whether** an excess-travel row is emitted, **not** how much.
> - The magnitude is still the FRV Matrix `rostered → target` value (hours).
> - Distances are the **per-claim snapshot** captured at claim creation (static-
>   snapshot philosophy — never re-derived after `generated_at`).

### Decision table (from `evaluateFurtherFromHome`)
| home→rostered | home→target | `determinable` | `furtherFromHome` | reason code | excess travel? |
|---|---|---|---|---|---|
| known | `> rostered` | true | true | `target-further-from-home` | **emit** |
| known | `== rostered` | true | false | `equidistant` | suppress |
| known | `< rostered` | true | false | `target-closer-to-home` | suppress |
| missing either | — | false | false | `home-distance-unavailable` | **suppress (fail-closed)** |

**Fail-closed** is deliberate: paying an unjustified excess-travel allowance is
the failure mode the audit flagged, so missing distance data ⇒ no row.

### Edge cases worth keeping (from `__tests__/canonical-standby-dualwrite.test.js`)
- Target station closer to home → **no** `excess_travel` row (FFH false), but
  non-FFH-gated entitlements (`standby_dismi`, `small_meal`) still fire.
- Home distances unavailable → excess travel suppressed (fail-closed).
- Equidistant target → suppressed (strict `>`, not `>=`).
- FFH snapshot distances are carried on the detail row for both SB and M&D and
  default to `null` when absent.

### Relationship to the rule already on `dev`
`dev`'s current tip implements a **related but distinct** home-distance rule for
**petty-cash km** in `lib/fat/engine/generators/musterDismiss.js`:
`payable km = max(0, Home→Rostered − Home→M&D)` (pays when M&D is *closer* to
home). The FFH gate above is the **complementary** rule for **excess travel**
(pays when the target is *further*). They share the "compare home→rostered vs
home→other-station" insight but apply to different entitlements. **Human review
needed**: decide whether the FFH excess-travel gate is a real gap on `dev`.

### If reimplemented later (not now)
Port the pure functions `evaluateFurtherFromHome()` / `isExcessTravelPayable()`
(dependency-free) into the current engine and call them from the `standby` and
`musterDismiss` excess-travel generators — **without** the dual-write plumbing or
the conflicting migrations. Snapshot distances already exist in the claim flow
(petty-cash km uses them today).

---

## 2. Dual-write plumbing — abandoned, do NOT merge
- `lib/fat/persistence/standbyDualWrite.js`, `scripts/dev-validation/run-dualwrite.mjs`
- Migrations `supabase/canonical/04_dual_write_provenance.sql`,
  `05_ffh_home_distances.sql` — **these collide with dev's existing
  `04_seed_rates.sql` and `05_seed_station_distance_matrix.sql`** (same numbers,
  different content). Applying them would break canonical migration ordering.
- `dev` already reached canonical persistence a different way; the dual-write
  transition path is obsolete.

## 3. Audit / architecture docs — reference only
On `beautiful-ptolemy` / `sweet-lovelace`, superseded by dev's own canonical docs
but retain historical reasoning:
- `docs/CANONICAL_DUAL_WRITE_EXECUTION_PATH_v1.0.md`
- `docs/CANONICAL_ENTITLEMENT_AUDIT_v1.0.md`
- `docs/FFH_ENTITLEMENT_ARCHITECTURE_v1.0.md` (the FFH design write-up — pairs
  with §1)
- `docs/FFH_DUALWRITE_DEV_VALIDATION_REPORT.md`

> If the FFH rule (§1) is pursued, pull `FFH_ENTITLEMENT_ARCHITECTURE_v1.0.md`
> across at that time; otherwise it dies with the branch.
