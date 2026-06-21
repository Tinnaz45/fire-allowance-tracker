#!/usr/bin/env node
// ─── Manual-entry Payments launch-blocker fixes (P1-1, P1-2, P1-4) — DEV test ──
// Proves the audit P1 fixes applied in migrations 15–18 against DEV:
//
//   P1-1  claim_entitlements.payment_status CHECK constraint (migration 15) —
//         the DB rejects off-vocabulary status; NULL + the 4 canonical values pass.
//   P1-2  retract_payment re-opens a settled payslip line (migration 18) — after
//         retract, a previously confirmed line returns to 'needs_review' (record +
//         link pointers cleared) and is re-confirmable; the parent import re-opens;
//         the entitlement regresses; the unlink_payment audit row is preserved.
//   P1-4  the duplicate-confirm advisory lock (migration 17) does not break the
//         guard or the operator override (regression guard for the locked path).
//
// (P1-3's row lock and P1-5's route gate are not covered here: P1-3 is a concurrency
// serialization whose sequential behaviour is already proven by the allocation-cap
// assertions in test-reconciliation-service.mjs, and P1-5 is an HTTP-layer change
// proven by test-feature-flags.mjs + the route's own gate. See the report.)
//
// SAFETY: DEV-ONLY. Refuses unless NEXT_PUBLIC_SUPABASE_URL targets DEV. Every row
// it creates is deleted on exit; the test profile's rostered_station_id is restored.
//
// Run:  node scripts/test-p1-fixes.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'

const DEV_REF = 'kctctvpobbizhkiqkgqw'

try { process.loadEnvFile('.env.local') } catch { /* fall back to ambient env */ }
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env.local).')
  process.exit(2)
}
if (!URL.includes(DEV_REF)) {
  console.error(`REFUSING TO RUN: NEXT_PUBLIC_SUPABASE_URL does not target DEV (${DEV_REF}). Got: ${URL}`)
  process.exit(2)
}

const { mirrorClaimToCanonical } = await import('../lib/claims/canonicalBridge.js')
const { retractPayment, getPaymentRecord } = await import('../lib/fat/services/paymentRecords.js')
const {
  createManualEntryImport, confirmImportLine, getImport, listImportLines,
} = await import('../lib/fat/services/payslipImports.js')

const fat = createClient(URL, KEY, { db: { schema: 'fat' } })

let passed = 0, failed = 0
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
async function expectThrow(label, fn) {
  try { await fn(); check(label, false, 'expected throw, got success') }
  catch { check(label, true) }
}
const byType = (rows, t) => rows.find((r) => r.entitlement_type === t)

async function main() {
  console.log('Manual-entry Payments launch-blocker fixes (P1-1/2/4) — DEV integration test\n')

  // ── Fixtures: a Standby canonical claim (SB excess travel = payslip-routed) ──
  const { data: cellRows } = await fat
    .from('station_time_matrix')
    .select('from_station_id, to_station_id, hours, matrix_version')
    .neq('from_station_id', 0).limit(1)
  if (!cellRows?.length) throw new Error('No station_time_matrix cells — cannot generate excess travel.')
  const { from_station_id: A, to_station_id: B } = cellRows[0]
  const { data: stnA } = await fat.from('stations').select('name').eq('id', A).maybeSingle()
  const { data: stnB } = await fat.from('stations').select('name').eq('id', B).maybeSingle()
  const labelA = `FS${A} - ${stnA?.name ?? ''}`.trim()
  const labelB = `FS${B} - ${stnB?.name ?? ''}`.trim()

  const { data: profiles } = await fat.from('profiles').select('id, rostered_station_id').limit(1)
  if (!profiles?.length) throw new Error('No fat.profiles rows in DEV.')
  const owner = profiles[0]
  const priorRostered = owner.rostered_station_id ?? null

  const createdClaimIds = []
  const createdImportIds = []
  const createdRecordIds = []
  try {
    await fat.from('profiles').update({ rostered_station_id: A }).eq('id', owner.id)
    const claimDate = '2026-06-19'

    const sb = await mirrorClaimToCanonical({
      client: fat, userId: owner.id, claimType: 'standby', date: claimDate,
      fields: { rosteredStn: labelA, standbyStn: labelB, arrivedTime: '20:00', shift: 'Night', standbyType: 'Standby' },
    })
    if (sb.claimId) createdClaimIds.push(sb.claimId)
    const { data: ents } = await fat.from('claim_entitlements').select('*').eq('claim_id', sb.claimId)
    const excess = byType(ents, 'excess_travel_standby')
    if (!excess) throw new Error('No excess_travel_standby entitlement generated.')
    const origStatus = excess.payment_status

    // ════════════════════════════════════════════════════════════════════════
    // P1-1 — payment_status CHECK constraint (migration 15)
    // ════════════════════════════════════════════════════════════════════════
    console.log('P1-1: claim_entitlements.payment_status CHECK constraint')
    {
      const { error } = await fat.from('claim_entitlements')
        .update({ payment_status: 'not_a_status' }).eq('id', excess.id)
      check('DB rejects an off-vocabulary payment_status', !!error,
        error ? '' : 'update unexpectedly succeeded')
      check('rejection is a check_violation (23514)', error?.code === '23514', error?.code)
    }
    {
      const { error } = await fat.from('claim_entitlements')
        .update({ payment_status: 'paid' }).eq('id', excess.id)
      check('DB accepts a canonical value (paid)', !error, error?.message)
    }
    {
      const { error } = await fat.from('claim_entitlements')
        .update({ payment_status: null }).eq('id', excess.id)
      check('DB accepts NULL (unrouted has no status yet)', !error, error?.message)
    }
    // restore the entitlement to its generated status so the rest of the flow is clean
    await fat.from('claim_entitlements').update({ payment_status: origStatus }).eq('id', excess.id)

    // ════════════════════════════════════════════════════════════════════════
    // P1-2 — retract_payment re-opens the settled line; re-confirm works
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nP1-2: retract → re-confirm a previously confirmed payslip line')
    const { import: imp, lines } = await createManualEntryImport({
      ownerId: owner.id,
      form: {
        pay_date: claimDate, pay_period_ref: 'PP-13',
        lines: [{ reference: 'EXCESS TRAVEL', description: 'excess travel SB', amount: '50.00', date: claimDate }],
      },
    }, fat)
    createdImportIds.push(imp.id)
    const line = lines[0]

    // confirm (linked) → record + entitlement paid + line/import confirmed
    const c1 = await confirmImportLine({
      lineId: line.id, actorId: owner.id, entitlementId: excess.id, linkKind: 'manual', allocatedAmount: 0,
    }, fat)
    createdRecordIds.push(c1.payment_record_id)
    check('initial confirm minted a record', !!c1.payment_record_id && c1.idempotent === false)
    check('initial confirm flipped entitlement → paid', c1.link_result?.new_status === 'paid')
    const impAfterConfirm = await getImport(imp.id, fat)
    check('import reached confirmed (single line resolved)', impAfterConfirm.status === 'confirmed', impAfterConfirm.status)

    // retract the record
    const r = await retractPayment({ paymentRecordId: c1.payment_record_id, actorId: owner.id, reason: 'P1-2 test retract' }, fat)
    check('retract reports lines_reopened = 1 (the new field)', r.lines_reopened === 1, JSON.stringify(r))
    check('retract still recomputed the entitlement', r.entitlements_recomputed === 1, JSON.stringify(r))
    check('retract preserved the unlink_payment audit (audit_rows_written ≥ 1)', r.audit_rows_written >= 1)

    const goneRec = await getPaymentRecord(c1.payment_record_id, fat)
    check('payment record is hard-deleted by retract', goneRec === null)

    const { data: lineAfterRetract } = await fat.from('payslip_import_lines').select('*').eq('id', line.id).maybeSingle()
    check('LINE re-opened to needs_review (was the stuck-confirmed bug)', lineAfterRetract.status === 'needs_review', lineAfterRetract.status)
    check('line payment_record_id cleared', lineAfterRetract.payment_record_id === null)
    check('line link_id cleared', lineAfterRetract.link_id === null)
    check('line confirmed_at cleared', lineAfterRetract.confirmed_at === null)

    const impAfterRetract = await getImport(imp.id, fat)
    check('parent import re-opened to needs_review', impAfterRetract.status === 'needs_review', impAfterRetract.status)

    const { data: entAfterRetract } = await fat.from('claim_entitlements').select('payment_status').eq('id', excess.id).maybeSingle()
    check('entitlement regressed off paid', entAfterRetract.payment_status !== 'paid', entAfterRetract.payment_status)

    const { data: unlinkAudit } = await fat.from('reconciliation_audit').select('*').eq('entitlement_id', excess.id).eq('action', 'unlink_payment')
    check('unlink_payment audit row preserved', (unlinkAudit ?? []).length >= 1)

    // re-confirm the SAME line — this used to be impossible (status stuck at confirmed)
    const c2 = await confirmImportLine({
      lineId: line.id, actorId: owner.id, entitlementId: excess.id, linkKind: 'manual', allocatedAmount: 0,
    }, fat)
    createdRecordIds.push(c2.payment_record_id)
    check('RE-CONFIRM succeeds (not blocked, not idempotent)', !!c2.payment_record_id && c2.idempotent === false, JSON.stringify(c2))
    check('re-confirm minted a NEW record (different id)', c2.payment_record_id !== c1.payment_record_id)
    check('re-confirm flipped entitlement → paid again', c2.link_result?.new_status === 'paid')

    // ════════════════════════════════════════════════════════════════════════
    // P1-4 — advisory lock did not break the dup guard or the override
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nP1-4: duplicate-confirm guard + override still work under the advisory lock')
    const { import: imp2, lines: lines2 } = await createManualEntryImport({
      ownerId: owner.id,
      form: {
        pay_date: claimDate, pay_period_ref: 'PP-13',
        // identical content to the confirmed line above → same content_fingerprint
        lines: [{ reference: 'EXCESS TRAVEL', description: 'excess travel SB', amount: '50.00', date: claimDate }],
      },
    }, fat)
    createdImportIds.push(imp2.id)
    const dupLine = lines2[0]

    let dupErr = null
    try { await confirmImportLine({ lineId: dupLine.id, actorId: owner.id }, fat) }
    catch (e) { dupErr = e }
    check('duplicate confirm is blocked', !!dupErr)
    check('blocked with typed DUPLICATE_CONFIRMED', dupErr?.code === 'DUPLICATE_CONFIRMED', dupErr?.code)

    const cOverride = await confirmImportLine({ lineId: dupLine.id, actorId: owner.id, allowDuplicate: true }, fat)
    check('operator override mints a record despite the duplicate', !!cOverride.payment_record_id)
    check('override flagged duplicate_overridden = true', cOverride.duplicate_overridden === true, JSON.stringify(cOverride))
    if (cOverride.payment_record_id) createdRecordIds.push(cOverride.payment_record_id)

  } finally {
    console.log('\nCleanup...')
    for (const id of createdRecordIds) {
      const { error } = await fat.from('payment_records').delete().eq('id', id)
      if (error) console.error(`  cleanup warning (record ${id}): ${error.message}`)
    }
    for (const id of createdImportIds) {
      const { error } = await fat.from('payslip_imports').delete().eq('id', id) // cascade removes lines
      if (error) console.error(`  cleanup warning (import ${id}): ${error.message}`)
    }
    for (const id of createdClaimIds) {
      const { error } = await fat.from('operational_claims').delete().eq('id', id)
      if (error) console.error(`  cleanup warning (claim ${id}): ${error.message}`)
    }
    await fat.from('profiles').update({ rostered_station_id: priorRostered }).eq('id', owner.id)
    console.log(`  deleted ${createdRecordIds.length} record(s), ${createdImportIds.length} import(s), ${createdClaimIds.length} claim(s); restored rostered_station_id=${priorRostered}`)
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
