# Operational Platoon Resolver — Developer Note

`lib/platoon/resolveOperationalPlatoon.js` is the single source of truth for the
FRV operational platoon attached to every claim (date + shift → platoon). It is
called by `PlatoonBanner` (live display beside the shift selector) and by
`ClaimsContext.addClaim` (snapshotted onto the claim at creation).

## Validated facts (do not change without new evidence)

- **Source:** official *Fire Rescue Victoria Shift Calendar 2026*. Each date is
  colour-coded by one platoon: **A=red, B=blue, C=green, D=amber**.
- **Cycle:** deterministic 8-day rotation — each platoon does 2 day shifts,
  2 night shifts, 4 off. Day-block order **A → D → C → B**.
- **Coloured platoon by cycle index** `((daysSinceAnchor) mod 8)`:
  `A,A,D,D,C,C,B,B`.
- **Anchor:** `2026-01-03` = cycle index 0.
- **Independent validation:** re-derived from the PDF colour cells by two
  different extraction methods. Matched **343/363** readable days; **342/343**
  of all *unambiguous* cells (99.7%). The single unambiguous deviation
  (`2026-08-28`) is a roster-change letter glyph bleeding onto the number colour,
  not a real change — the cycle continues unbroken through it. **No genuine
  mid-year roster exceptions exist.** The rotation is continuous year to year.
- **Z Platoon** is relief/non-operational and never returned.

## The one assumption: DAY vs NIGHT

A coloured cell names ONE platoon, on exactly the 2 consecutive days of its
day block. We treat those coloured days as that platoon's **DAY shifts**
(`CALENDAR_COLOUR_DENOTES = 'Day'`). Supporting (not conclusive) evidence: the
legend lists DAY first, and the coloured block is the first block of the tour.
The calendar does not explicitly label day-vs-night, so this is a **convention,
not a proof.**

Consequence with the current `'Day'` assumption:
- `resolveOperationalPlatoon(date, 'Day')`   = the coloured platoon on `date`.
- `resolveOperationalPlatoon(date, 'Night')` = the coloured platoon on `date − 2 days`
  (a platoon's night block starts 2 days after its day block).

### How to invert (if operational evidence requires it)

Change **one constant** in `resolveOperationalPlatoon.js`:

```js
const CALENDAR_COLOUR_DENOTES = 'Day'   // → change to 'Night'
```

This globally swaps the day/night interpretation (night becomes the coloured
platoon, day becomes 2 days later). The validated cycle, anchor and the 2-day
day↔night spacing are unaffected. Nothing else needs to change. Verified: in
`'Night'` mode `resolveNightPlatoon(d)` returns the raw coloured rotation and
`resolveDayPlatoon(d)` returns the platoon two days later, both internally
consistent.

To confirm the assumption operationally: pick any date and check whether the
calendar's coloured platoon is the crew you worked the **day** shift with. E.g.
`2026-01-01` is blue → **B**; under the current assumption B works the **day**
shift on 1 Jan 2026.

## Tests

`__tests__/platoon-resolver.test.js` pins the `'Day'`-mode outputs against
PDF-validated dates plus structural invariants (8-day periodicity, 2-day blocks,
`night = day − 2`, Z-never, year-boundary continuity). These encode the current
behaviour; if you flip `CALENDAR_COLOUR_DENOTES`, update the expected day/night
values accordingly.
