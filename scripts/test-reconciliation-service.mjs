#!/usr/bin/env node
// ─── Reconciliation service layer — DEV integration test ─────────────────────
// End-to-end proof of the Payment Records MVP service layer (migration 08 RPCs +
// lib/fat/services/*). Drives a real Standby canonical claim (via the bridge) to
// get engine-generated, pre-routed entitlements, then exercises:
//   recordPayment → linkPayment (hours-first → terminal) → audit
//   → partial then full petty-cash reconciliation (dollars-first)
//   → unlinkPayment (regress) → recompute idempotency → queue reads
//   → negative guards (allocation cap, stream mismatch, gross<0).
//
// Also asserts the pure predicates in lib/fat/models/reconciliationHelpers.js.
//
// SAFETY: DEV-ONLY. Refuses to run unless NEXT_PUBLIC_SUPABASE_URL targets DEV.
// All rows it creates are deleted on exit; the test profile's rostered_station_id
// is restored.
//
// Run:  node scripts/test-reconciliation-service.mjs
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
const { recordPayment, listPaymentRecords, getPaymentRecord } = await import('../lib/fat/services/paymentRecords.js')
const { linkPayment, unlinkPayment, recomputeEntitlementStatus } = await import('../lib/fat/services/reconciliation.js')
const {
  listPendingPayslip, listOutstandingPettyCash, listUnallocatedPayments,
  listEntitlementHistory, listNeedsRouting,
} = await import('../lib/fat/services/reconciliationQueues.js')
const helpers = await import('../lib/fat/models/reconciliationHelpers.js')

const fat = createClient(URL, KEY, { db: { schema: 'fat' } })

// ── tiny assert harness ─────────────────────────────────────────────────────
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
  console.log('Reconciliation service layer — DEV integration test\n')

  // ── Pure predicate unit checks (no DB) ──────────────────────────────────────
  console.log('UNIT: pure predicates (reconciliationHelpers)')
  const hoursEnt = { unit: 'hours', payment_method: 'payslip', generated_hours: 0.5 }
  const dollarsEnt = { unit: 'dollars', payment_method: 'petty_cash', generated_amount: 20 }
  check('hours terminal with 1 manual link', helpers.isTerminal(hoursEnt, [{ link_kind: 'manual', allocated_amount: 0 }]))
  check('hours NOT terminal with only discrepancy_note', !helpers.isTerminal(hoursEnt, [{ link_kind: 'discrepancy_note', allocated_amount: 0 }]))
  check('dollars terminal at exact effective', helpers.isTerminal(dollarsEnt, [{ link_kind: 'manual', allocated_amount: 20 }]))
  check('dollars terminal within $0.01 tolerance', helpers.isTerminal(dollarsEnt, [{ link_kind: 'manual', allocated_amount: 19.99 }]))
  check('dollars NOT terminal below tolerance', !helpers.isTerminal(dollarsEnt, [{ link_kind: 'manual', allocated_amount: 19.0 }]))
  check('derived = partially_reimbursed for partial petty cash',
    helpers.evaluateDerivedStatus(dollarsEnt, [{ link_kind: 'manual', allocated_amount: 10 }]) === 'partially_reimbursed')
  check('derived = reimbursed for full petty cash',
    helpers.evaluateDerivedStatus(dollarsEnt, [{ link_kind: 'manual', allocated_amount: 20 }]) === 'reimbursed')
  check('derived = pending for unallocated payslip hours',
    helpers.evaluateDerivedStatus(hoursEnt, []) === 'pending')
  check('sumAllocated ignores discrepancy_note',
    helpers.sumAllocated([{ link_kind: 'manual', allocated_amount: 5 }, { link_kind: 'discrepancy_note', allocated_amount: 99 }]) === 5)

  // ── Fixtures: matrix cell + station pair + a test profile ───────────────────
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
  const createdRecordIds = []
  try {
    await fat.from('profiles').update({ rostered_station_id: A }).eq('id', owner.id)
    const claimDate = '2026-06-18'

    // ── Generate a Standby claim → 3 pre-routed entitlements ──────────────────
    console.log('\nSETUP: generate Standby canonical claim (excess_travel + standby_dismi + small_meal)')
    const sb = await mirrorClaimToCanonical({
      client: fat, userId: owner.id, claimType: 'standby', date: claimDate,
      fields: { rosteredStn: labelA, standbyStn: labelB, arrivedTime: '20:00', shift: 'Night', standbyType: 'Standby' },
    })
    if (sb.claimId) createdClaimIds.push(sb.claimId)
    check('claim mirrored with 3 entitlements', sb.mirrored && sb.entitlements === 3, JSON.stringify(sb))

    const { data: ents } = await fat.from('claim_entitlements').select('*').eq('claim_id', sb.claimId)
    const excess = byType(ents, 'excess_travel_standby')   // hours-first, payslip
    const dismi  = byType(ents, 'standby_dismi')            // hours-first, payslip
    const meal   = byType(ents, 'small_meal')               // dollars-first, petty_cash
    check('excess routed payslip/pending', excess?.payment_method === 'payslip' && excess?.payment_status === 'pending')
    check('small_meal routed petty_cash/outstanding', meal?.payment_method === 'petty_cash' && meal?.payment_status === 'outstanding')
    check('small_meal has a dollar amount', Number(meal?.generated_amount) > 0, `got ${meal?.generated_amount}`)

    // ── PHASE B: recordPayment (create) + retrieval ───────────────────────────
    console.log('\nTEST: recordPayment + retrieval (§ 9.3)')
    const payslipRec = await recordPayment({
      ownerId: owner.id, stream: 'payslip', recordDate: claimDate,
      grossAmount: 100.00, source: 'manual', reference: 'PAYSLIP-LINE-001',
    }, fat)
    createdRecordIds.push(payslipRec.id)
    check('payslip record created', !!payslipRec.id && payslipRec.stream === 'payslip')
    const fetched = await getPaymentRecord(payslipRec.id, fat)
    check('getPaymentRecord returns the row', fetched?.id === payslipRec.id)
    const listed = await listPaymentRecords(owner.id, { stream: 'payslip' }, fat)
    check('listPaymentRecords includes it', listed.some((r) => r.id === payslipRec.id))

    await expectThrow('recordPayment rejects gross<0 (JS guard)',
      () => recordPayment({ ownerId: owner.id, stream: 'payslip', recordDate: claimDate, grossAmount: -5, source: 'manual' }, fat))

    // ── unallocated queue: record present before linking ──────────────────────
    let unalloc = await listUnallocatedPayments(owner.id, fat)
    check('payslip record is unallocated before linking', unalloc.some((r) => r.id === payslipRec.id))

    // ── PHASE C: linkPayment hours-first → terminal 'paid' + audit ────────────
    console.log('\nTEST: linkPayment hours-first → paid (§ 9.5 / § 5.5)')
    const beforePending = await listPendingPayslip(owner.id, fat)
    check('excess in pending-payslip queue before link', beforePending.some((e) => e.id === excess.id))

    const link1 = await linkPayment({
      entitlementId: excess.id, paymentRecordId: payslipRec.id,
      allocatedAmount: 0, linkKind: 'manual', actorId: owner.id, note: 'matched payslip line',
    }, fat)
    check('link flips status pending → paid', link1.status_changed && link1.new_status === 'paid', JSON.stringify(link1))
    check('link wrote a link_payment audit row', link1.action === 'link_payment' && !!link1.audit_id)

    const { data: excessAfter } = await fat.from('claim_entitlements').select('payment_status').eq('id', excess.id).maybeSingle()
    check('entitlement persisted as paid', excessAfter?.payment_status === 'paid')

    const hist = await listEntitlementHistory(excess.id, {}, fat)
    check('history shows 1 link + 1 audit + derived paid',
      hist.links.length === 1 && hist.audit_history.length === 1 && hist.derived_status === 'paid',
      `links=${hist.links.length} audit=${hist.audit_history.length} derived=${hist.derived_status}`)

    unalloc = await listUnallocatedPayments(owner.id, fat)
    check('payslip record no longer unallocated after link', !unalloc.some((r) => r.id === payslipRec.id))

    // ── dollars-first: partial then full petty-cash reconciliation ────────────
    console.log('\nTEST: dollars-first partial → full petty cash (§ 5.5 tolerance)')
    const mealAmt = Number(meal.generated_amount)
    const pcA = await recordPayment({ ownerId: owner.id, stream: 'petty_cash', recordDate: claimDate, grossAmount: mealAmt, source: 'manual', reference: 'PC-A' }, fat)
    const pcB = await recordPayment({ ownerId: owner.id, stream: 'petty_cash', recordDate: claimDate, grossAmount: mealAmt, source: 'manual', reference: 'PC-B' }, fat)
    createdRecordIds.push(pcA.id, pcB.id)

    const half = Math.round((mealAmt / 2) * 100) / 100
    const partial = await linkPayment({ entitlementId: meal.id, paymentRecordId: pcA.id, allocatedAmount: half, linkKind: 'manual', actorId: owner.id }, fat)
    check('partial petty-cash link stays outstanding', !partial.status_changed && partial.new_status === 'outstanding', JSON.stringify(partial))
    const histPartial = await listEntitlementHistory(meal.id, {}, fat)
    check('derived = partially_reimbursed after partial', histPartial.derived_status === 'partially_reimbursed', histPartial.derived_status)

    const remainder = Math.round((mealAmt - half) * 100) / 100
    const full = await linkPayment({ entitlementId: meal.id, paymentRecordId: pcB.id, allocatedAmount: remainder, linkKind: 'manual', actorId: owner.id }, fat)
    check('full petty-cash link flips outstanding → claimed', full.status_changed && full.new_status === 'claimed', JSON.stringify(full))
    const outstanding = await listOutstandingPettyCash(owner.id, fat)
    check('small_meal left outstanding queue', !outstanding.some((e) => e.id === meal.id))

    // ── discrepancy_note: no status change, note_discrepancy audit ────────────
    console.log('\nTEST: discrepancy_note link (§ 5.3 / § 6)')
    const noteLink = await linkPayment({
      entitlementId: dismi.id, paymentRecordId: payslipRec.id, allocatedAmount: 0,
      linkKind: 'discrepancy_note', actorId: owner.id, note: 'related but not counted',
    }, fat)
    check('discrepancy_note → note_discrepancy, no status change', noteLink.action === 'note_discrepancy' && !noteLink.status_changed, JSON.stringify(noteLink))
    const { data: dismiAfter } = await fat.from('claim_entitlements').select('payment_status').eq('id', dismi.id).maybeSingle()
    check('standby_dismi still pending (note not status-eligible)', dismiAfter?.payment_status === 'pending')

    // ── unlinkPayment → regress hours-first to pending ────────────────────────
    console.log('\nTEST: unlinkPayment → regress (§ 9.5)')
    const unlink = await unlinkPayment({ linkId: link1.link_id, actorId: owner.id, reason: 'mis-matched' }, fat)
    check('unlink regresses paid → pending', unlink.status_changed && unlink.new_status === 'pending', JSON.stringify(unlink))
    check('unlink wrote unlink_payment audit', unlink.action === 'unlink_payment' && !!unlink.audit_id)
    const afterPending = await listPendingPayslip(owner.id, fat)
    check('excess back in pending-payslip queue', afterPending.some((e) => e.id === excess.id))

    // ── recompute idempotency ─────────────────────────────────────────────────
    console.log('\nTEST: recomputeEntitlementStatus idempotency (§ 9.6)')
    const recompute = await recomputeEntitlementStatus({ entitlementId: meal.id, actorId: owner.id, trigger: 'manual' }, fat)
    check('recompute on settled meal is a no-op', !recompute.status_changed && recompute.new_status === 'claimed', JSON.stringify(recompute))

    // ── negative guards ───────────────────────────────────────────────────────
    console.log('\nTEST: server-side guards')
    await expectThrow('allocation cap rejects over-allocation',
      () => linkPayment({ entitlementId: excess.id, paymentRecordId: payslipRec.id, allocatedAmount: 999, linkKind: 'manual', actorId: owner.id }, fat))
    await expectThrow('stream mismatch rejected (petty_cash record → payslip entitlement)',
      () => linkPayment({ entitlementId: excess.id, paymentRecordId: pcA.id, allocatedAmount: 0, linkKind: 'manual', actorId: owner.id }, fat))

    // ── needs-routing queue should be empty for these pre-routed entitlements ──
    const needsRouting = await listNeedsRouting(owner.id, fat)
    check('pre-routed SB entitlements are NOT in needs-routing queue',
      ![excess.id, dismi.id, meal.id].some((id) => needsRouting.some((e) => e.id === id)))

  } finally {
    console.log('\nCleanup...')
    for (const id of createdRecordIds) {
      const { error } = await fat.from('payment_records').delete().eq('id', id)
      if (error) console.error(`  cleanup warning (record ${id}): ${error.message}`)
    }
    for (const id of createdClaimIds) {
      const { error } = await fat.from('operational_claims').delete().eq('id', id)
      if (error) console.error(`  cleanup warning (claim ${id}): ${error.message}`)
    }
    await fat.from('profiles').update({ rostered_station_id: priorRostered }).eq('id', owner.id)
    console.log(`  deleted ${createdRecordIds.length} record(s), ${createdClaimIds.length} claim(s); restored rostered_station_id=${priorRostered}`)
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
