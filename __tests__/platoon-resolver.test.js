/**
 * FRV Operational Platoon Resolver — Validation Tests
 *
 * Run with: npx jest __tests__/platoon-resolver.test.js
 *
 * Ground-truth dates were read directly from the colour cells of the official
 * "Fire Rescue Victoria Shift Calendar 2026" (each date is coloured by its
 * day-shift platoon). These tests pin the deterministic 8-day rotation so any
 * future change to the engine that drifts the roster will fail loudly.
 */

import {
  resolveOperationalPlatoon,
  resolveDayPlatoon,
  resolveNightPlatoon,
} from '../lib/platoon/resolveOperationalPlatoon.js'

// ─── 1. Validated DAY-shift platoons across all of 2026 ──────────────────────
// Read from the official calendar's colour cells (red=A, blue=B, green=C,
// amber=D). Spans every month so a phase drift anywhere in the year is caught.

const VALIDATED_DAY_PLATOONS = [
  ['2026-01-01', 'B'],
  ['2026-01-16', 'C'],
  ['2026-03-01', 'A'],
  ['2026-03-16', 'A'],
  ['2026-04-01', 'A'],
  ['2026-04-16', 'B'],
  ['2026-05-01', 'B'],
  ['2026-05-17', 'B'],
  ['2026-06-01', 'C'],
  ['2026-06-16', 'C'],
  ['2026-07-01', 'D'],
  ['2026-07-16', 'D'],
  ['2026-08-01', 'D'],
  ['2026-08-16', 'A'],
  ['2026-09-01', 'A'],
  ['2026-09-16', 'A'],
  ['2026-10-01', 'B'],
  ['2026-10-16', 'B'],
  ['2026-11-01', 'B'],
  ['2026-11-16', 'C'],
  ['2026-12-01', 'C'],
  ['2026-12-16', 'D'],
  // Anchor + the two marked "change of roster" letters in February, which the
  // calendar prints on each platoon's first DAY shift of the block.
  ['2026-01-03', 'A'], // anchor: A's first day shift
  ['2026-02-22', 'D'], // marked 'D' = D's first day shift
  ['2026-02-24', 'C'], // marked 'C' = C's first day shift
]

describe('resolveDayPlatoon — validated 2026 calendar dates', () => {
  test.each(VALIDATED_DAY_PLATOONS)('Day shift on %s is %s Platoon', (date, plat) => {
    expect(resolveDayPlatoon(date)).toBe(plat)
  })
})

// ─── 2. resolveOperationalPlatoon dispatch ───────────────────────────────────

describe('resolveOperationalPlatoon', () => {
  test('Day shift dispatches to day platoon', () => {
    expect(resolveOperationalPlatoon('2026-01-03', 'Day')).toBe('A')
  })
  test('Night shift dispatches to night platoon (day platoon 2 days earlier)', () => {
    // 2026-01-03 night crew = day crew of 2026-01-01 = B
    expect(resolveOperationalPlatoon('2026-01-03', 'Night')).toBe('B')
  })
  test('returns null for an unselected / invalid shift type', () => {
    expect(resolveOperationalPlatoon('2026-01-03', '')).toBeNull()
    expect(resolveOperationalPlatoon('2026-01-03', undefined)).toBeNull()
    expect(resolveOperationalPlatoon('2026-01-03', 'Swing')).toBeNull()
  })
  test('returns null for an unparseable date', () => {
    expect(resolveOperationalPlatoon('not-a-date', 'Day')).toBeNull()
    expect(resolveOperationalPlatoon(null, 'Day')).toBeNull()
  })
  test('accepts a Date object', () => {
    expect(resolveOperationalPlatoon(new Date(Date.UTC(2026, 0, 3)), 'Day')).toBe('A')
  })
})

// ─── 3. Night = Day shifted 2 days, for every validated date ─────────────────

describe('night-shift = day-shift two days earlier', () => {
  test.each(VALIDATED_DAY_PLATOONS)('%s night crew matches the day crew of two days prior', (date) => {
    const d = new Date(date + 'T00:00:00Z')
    const twoDaysPrior = new Date(d.getTime() - 2 * 86400000)
    expect(resolveNightPlatoon(date)).toBe(resolveDayPlatoon(twoDaysPrior))
  })
})

// ─── 4. Structural invariants of the 8-day cycle ─────────────────────────────

describe('deterministic 8-day cycle properties', () => {
  test('rotation repeats exactly every 8 days', () => {
    for (let i = 0; i < 40; i++) {
      const d = new Date(Date.UTC(2026, 0, 3) + i * 86400000)
      const d8 = new Date(Date.UTC(2026, 0, 3) + (i + 8) * 86400000)
      expect(resolveDayPlatoon(d)).toBe(resolveDayPlatoon(d8))
    }
  })

  test('each platoon owns exactly 2 consecutive day shifts, all 4 appear per cycle', () => {
    const seq = []
    for (let i = 0; i < 8; i++) {
      seq.push(resolveDayPlatoon(new Date(Date.UTC(2026, 0, 3) + i * 86400000)))
    }
    expect(seq).toEqual(['A', 'A', 'D', 'D', 'C', 'C', 'B', 'B'])
    expect(new Set(seq)).toEqual(new Set(['A', 'B', 'C', 'D']))
  })

  test('over any 8-day window each platoon has 2 day + 2 night shifts', () => {
    const dayCount = {}, nightCount = {}
    for (let i = 0; i < 8; i++) {
      const d = new Date(Date.UTC(2026, 5, 1) + i * 86400000)
      const dp = resolveDayPlatoon(d), np = resolveNightPlatoon(d)
      dayCount[dp] = (dayCount[dp] || 0) + 1
      nightCount[np] = (nightCount[np] || 0) + 1
    }
    for (const p of ['A', 'B', 'C', 'D']) {
      expect(dayCount[p]).toBe(2)
      expect(nightCount[p]).toBe(2)
    }
  })

  test('Z Platoon is never returned by the resolver', () => {
    for (let i = 0; i < 366; i++) {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000)
      expect(['A', 'B', 'C', 'D']).toContain(resolveDayPlatoon(d))
      expect(['A', 'B', 'C', 'D']).toContain(resolveNightPlatoon(d))
    }
  })

  test('rotation is continuous across the year boundary (no Jan/Dec discontinuity)', () => {
    // 2026-12-31 (idx2) and 2027-01-01 (idx3) are D Platoon's two day shifts —
    // the cycle rolls straight through the year boundary with no reset.
    expect(resolveDayPlatoon('2026-12-31')).toBe('D')
    expect(resolveDayPlatoon('2027-01-01')).toBe('D')
    expect(resolveDayPlatoon('2027-01-02')).toBe('C') // next block starts
  })
})
