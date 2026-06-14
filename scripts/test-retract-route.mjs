#!/usr/bin/env node
// ─── retractPayment + routeEntitlement — DEV integration test ────────────────
// Proves the two reconciliation helpers the OCR Payslip Import architecture
// depends on (Steps F + G of the payment-records roadmap; migration 09 RPCs):
//
//   routeEntitlement  (§ 9.1): NULL → stream, set_payment_method audit, initial
//                              status; refuses an already-routed entitlement.
//   retractPayment    (§ 9.4): hard-delete record + cascade links, recompute +
//                              one unlink_payment audit row per DISTINCT
//                              formerly-linked entitlement; regress when the
//                              remaining links no longer hold terminal; no-op
//                              audit for an unallocated record; combined record
//                              (2 entitlements) → 2 audit rows.
//
// Also re-checks link + unlink still behave (the four actions the task names).
//
// SAFETY: DEV-ONLY. Refuses unless NEXT_PUBLIC_SUPABASE_URL targets DEV. Every row
// it creates is deleted on exit; the test profile's rostered_station_id is restored.
//
// Run:  node scripts/test-retract-route.mjs
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
const { recordPayment, retractPayment, getPaymentRecord } = await import('../lib/fat/services/paymentRecords.js')
const { linkPayment, unlinkPayment, routeEntitlement } = await import('../lib/fat/services/reconciliation.js')
const { listNeedsRouting, listPendingPayslip, listEntitlementHistory } = await import('../lib/fat/services/reconciliationQueues.js')

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
const auditCount = async (entId, action) => {
  const { data } = await fat.from('reconciliation_audit').select('id').eq('entitlement_id', entId).eq('action', action)
  return (data ?? []).length
}

async function main() {
  console.log('retractPayment + routeEntitlement — DEV integration test\n')

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
    const claimDate = '2026-06-19'

    console.log('SETUP: generate Standby canonical claim (excess_travel + standby_dismi + small_meal)')
    const sb = await mirrorClaimToCanonical({
      client: fat, userId: owner.id, claimType: 'standby', date: claimDate,
      fields: { rosteredStn: labelA, standbyStn: labelB, arrivedTime: '20:00', shift: 'Night', standbyType: 'Standby' },
    })
    if (sb.claimId) createdClaimIds.push(sb.claimId)
    check('claim mirrored with 3 entitlements', sb.mirrored && sb.entitlements === 3, JSON.stringify(sb))

    const { data: ents } = await fat.from('claim_entitlements').select('*').eq('claim_id', sb.claimId)
    const excess = byType(ents, 'excess_travel_standby')   // hours-first, payslip
    const dismi  = byType(ents, 'standby_dismi')           // hours-first, payslip
    const meal   = byType(ents, 'small_meal')              // dollars-first, petty_cash

    // ════════════════════════════════════════════════════════════════════════
    // ROUTE: routeEntitlement (§ 9.1)
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: routeEntitlement NULL → payslip (§ 9.1)')
    // SB/MD entitlements arrive PRE-routed, so simulate a deferred-routing
    // (Recall/Retain-style) child by clearing the routing on `dismi` first.
    await fat.from('claim_entitlements').update({ payment_method: null, payment_status: null }).eq('id', dismi.id)
    const needsBefore = await listNeedsRouting(owner.id, fat)
    check('unrouted entitlement appears in needs-routing queue', needsBefore.some((e) => e.id === dismi.id))

    const routed = await routeEntitlement({ entitlementId: dismi.id, stream: 'payslip', actorId: owner.id, reason: 'operator routed to payslip' }, fat)
    check('route returns set_payment_method / pending', routed.action === 'set_payment_method' && routed.new_status === 'pending' && routed.payment_method === 'payslip', JSON.stringify(routed))
    check('route prior_status is null', routed.prior_status === null)
    check('route wrote a set_payment_method audit row', !!routed.audit_id)

    const { data: dismiAfter } = await fat.from('claim_entitlements').select('payment_method, payment_status').eq('id', dismi.id).maybeSingle()
    check('entitlement persisted as payslip/pending', dismiAfter?.payment_method === 'payslip' && dismiAfter?.payment_status === 'pending')

    const needsAfter = await listNeedsRouting(owner.id, fat)
    check('routed entitlement left needs-routing queue', !needsAfter.some((e) => e.id === dismi.id))
    const pendingNow = await listPendingPayslip(owner.id, fat)
    check('routed entitlement now in pending-payslip queue', pendingNow.some((e) => e.id === dismi.id))

    console.log('\nTEST: routeEntitlement guards')
    await expectThrow('route refuses an already-routed entitlement', () =>
      routeEntitlement({ entitlementId: dismi.id, stream: 'petty_cash', actorId: owner.id }, fat))
    await expectThrow('route rejects an invalid stream (JS guard)', () =>
      routeEntitlement({ entitlementId: excess.id, stream: 'bank_transfer', actorId: owner.id }, fat))

    // ════════════════════════════════════════════════════════════════════════
    // LINK + RETRACT (regress): hours-first excess (§ 9.5 link, § 9.4 retract)
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: link then retractPayment regresses the entitlement (§ 9.4)')
    const rec1 = await recordPayment({ ownerId: owner.id, stream: 'payslip', recordDate: claimDate, grossAmount: 50, source: 'manual', reference: 'RETRACT-1' }, fat)
    createdRecordIds.push(rec1.id)
    const link1 = await linkPayment({ entitlementId: excess.id, paymentRecordId: rec1.id, allocatedAmount: 0, linkKind: 'manual', actorId: owner.id }, fat)
    check('link flips excess pending → paid', link1.status_changed && link1.new_status === 'paid', JSON.stringify(link1))

    const unlinkAuditBefore = await auditCount(excess.id, 'unlink_payment')
    const retract1 = await retractPayment({ paymentRecordId: rec1.id, actorId: owner.id, reason: 'OCR misread amount' }, fat)
    check('retract recomputed exactly 1 entitlement', retract1.entitlements_recomputed === 1, JSON.stringify(retract1))
    check('retract wrote exactly 1 audit row', retract1.audit_rows_written === 1, JSON.stringify(retract1))

    const gone = await getPaymentRecord(rec1.id, fat)
    check('payment record is hard-deleted', gone === null)
    createdRecordIds.splice(createdRecordIds.indexOf(rec1.id), 1) // already gone

    const { data: excessAfter } = await fat.from('claim_entitlements').select('payment_status').eq('id', excess.id).maybeSingle()
    check('excess regressed paid → pending after retract', excessAfter?.payment_status === 'pending', excessAfter?.payment_status)
    const unlinkAuditAfter = await auditCount(excess.id, 'unlink_payment')
    check('retract appended one unlink_payment audit row', unlinkAuditAfter === unlinkAuditBefore + 1)

    const hist = await listEntitlementHistory(excess.id, {}, fat)
    check('links cascade-removed (history shows 0 links)', hist.links.length === 0, `links=${hist.links.length}`)
    check('derived status back to pending', hist.derived_status === 'pending', hist.derived_status)

    // ════════════════════════════════════════════════════════════════════════
    // RETRACT of an unallocated record → no recompute, no audit (§ 4.3)
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: retractPayment on an unallocated record (§ 4.3)')
    const rec2 = await recordPayment({ ownerId: owner.id, stream: 'payslip', recordDate: claimDate, grossAmount: 25, source: 'manual', reference: 'UNALLOC' }, fat)
    createdRecordIds.push(rec2.id)
    const retract2 = await retractPayment({ paymentRecordId: rec2.id, actorId: owner.id }, fat)
    check('unallocated retract recomputed 0 entitlements', retract2.entitlements_recomputed === 0, JSON.stringify(retract2))
    check('unallocated retract wrote 0 audit rows', retract2.audit_rows_written === 0, JSON.stringify(retract2))
    createdRecordIds.splice(createdRecordIds.indexOf(rec2.id), 1)

    // ════════════════════════════════════════════════════════════════════════
    // RETRACT of a COMBINED record (2 entitlements) → 2 audit rows (§ 6.3)
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: retractPayment on a combined record → 1 row per DISTINCT entitlement (§ 6.3)')
    const rec3 = await recordPayment({ ownerId: owner.id, stream: 'payslip', recordDate: claimDate, grossAmount: 80, source: 'manual', reference: 'COMBINED' }, fat)
    createdRecordIds.push(rec3.id)
    // One record settling two hours-first payslip entitlements (excess + dismi), each
    // with its own (zero) allocation — the combined-payment capability (§ 5.4).
    const cl1 = await linkPayment({ entitlementId: excess.id, paymentRecordId: rec3.id, allocatedAmount: 0, linkKind: 'manual', actorId: owner.id }, fat)
    const cl2 = await linkPayment({ entitlementId: dismi.id,  paymentRecordId: rec3.id, allocatedAmount: 0, linkKind: 'manual', actorId: owner.id }, fat)
    check('both entitlements flipped to paid by the combined record', cl1.new_status === 'paid' && cl2.new_status === 'paid')
    // Add a non-status-eligible discrepancy_note on excess to the SAME record — DISTINCT
    // must still collapse excess to a single recompute + audit row.
    await linkPayment({ entitlementId: excess.id, paymentRecordId: rec3.id, allocatedAmount: 0, linkKind: 'discrepancy_note', actorId: owner.id, note: 'fyi' }, fat)

    const retract3 = await retractPayment({ paymentRecordId: rec3.id, actorId: owner.id, reason: 'duplicate batch' }, fat)
    check('combined retract recomputed exactly 2 DISTINCT entitlements', retract3.entitlements_recomputed === 2, JSON.stringify(retract3))
    check('combined retract wrote exactly 2 audit rows', retract3.audit_rows_written === 2, JSON.stringify(retract3))
    const { data: bothAfter } = await fat.from('claim_entitlements').select('id, payment_status').in('id', [excess.id, dismi.id])
    check('both entitlements regressed to pending', bothAfter.every((e) => e.payment_status === 'pending'), JSON.stringify(bothAfter))
    createdRecordIds.splice(createdRecordIds.indexOf(rec3.id), 1)

    // ════════════════════════════════════════════════════════════════════════
    // UNLINK still works (preserve existing behaviour) + retract guards
    // ════════════════════════════════════════════════════════════════════════
    console.log('\nTEST: unlink preserved + retract guards')
    const rec4 = await recordPayment({ ownerId: owner.id, stream: 'payslip', recordDate: claimDate, grossAmount: 10, source: 'manual', reference: 'UNLINK' }, fat)
    createdRecordIds.push(rec4.id)
    const link4 = await linkPayment({ entitlementId: excess.id, paymentRecordId: rec4.id, allocatedAmount: 0, linkKind: 'manual', actorId: owner.id }, fat)
    const unlink4 = await unlinkPayment({ linkId: link4.link_id, actorId: owner.id, reason: 'manual unlink' }, fat)
    check('unlink regresses paid → pending', unlink4.status_changed && unlink4.new_status === 'pending', JSON.stringify(unlink4))
    check('unlink wrote unlink_payment audit', unlink4.action === 'unlink_payment' && !!unlink4.audit_id)

    await expectThrow('retract rejects a missing record', () =>
      retractPayment({ paymentRecordId: '00000000-0000-0000-0000-000000000000', actorId: owner.id }, fat))

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
    console.log(`  deleted ${createdRecordIds.length} leftover record(s), ${createdClaimIds.length} claim(s); restored rostered_station_id=${priorRostered}`)
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
