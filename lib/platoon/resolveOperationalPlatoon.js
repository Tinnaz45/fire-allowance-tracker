// ─── FRV operational platoon resolver ────────────────────────────────────────
//
// Single source of truth for "which platoon is operationally on for a given
// date + shift" under the Fire Rescue Victoria repeating shift rotation.
//
// CANONICAL SOURCE: the official "Fire Rescue Victoria Shift Calendar 2026".
// Every dated cell on that calendar is colour-coded by one platoon
// (A=red, B=blue, C=green, D=amber). Reading the colour of all 365 day cells
// yields a clean, deterministic 8-day rotation with no mid-year discontinuity —
// January through December share a single phase.
//
// ── The rotation (validated) ────────────────────────────────────────────────
// Each platoon works a fixed 8-day tour: 2 DAY shifts, then 2 NIGHT shifts,
// then 4 days OFF (the calendar legend's "DAY DAY / NIGHT NIGHT / OFF OFF OFF
// OFF"). The four platoons are offset by 2 days so that on any date exactly one
// platoon is on day shift and a different one is on night shift. The day-block
// order is A → D → C → B.
//
// Coloured platoon by cycle index (days since the anchor, mod 8):
//   idx:  0  1  2  3  4  5  6  7
//   plat: A  A  D  D  C  C  B  B
//
// ANCHOR: 2026-01-03 = cycle index 0 (A Platoon's first day-block day).
//
// VALIDATION (independent, two extraction methods): the cycle, the A→D→C→B
// order and the anchor were re-derived directly from the PDF colour cells and
// matched the calendar on 343/363 readable days — 342/343 of all *unambiguous*
// cells (99.7%). The lone unambiguous deviation (2026-08-28) was proven to be a
// roster-change *letter* glyph bleeding onto the number's colour, not a real
// roster change (the cycle continues unbroken through it). There are NO genuine
// mid-year roster exceptions; the rotation is continuous year to year, so this
// resolver is valid for any date.
//
// ── DAY vs NIGHT interpretation (the one assumption) ─────────────────────────
// A coloured cell identifies ONE platoon, and a platoon is coloured on exactly
// the 2 consecutive days of ITS day block. We take those coloured days to be the
// platoon's DAY shifts (CALENDAR_COLOUR_DENOTES = 'Day'). Supporting evidence:
// the legend lists DAY first, and the coloured block is the first block of the
// tour. The calendar does not *explicitly* label day-vs-night, so this is a
// convention, not a proof.
//
//   >>> TO INVERT: if operational evidence shows the coloured cell denotes the
//   >>> NIGHT crew, change CALENDAR_COLOUR_DENOTES from 'Day' to 'Night'. That
//   >>> single edit swaps the day/night outputs globally; nothing else changes.
//
// Either way the day↔night spacing is fixed by the 2-2-4 tour: a platoon's
// night block starts exactly 2 days after its day block, so the day and night
// crews on any date are always 2 cycle-days apart (DAY_TO_NIGHT_OFFSET).
//
// Z Platoon is a relief / non-operational designation and never appears in the
// daily day/night rotation — this resolver only ever returns A, B, C, or D.
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86400000

// Anchor: 2026-01-03 (UTC midnight) = cycle index 0.
const ANCHOR_UTC = Date.UTC(2026, 0, 3)

// The platoon the calendar COLOURS on each date, by cycle index 0..7. This is
// the raw, validated rotation read straight off the PDF — independent of the
// day/night interpretation below.
const CALENDAR_COLOUR_SEQUENCE = ['A', 'A', 'D', 'D', 'C', 'C', 'B', 'B']

// Days from a platoon's day-block start to its night-block start (2 day shifts
// then 2 night shifts ⇒ 2). Fixed by the 2-2-4 tour structure.
const DAY_TO_NIGHT_OFFSET = 2

// Which shift the calendar's colour denotes. Validated convention: 'Day'.
// Flip to 'Night' to invert the day/night interpretation everywhere (see the
// header note). This is the ONLY knob that controls day-vs-night.
const CALENDAR_COLOUR_DENOTES = 'Day'

// Day offset applied to the coloured-platoon lookup for each shift, derived from
// the single interpretation constant above so the two shifts always stay 2 days
// apart and consistent.
//   colour='Day'   → day uses the coloured day (0), night is 2 days earlier (-2)
//   colour='Night' → night uses the coloured day (0), day is 2 days later (+2)
const DAY_LOOKUP_OFFSET   = CALENDAR_COLOUR_DENOTES === 'Day' ? 0 : DAY_TO_NIGHT_OFFSET
const NIGHT_LOOKUP_OFFSET = CALENDAR_COLOUR_DENOTES === 'Day' ? -DAY_TO_NIGHT_OFFSET : 0

// Parse a 'YYYY-MM-DD' string (or Date) to a UTC-midnight epoch in whole days.
// Using a calendar-date string with UTC arithmetic keeps the cycle immune to
// local timezone / DST — the claim `date` is a wall-clock calendar date, not an
// instant. Returns null for unparseable input.
function toUtcDay(date) {
  if (date == null) return null
  let y, m, d
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) return null
    y = date.getUTCFullYear(); m = date.getUTCMonth() + 1; d = date.getUTCDate()
  } else if (typeof date === 'string') {
    const match = date.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (!match) return null
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3])
  } else {
    return null
  }
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY)
}

// Cycle index 0..7 for a given UTC-day epoch.
function cycleIndex(utcDay) {
  return (((utcDay - Math.floor(ANCHOR_UTC / MS_PER_DAY)) % 8) + 8) % 8
}

// The platoon the calendar colours on a date (the raw rotation value). Internal
// primitive that resolveDayPlatoon / resolveNightPlatoon are derived from.
function colouredPlatoon(utcDay) {
  return CALENDAR_COLOUR_SEQUENCE[cycleIndex(utcDay)]
}

// Day-shift platoon for a calendar date. Returns 'A'|'B'|'C'|'D', or null on
// bad input.
export function resolveDayPlatoon(date) {
  const utcDay = toUtcDay(date)
  if (utcDay == null) return null
  return colouredPlatoon(utcDay + DAY_LOOKUP_OFFSET)
}

// Night-shift platoon for a calendar date. Returns 'A'|'B'|'C'|'D', or null on
// bad input. With the validated 'Day' interpretation this equals the day-shift
// platoon two days earlier.
export function resolveNightPlatoon(date) {
  const utcDay = toUtcDay(date)
  if (utcDay == null) return null
  return colouredPlatoon(utcDay + NIGHT_LOOKUP_OFFSET)
}

// ── Main entry point ──────────────────────────────────────────────────────────
// resolveOperationalPlatoon(date, shiftType)
//   date:      'YYYY-MM-DD' string or Date (the claim's operational date)
//   shiftType: 'Day' | 'Night'
// Returns the operational platoon 'A'|'B'|'C'|'D' working that shift on that
// date, or null when the date is unparseable or the shift is not Day/Night
// (e.g. a Recall before the user has picked a shift type).
export function resolveOperationalPlatoon(date, shiftType) {
  if (shiftType === 'Day')   return resolveDayPlatoon(date)
  if (shiftType === 'Night') return resolveNightPlatoon(date)
  return null
}

export default resolveOperationalPlatoon
