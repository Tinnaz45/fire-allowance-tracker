// ─── Entitlement Engine — Draft-Shape Validation ─────────────────────────────
// Lightweight node-runnable assertions over the SB and MD generators and the
// effectiveAmount / effectiveHours helpers. Mirrors the runner shape used by
// lib/calculations/validationScenarios.js (no test framework dependency).
//
// Usage:
//   node lib/fat/engine/validateDrafts.js
//
// Asserts the EntitlementDraft invariants from
// ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 7 plus the helper contracts from § 4.

import { generateEntitlements } from './index.js'
import {
  effectiveAmount,
  effectiveHours,
  effectivePayable,
  isManualOverride,
} from '../models/entitlementHelpers.js'

// ─── Fixture builders ────────────────────────────────────────────────────────

const STATION_ROSTERED = 1
const STATION_STANDBY  = 2
const STATION_MD       = 3

function makeRateLookup(values) {
  return (code /* , claimDate */) => {
    const v = values[code]
    if (v == null) return null
    return {
      rate: {
        id:                'rate-' + code,
        code,
        display_name:      code,
        unit:              v.unit,
        active_version_id: 'rv-' + code,
        created_at:        '2026-01-01T00:00:00Z',
      },
      rateVersion: {
        id:             'rv-' + code,
        rate_id:        'rate-' + code,
        version_label:  'v1',
        value:          v.value,
        effective_from: '2026-01-01',
        created_at:     '2026-01-01T00:00:00Z',
        created_by:     null,
      },
      value: v.value,
    }
  }
}

function makeMatrixLookup(cells) {
  return (from, to, version) => {
    const key = `${from}->${to}@${version}`
    const hit = cells[key]
    if (hit == null) return null
    return { hours: hit, matrixVersion: version }
  }
}

const RATES_FIXTURE = {
  small_meal:    { unit: 'dollars', value: 10.90 },
  standby_hours: { unit: 'hours',   value: 0.5 },
  md_hours:      { unit: 'hours',   value: 1.0 },
}

const MATRIX_FIXTURE = {
  '1->2@2026.1': 0.75,
  '1->3@2026.1': 1.25,
}

function makeCtx({ rates = RATES_FIXTURE, matrix = MATRIX_FIXTURE, rosteredStation = STATION_ROSTERED } = {}) {
  return {
    rateLookup:   makeRateLookup(rates),
    matrixLookup: makeMatrixLookup(matrix),
    profileSnapshot: {
      id:                     'user-1',
      rostered_station_id:    rosteredStation,
      rostered_station_name:  'Rostered Station',
    },
  }
}

function makeStandbyClaim(overrides = {}) {
  return {
    claim_type:              'SB',
    claim_date:              '2026-06-01',
    station_id_snapshot:     STATION_ROSTERED,
    station_name_snapshot:   'Rostered Station',
    source_calculation_mode: 'frv_matrix',
    status:                  'draft',
    notes:                   null,
    parent_claim_id:         null,
    copy_source_owner_id:    null,
    ...overrides,
  }
}

function makeStandbyDetails(overrides = {}) {
  return {
    standby_station_id: STATION_STANDBY,
    standby_start_at:   '2026-06-01T19:30:00',  // night-shift arrival → small meal trigger
    standby_end_at:     '2026-06-02T07:30:00',
    matrix_distance_km: null,
    matrix_hours:       null,
    matrix_version:     '2026.1',
    ...overrides,
  }
}

function makeMdClaim(overrides = {}) {
  return {
    claim_type:              'MD',
    claim_date:              '2026-06-02',
    station_id_snapshot:     STATION_ROSTERED,
    station_name_snapshot:   'Rostered Station',
    source_calculation_mode: 'frv_matrix',
    status:                  'draft',
    notes:                   null,
    parent_claim_id:         null,
    copy_source_owner_id:    null,
    ...overrides,
  }
}

function makeMdDetails(overrides = {}) {
  return {
    md_station_id:      STATION_MD,
    md_event_at:        '2026-06-02T08:00:00',
    matrix_distance_km: null,
    matrix_hours:       null,
    matrix_version:     '2026.1',
    ...overrides,
  }
}

// ─── Assertion helpers ───────────────────────────────────────────────────────

function check(label, condition, detail) {
  if (condition) return { label, pass: true, errors: [] }
  return { label, pass: false, errors: [detail || 'condition failed'] }
}

function assertDraftInvariants(draft, label) {
  const errors = []
  // § 7.1 — exactly one of generated_amount / generated_hours non-null,
  // and unit governs which one.
  if (draft.unit === 'dollars') {
    if (draft.generated_amount == null) errors.push('dollars unit but generated_amount is null')
    if (draft.generated_hours != null)  errors.push('dollars unit but generated_hours is non-null')
  } else if (draft.unit === 'hours') {
    if (draft.generated_hours == null) errors.push('hours unit but generated_hours is null')
    if (draft.generated_amount != null) errors.push('hours unit but generated_amount is non-null')
  } else if (draft.unit === 'km') {
    if (draft.generated_amount != null || draft.generated_hours != null) {
      errors.push('km unit but a payable quantity is non-null')
    }
  } else {
    errors.push(`unknown unit '${draft.unit}'`)
  }
  // § 7.2 — engine never populates edit fields.
  if (draft.manual_override !== false) errors.push('manual_override !== false at generation')
  if (draft.edited_amount  !== null)   errors.push('edited_amount populated at generation')
  if (draft.edited_hours   !== null)   errors.push('edited_hours populated at generation')
  if (draft.edited_note    !== null)   errors.push('edited_note populated at generation')
  // § 7.3 — rule provenance.
  if (typeof draft.rule_id !== 'string' || draft.rule_id.length === 0) errors.push('rule_id empty')
  if (typeof draft.rule_version !== 'string' || draft.rule_version.length === 0) errors.push('rule_version empty')
  // § 7.4 — rate_snapshot non-null.
  if (draft.rate_snapshot == null || typeof draft.rate_snapshot !== 'object') {
    errors.push('rate_snapshot non-object')
  }
  // § 7.5 — initial payment state if routing set.
  if (draft.payment_method === 'payslip'    && draft.payment_status !== 'pending')     errors.push('payslip stream missing pending status')
  if (draft.payment_method === 'petty_cash' && draft.payment_status !== 'outstanding') errors.push('petty_cash stream missing outstanding status')
  return { label, pass: errors.length === 0, errors }
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

const SCENARIOS = []

// SB: full set (all three triggers fire).
SCENARIOS.push({
  name: 'SB: emits excess_travel_standby + standby_dismi + small_meal when all triggers fire',
  run: () => {
    const drafts = generateEntitlements(makeStandbyClaim(), makeStandbyDetails(), makeCtx())
    const errors = []
    if (drafts.length !== 3) errors.push(`expected 3 drafts, got ${drafts.length}`)
    const types = drafts.map(d => d.entitlement_type).sort()
    const expected = ['excess_travel_standby', 'small_meal', 'standby_dismi']
    if (JSON.stringify(types) !== JSON.stringify(expected)) {
      errors.push(`expected types ${JSON.stringify(expected)}, got ${JSON.stringify(types)}`)
    }
    return { label: 'SB full set', pass: errors.length === 0, errors }
  },
})

SCENARIOS.push({
  name: 'SB: excess_travel_standby is hours-first with matrix snapshot',
  run: () => {
    const drafts = generateEntitlements(makeStandbyClaim(), makeStandbyDetails(), makeCtx())
    const d = drafts.find(x => x.entitlement_type === 'excess_travel_standby')
    if (!d) return { label: 'find', pass: false, errors: ['missing draft'] }
    const errors = []
    if (d.unit !== 'hours')           errors.push(`unit=${d.unit}`)
    if (d.generated_amount !== null)  errors.push('generated_amount not null')
    if (d.generated_hours !== 0.75)   errors.push(`generated_hours=${d.generated_hours}`)
    if (d.rate_id !== null)           errors.push('rate_id should be null for matrix-driven row')
    if (d.rate_version_id !== null)   errors.push('rate_version_id should be null')
    if (d.rate_snapshot?.matrix_version !== '2026.1') errors.push('matrix snapshot wrong')
    if (d.rate_snapshot?.matrix_hours !== 0.75)       errors.push('matrix snapshot hours wrong')
    if (d.payment_method !== 'payslip')               errors.push('payment_method')
    if (d.payment_status !== 'pending')               errors.push('payment_status')
    return assertDraftInvariants(d, 'SB excess_travel_standby').pass
      ? { label: 'SB excess_travel_standby', pass: errors.length === 0, errors }
      : assertDraftInvariants(d, 'SB excess_travel_standby')
  },
})

SCENARIOS.push({
  name: 'SB: standby_dismi is hours-first 0.5h from rate code',
  run: () => {
    const drafts = generateEntitlements(makeStandbyClaim(), makeStandbyDetails(), makeCtx())
    const d = drafts.find(x => x.entitlement_type === 'standby_dismi')
    if (!d) return { label: 'find', pass: false, errors: ['missing draft'] }
    const errors = []
    if (d.unit !== 'hours')           errors.push(`unit=${d.unit}`)
    if (d.generated_hours !== 0.5)    errors.push(`hours=${d.generated_hours}`)
    if (d.generated_amount !== null)  errors.push('amount not null')
    if (d.rate_id !== 'rate-standby_hours') errors.push('rate_id')
    return assertDraftInvariants(d, 'SB standby_dismi').pass
      ? { label: 'SB standby_dismi', pass: errors.length === 0, errors }
      : assertDraftInvariants(d, 'SB standby_dismi')
  },
})

SCENARIOS.push({
  name: 'SB: small_meal is dollars-first with petty_cash routing',
  run: () => {
    const drafts = generateEntitlements(makeStandbyClaim(), makeStandbyDetails(), makeCtx())
    const d = drafts.find(x => x.entitlement_type === 'small_meal')
    if (!d) return { label: 'find', pass: false, errors: ['missing draft'] }
    const errors = []
    if (d.unit !== 'dollars')         errors.push(`unit=${d.unit}`)
    if (d.generated_amount !== 10.90) errors.push(`amount=${d.generated_amount}`)
    if (d.generated_hours !== null)   errors.push('hours not null')
    if (d.payment_method !== 'petty_cash')  errors.push('payment_method')
    if (d.payment_status !== 'outstanding') errors.push('payment_status')
    return assertDraftInvariants(d, 'SB small_meal').pass
      ? { label: 'SB small_meal', pass: errors.length === 0, errors }
      : assertDraftInvariants(d, 'SB small_meal')
  },
})

SCENARIOS.push({
  name: 'SB: no small_meal when start is day-shift (hour < 19)',
  run: () => {
    const drafts = generateEntitlements(
      makeStandbyClaim(),
      makeStandbyDetails({ standby_start_at: '2026-06-01T08:00:00' }),
      makeCtx(),
    )
    const found = drafts.some(x => x.entitlement_type === 'small_meal')
    return { label: 'no small_meal on day shift', pass: !found, errors: found ? ['small_meal emitted on day shift'] : [] }
  },
})

SCENARIOS.push({
  name: 'SB: no excess_travel when standby_station equals rostered_station',
  run: () => {
    const drafts = generateEntitlements(
      makeStandbyClaim(),
      makeStandbyDetails({ standby_station_id: STATION_ROSTERED }),
      makeCtx(),
    )
    const found = drafts.some(x => x.entitlement_type === 'excess_travel_standby')
    return { label: 'no excess_travel when same station', pass: !found, errors: found ? ['emitted excess_travel for same station'] : [] }
  },
})

SCENARIOS.push({
  name: 'SB: no excess_travel when matrix lookup misses',
  run: () => {
    const drafts = generateEntitlements(
      makeStandbyClaim(),
      makeStandbyDetails({ matrix_version: 'missing' }),
      makeCtx(),
    )
    const found = drafts.some(x => x.entitlement_type === 'excess_travel_standby')
    return { label: 'no excess_travel on matrix miss', pass: !found, errors: found ? ['emitted excess_travel on matrix miss'] : [] }
  },
})

// MD: full set.
SCENARIOS.push({
  name: 'MD: emits excess_travel_md + muster_dismis',
  run: () => {
    const drafts = generateEntitlements(makeMdClaim(), makeMdDetails(), makeCtx())
    const errors = []
    if (drafts.length !== 2) errors.push(`expected 2 drafts, got ${drafts.length}`)
    const types = drafts.map(d => d.entitlement_type).sort()
    const expected = ['excess_travel_md', 'muster_dismis']
    if (JSON.stringify(types) !== JSON.stringify(expected)) {
      errors.push(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(types)}`)
    }
    return { label: 'MD full set', pass: errors.length === 0, errors }
  },
})

SCENARIOS.push({
  name: 'MD: excess_travel_md is hours-first matrix row',
  run: () => {
    const drafts = generateEntitlements(makeMdClaim(), makeMdDetails(), makeCtx())
    const d = drafts.find(x => x.entitlement_type === 'excess_travel_md')
    if (!d) return { label: 'find', pass: false, errors: ['missing draft'] }
    const errors = []
    if (d.unit !== 'hours')          errors.push(`unit=${d.unit}`)
    if (d.generated_hours !== 1.25)  errors.push(`hours=${d.generated_hours}`)
    if (d.generated_amount !== null) errors.push('amount not null')
    return assertDraftInvariants(d, 'MD excess_travel_md').pass
      ? { label: 'MD excess_travel_md', pass: errors.length === 0, errors }
      : assertDraftInvariants(d, 'MD excess_travel_md')
  },
})

SCENARIOS.push({
  name: 'MD: muster_dismis is hours-first 1.0h fixed',
  run: () => {
    const drafts = generateEntitlements(makeMdClaim(), makeMdDetails(), makeCtx())
    const d = drafts.find(x => x.entitlement_type === 'muster_dismis')
    if (!d) return { label: 'find', pass: false, errors: ['missing draft'] }
    const errors = []
    if (d.generated_hours !== 1.0)   errors.push(`hours=${d.generated_hours}`)
    if (d.generated_amount !== null) errors.push('amount not null')
    if (d.rate_id !== 'rate-md_hours') errors.push('rate_id')
    return assertDraftInvariants(d, 'MD muster_dismis').pass
      ? { label: 'MD muster_dismis', pass: errors.length === 0, errors }
      : assertDraftInvariants(d, 'MD muster_dismis')
  },
})

// No-op scaffolds.
SCENARIOS.push({
  name: 'RC/RT/DM/SM generators are no-op scaffolds returning []',
  run: () => {
    const ctx = makeCtx()
    const errors = []
    for (const claimType of ['RC', 'RT', 'DM', 'SM']) {
      const claim = makeStandbyClaim({ claim_type: claimType })
      const drafts = generateEntitlements(claim, {}, ctx)
      if (!Array.isArray(drafts) || drafts.length !== 0) {
        errors.push(`${claimType}: expected [], got ${JSON.stringify(drafts)}`)
      }
    }
    return { label: 'no-op scaffolds', pass: errors.length === 0, errors }
  },
})

// Engine refuses unknown claim type.
SCENARIOS.push({
  name: 'generateEntitlements throws on unknown claim_type',
  run: () => {
    let threw = false
    try {
      generateEntitlements(makeStandbyClaim({ claim_type: 'XX' }), {}, makeCtx())
    } catch {
      threw = true
    }
    return { label: 'unknown claim_type throws', pass: threw, errors: threw ? [] : ['did not throw'] }
  },
})

// Helper contracts (§ 4).
SCENARIOS.push({
  name: 'effectiveAmount returns edited ?? generated, null for hours-first',
  run: () => {
    const errors = []
    if (effectiveAmount({ edited_amount: null, generated_amount: 10.90 }) !== 10.90) errors.push('dollars row')
    if (effectiveAmount({ edited_amount: 9.50, generated_amount: 10.90 }) !== 9.50)  errors.push('edited override')
    if (effectiveAmount({ edited_amount: null, generated_amount: null })  !== null)  errors.push('hours-first returns null')
    return { label: 'effectiveAmount', pass: errors.length === 0, errors }
  },
})

SCENARIOS.push({
  name: 'effectiveHours returns edited ?? generated, null for dollars-first',
  run: () => {
    const errors = []
    if (effectiveHours({ edited_hours: null, generated_hours: 0.5 }) !== 0.5)  errors.push('hours row')
    if (effectiveHours({ edited_hours: 0.25, generated_hours: 0.5 }) !== 0.25) errors.push('edited override')
    if (effectiveHours({ edited_hours: null, generated_hours: null }) !== null) errors.push('dollars-first returns null')
    return { label: 'effectiveHours', pass: errors.length === 0, errors }
  },
})

SCENARIOS.push({
  name: 'effectivePayable throws on hours-first row',
  run: () => {
    let threw = false
    try {
      effectivePayable({ edited_amount: null, generated_amount: null })
    } catch {
      threw = true
    }
    return { label: 'effectivePayable hours-first guard', pass: threw, errors: threw ? [] : ['did not throw'] }
  },
})

SCENARIOS.push({
  name: 'isManualOverride mirrors edited_* IS NOT NULL',
  run: () => {
    const errors = []
    if (isManualOverride({ edited_amount: null, edited_hours: null }) !== false) errors.push('all null → false')
    if (isManualOverride({ edited_amount: 1,    edited_hours: null }) !== true)  errors.push('amount set → true')
    if (isManualOverride({ edited_amount: null, edited_hours: 0.5  }) !== true)  errors.push('hours set → true')
    return { label: 'isManualOverride', pass: errors.length === 0, errors }
  },
})

// ─── Runner ──────────────────────────────────────────────────────────────────

export function runDraftValidation() {
  const results = SCENARIOS.map((scenario) => {
    try {
      const result = scenario.run()
      return { ...result, scenarioName: scenario.name }
    } catch (err) {
      return {
        scenarioName: scenario.name,
        label:        'ERROR',
        pass:         false,
        errors:       [err.message],
      }
    }
  })
  const passed = results.filter((r) => r.pass).length
  const failed = results.filter((r) => !r.pass).length
  return { results, passed, failed, total: results.length }
}

// CLI entry point — `node lib/fat/engine/validateDrafts.js`.
if (typeof process !== 'undefined' && process.argv?.[1]?.includes('validateDrafts')) {
  const { results, passed, failed, total } = runDraftValidation()
  console.log('\n=== Fire Allowance Tracker — Entitlement Draft Validation ===\n')
  for (const r of results) {
    const icon = r.pass ? 'PASS' : 'FAIL'
    console.log(`[${icon}] ${r.scenarioName}`)
    if (!r.pass) for (const e of r.errors) console.log(`       - ${e}`)
  }
  console.log(`\n--- Results: ${passed}/${total} passed, ${failed} failed ---\n`)
  if (failed > 0) process.exit(1)
}

// Used by the assertion helper to bubble up structured-shape errors when a
// caller chains an inline shape check after an invariant check. Re-export so
// engine consumers can reuse the assertion in their own tests.
export { assertDraftInvariants }
