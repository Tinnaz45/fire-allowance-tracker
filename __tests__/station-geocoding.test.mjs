/**
 * Station geocoding resolution-order tests.
 *
 * Pins the behaviour of geocodeStation():
 *   1. Stored lat/lng on the station record are used directly (no network).
 *   2. A station with a structured street address geocodes that address —
 *      this is what makes FS60 "Training Academy" resolve, since its name is
 *      not an OpenStreetMap "<name> Fire Station".
 *   3. If the structured address does not resolve, it falls back to the legacy
 *      "<name> Fire Station, Victoria, Australia" query.
 *   4. Ordinary stations with no stored address keep using the name query.
 *
 * Run with:  node --test __tests__/station-geocoding.test.mjs
 *
 * Uses Node's built-in runner (node:test) because the repo ships ESM `.js`
 * modules without a jest ESM transform configured. nominatim.js only depends on
 * the global fetch, which we stub here.
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { geocodeStation } from '../lib/distance/nominatim.js'

// ── fetch stubbing ───────────────────────────────────────────────────────────
const realFetch = globalThis.fetch
let calls = []

/** Extract the decoded `q=` query string from a Nominatim URL. */
function queryOf(url) {
  const m = String(url).match(/[?&]q=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

/** Build an ok JSON Response-like object returning the given array. */
function jsonOk(arr) {
  return { ok: true, status: 200, json: async () => arr }
}

/**
 * Install a fetch stub. `handler(query)` returns the array Nominatim would
 * return for that query (empty array = "not found"). Every call is recorded.
 */
function stubFetch(handler) {
  globalThis.fetch = async (url) => {
    const q = queryOf(url)
    calls.push(q)
    return jsonOk(handler(q))
  }
}

beforeEach(() => { calls = [] })
afterEach(() => { globalThis.fetch = realFetch })

// ── 1. Stored coordinates win, no network call ───────────────────────────────

test('uses stored lat/lng directly and makes no network call', async () => {
  stubFetch(() => { throw new Error('fetch should not be called when coords are stored') })
  const result = await geocodeStation({
    id: 45, name: 'Brooklyn',
    street_address: '2 Cypress Ave', suburb: 'Brooklyn', postcode: '3012',
    lat: -37.8213, lng: 144.8459,
  })
  assert.deepEqual(result, { lat: -37.8213, lng: 144.8459 })
  assert.equal(calls.length, 0)
})

test('accepts stored coordinates supplied as numeric strings (Supabase numeric)', async () => {
  stubFetch(() => { throw new Error('fetch should not be called when coords are stored') })
  const result = await geocodeStation({ id: 45, name: 'Brooklyn', lat: '-37.8213', lng: '144.8459' })
  assert.deepEqual(result, { lat: -37.8213, lng: 144.8459 })
  assert.equal(calls.length, 0)
})

// ── 2. FS60-style name resolves through its structured address ───────────────

test('FS60 "Training Academy" resolves via its stored structured address', async () => {
  // Name-based query returns nothing (the real failure); the address resolves.
  stubFetch((q) => {
    if (q === '284-290 Hume Highway, Craigieburn VIC 3064, Australia') {
      return [{ lat: '-37.6032', lon: '144.9412' }]
    }
    return [] // "Training Academy Fire Station, ..." → not found
  })

  const result = await geocodeStation({
    id: 60, name: 'Training Academy',
    street_address: '284-290 Hume Highway', suburb: 'Craigieburn', postcode: '3064',
    lat: null, lng: null, // FS60 has null coordinates in the DB
  })

  assert.deepEqual(result, { lat: -37.6032, lng: 144.9412 })
  // The structured address is tried; the name query is never reached.
  assert.deepEqual(calls, ['284-290 Hume Highway, Craigieburn VIC 3064, Australia'])
})

test('null / empty stored coordinates are not mistaken for a valid location', async () => {
  // Number(null) === 0 and Number('') === 0 — these must NOT short-circuit as
  // coordinate (0, 0). The address query must run instead.
  stubFetch(() => [{ lat: '-37.60', lon: '144.94' }])
  const result = await geocodeStation({
    id: 60, name: 'Training Academy',
    street_address: '284-290 Hume Highway', suburb: 'Craigieburn', postcode: '3064',
    lat: '', lng: null,
  })
  assert.deepEqual(result, { lat: -37.6, lng: 144.94 })
  assert.equal(calls[0], '284-290 Hume Highway, Craigieburn VIC 3064, Australia')
})

// ── 3. Structured address fails → name-based fallback ────────────────────────

test('falls back to the name query when the structured address does not resolve', async () => {
  stubFetch((q) => {
    if (q === 'Training Academy Fire Station, Victoria, Australia') {
      return [{ lat: '-37.70', lon: '145.00' }]
    }
    return [] // structured address not found
  })

  const result = await geocodeStation({
    id: 60, name: 'Training Academy',
    street_address: '284-290 Hume Highway', suburb: 'Craigieburn', postcode: '3064',
  })

  assert.deepEqual(result, { lat: -37.7, lng: 145.0 })
  assert.deepEqual(calls, [
    '284-290 Hume Highway, Craigieburn VIC 3064, Australia',
    'Training Academy Fire Station, Victoria, Australia',
  ])
})

// ── 4. Ordinary station with no stored address uses the name query ───────────

test('ordinary station without stored address/coords uses the name-based query', async () => {
  stubFetch((q) => {
    if (q === 'Newport Fire Station, Victoria, Australia') {
      return [{ lat: '-37.8419', lon: '144.8836' }]
    }
    return []
  })

  const result = await geocodeStation({ id: 42, name: 'Newport' })

  assert.deepEqual(result, { lat: -37.8419, lng: 144.8836 })
  assert.deepEqual(calls, ['Newport Fire Station, Victoria, Australia'])
})

// ── Guard: a station with only a suburb (no street) skips straight to name ───

test('a station with a suburb but no street_address skips to the name query', async () => {
  stubFetch((q) => (q === 'Somewhere Fire Station, Victoria, Australia' ? [{ lat: '-37.0', lon: '145.0' }] : []))
  const result = await geocodeStation({ id: 99, name: 'Somewhere', suburb: 'Placeville', postcode: '3000' })
  assert.deepEqual(result, { lat: -37.0, lng: 145.0 })
  assert.deepEqual(calls, ['Somewhere Fire Station, Victoria, Australia'])
})

// ── Guard: missing name still throws ─────────────────────────────────────────

test('throws when the station has no name', async () => {
  await assert.rejects(() => geocodeStation({ id: 1 }), /Station name is missing/)
})
