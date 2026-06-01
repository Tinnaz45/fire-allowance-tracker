/**
 * Travel Display Formatting — Validation Tests
 *
 * Run with: npx jest __tests__/travel-format.test.js
 *
 * Pins the global travel display rules:
 *   - distances round UP to the next whole kilometre
 *   - times      round UP to the next whole minute
 */

import {
  roundUpKm,
  formatTravelDistanceKm,
  roundUpMinutes,
  formatTravelTime,
  roundUpToQuarterHour,
  formatTravelTimeWithHours,
} from '../lib/distance/travelFormat.js'

describe('roundUpKm', () => {
  test('rounds any fraction up to the next whole km', () => {
    expect(roundUpKm(12.1)).toBe(13)
    expect(roundUpKm(12.9)).toBe(13)
    expect(roundUpKm(0.1)).toBe(1)
  })
  test('leaves a whole number unchanged', () => {
    expect(roundUpKm(12)).toBe(12)
  })
  test('returns null for non-positive / invalid input', () => {
    expect(roundUpKm(0)).toBeNull()
    expect(roundUpKm(-3)).toBeNull()
    expect(roundUpKm(null)).toBeNull()
    expect(roundUpKm(NaN)).toBeNull()
  })
})

describe('formatTravelDistanceKm', () => {
  test('formats with km suffix, rounded up', () => {
    expect(formatTravelDistanceKm(12.1)).toBe('13 km')
    expect(formatTravelDistanceKm(40)).toBe('40 km')
  })
  test('returns null for invalid input', () => {
    expect(formatTravelDistanceKm(0)).toBeNull()
    expect(formatTravelDistanceKm(null)).toBeNull()
  })
})

describe('roundUpMinutes', () => {
  test('rounds any leftover seconds up to the next whole minute', () => {
    expect(roundUpMinutes(61)).toBe(2)
    expect(roundUpMinutes(60)).toBe(1)
    expect(roundUpMinutes(1)).toBe(1)
    expect(roundUpMinutes(1380)).toBe(23)   // exactly 23 min
    expect(roundUpMinutes(1381)).toBe(24)   // 23 min + 1s rounds up
  })
  test('returns null for non-positive / invalid input', () => {
    expect(roundUpMinutes(0)).toBeNull()
    expect(roundUpMinutes(null)).toBeNull()
    expect(roundUpMinutes(NaN)).toBeNull()
  })
})

describe('formatTravelTime', () => {
  test('formats sub-hour durations in minutes', () => {
    expect(formatTravelTime(1381)).toBe('24 min')
    expect(formatTravelTime(60)).toBe('1 min')
  })
  test('formats hour-plus durations as hr + min', () => {
    expect(formatTravelTime(3900)).toBe('1 hr 5 min')   // 65 min
    expect(formatTravelTime(3600)).toBe('1 hr')         // exactly 60 min
    expect(formatTravelTime(7260)).toBe('2 hr 1 min')   // 121 min
  })
  test('returns null for invalid input', () => {
    expect(formatTravelTime(0)).toBeNull()
    expect(formatTravelTime(null)).toBeNull()
  })
})

describe('roundUpToQuarterHour', () => {
  test('rounds whole minutes up to the next 0.25 h (ceil to 15 min)', () => {
    expect(roundUpToQuarterHour(59)).toBe(1)       // 59 min → 1.00 hr
    expect(roundUpToQuarterHour(60)).toBe(1)       // exactly 60 min → 1.00 hr
    expect(roundUpToQuarterHour(61)).toBe(1.25)    // 61 min → 1.25 hr
    expect(roundUpToQuarterHour(65)).toBe(1.25)    // 65 min → 1.25 hr
    expect(roundUpToQuarterHour(15)).toBe(0.25)    // exactly one increment
    expect(roundUpToQuarterHour(1)).toBe(0.25)     // any leftover rounds up
  })
  test('returns null for non-positive / invalid input', () => {
    expect(roundUpToQuarterHour(0)).toBeNull()
    expect(roundUpToQuarterHour(null)).toBeNull()
    expect(roundUpToQuarterHour(NaN)).toBeNull()
  })
})

describe('formatTravelTimeWithHours', () => {
  test('appends quarter-hour-rounded hours to the minute display', () => {
    expect(formatTravelTimeWithHours(3540)).toBe('59 min (1.00 hr)')   // 59 min
    expect(formatTravelTimeWithHours(1381)).toBe('24 min (0.50 hr)')   // 24 min
    expect(formatTravelTimeWithHours(3600)).toBe('1 hr (1.00 hr)')     // exactly 60 min
    expect(formatTravelTimeWithHours(3900)).toBe('1 hr 5 min (1.25 hr)') // 65 min
  })
  test('returns null for invalid input', () => {
    expect(formatTravelTimeWithHours(0)).toBeNull()
    expect(formatTravelTimeWithHours(null)).toBeNull()
  })
})
