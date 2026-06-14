// ─── OCR Payslip Import — duplicate detection service ─────────────────────────
// The advisory half of blocker #1 (OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 4.1 /
// § 11; PAYSLIP_DUPLICATE_DETECTION_v1.0.md § 3): given an import, find existing
// imports for the same owner that it EXACTLY or NEARLY duplicates, and persist the
// finding as `duplicate_check` metadata for the review UI. This NEVER blocks or
// mutates lifecycle — it warns (objectives 4–6); the operator decides (objective 8).
// The hard, non-overridable-without-intent half (don't mint a second payment_record
// for already-confirmed content) lives in the confirm-bridge guard (migration 12),
// not here.
//
// Producer-layer, low-stakes workspace churn (§ 3.3): plain owner-scoped reads/
// writes under RLS, no canonical state touched.

import { fat as defaultClient } from '../../supabaseClient.js'
import {
  PAYSLIP_IMPORTS_TABLE,
  PAYSLIP_IMPORT_LINES_TABLE,
  IMPORT_LINE_STATUS,
} from '../models/payslipImport.js'
import {
  importContentFingerprint,
  lineSetSimilarity,
  samePayPeriod,
  DUP_THRESHOLDS,
} from '../models/payslipFingerprint.js'

// How many of the owner's prior imports to scan for a match. Bounds the work on a
// long-lived account; newest-first so the most relevant batches are always covered.
const SCAN_LIMIT = 200

const IMPORT_COLS =
  'id, owner_id, source, status, pay_date, pay_period_ref, content_fingerprint, line_count, created_at'

/** Load an import's line content_fingerprints (skips lines that have none). */
async function loadLineFingerprints(importId, client) {
  const { data, error } = await client
    .from(PAYSLIP_IMPORT_LINES_TABLE)
    .select('content_fingerprint')
    .eq('import_id', importId)
  if (error) throw new Error(`loadLineFingerprints failed: ${error.message}`)
  return (data ?? []).map((r) => r.content_fingerprint).filter(Boolean)
}

/**
 * Recompute and persist an import's import-level content fingerprint (§ 2.2) from
 * its batch metadata + its lines' (trigger-maintained) fingerprints. Idempotent.
 * Returns the fingerprint and the line-fingerprint set used.
 *
 * @returns {Promise<{ import: object, fingerprint: string, lineFingerprints: string[] }>}
 */
export async function recomputeImportFingerprint(importId, client = defaultClient) {
  if (!importId) throw new Error('recomputeImportFingerprint: importId is required.')
  const { data: imp, error } = await client
    .from(PAYSLIP_IMPORTS_TABLE).select(IMPORT_COLS).eq('id', importId).maybeSingle()
  if (error) throw new Error(`recomputeImportFingerprint failed: ${error.message}`)
  if (!imp) throw new Error(`recomputeImportFingerprint: import ${importId} not found.`)

  const lineFingerprints = await loadLineFingerprints(importId, client)
  const fingerprint = importContentFingerprint({
    source: imp.source,
    payDate: imp.pay_date,
    payPeriodRef: imp.pay_period_ref,
    lineFingerprints,
  })

  if (imp.content_fingerprint !== fingerprint) {
    const { error: uErr } = await client
      .from(PAYSLIP_IMPORTS_TABLE).update({ content_fingerprint: fingerprint }).eq('id', importId)
    if (uErr) throw new Error(`recomputeImportFingerprint (persist) failed: ${uErr.message}`)
  }
  return { import: imp, fingerprint, lineFingerprints }
}

/**
 * Detect imports the given import duplicates, EXACTLY or NEARLY (§ 3).
 *   exact — identical import fingerprint (same batch identity + same line set).
 *   near  — line-set Jaccard ≥ threshold, OR same pay period with ≥ 1 shared line.
 * Persists the result onto payslip_imports.duplicate_check (and refreshes the
 * import's content_fingerprint) unless `persist: false`. Advisory only.
 *
 * @param {object} input
 * @param {string} input.importId
 * @param {string} input.ownerId
 * @param {boolean} [input.persist=true]
 * @param {object} [client]
 * @returns {Promise<{ verdict: 'exact'|'near'|'clear', fingerprint: string,
 *                     exact: object[], near: object[], checked_at: string }>}
 */
export async function detectImportDuplicates(input, client = defaultClient) {
  const { importId, ownerId, persist = true } = input
  if (!importId) throw new Error('detectImportDuplicates: importId is required.')
  if (!ownerId) throw new Error('detectImportDuplicates: ownerId is required.')

  const { import: target, fingerprint, lineFingerprints } =
    await recomputeImportFingerprint(importId, client)

  // Candidate prior imports for this owner (exclude self), newest first.
  const { data: others, error: oErr } = await client
    .from(PAYSLIP_IMPORTS_TABLE)
    .select(IMPORT_COLS)
    .eq('owner_id', ownerId)
    .neq('id', importId)
    .order('created_at', { ascending: false })
    .limit(SCAN_LIMIT)
  if (oErr) throw new Error(`detectImportDuplicates failed: ${oErr.message}`)

  const candidates = others ?? []
  // One batched read of every candidate's line fingerprints.
  const lineMap = new Map(candidates.map((c) => [c.id, []]))
  if (candidates.length > 0) {
    const { data: lineRows, error: lErr } = await client
      .from(PAYSLIP_IMPORT_LINES_TABLE)
      .select('import_id, content_fingerprint')
      .in('import_id', candidates.map((c) => c.id))
    if (lErr) throw new Error(`detectImportDuplicates (lines) failed: ${lErr.message}`)
    for (const r of lineRows ?? []) {
      if (r.content_fingerprint) lineMap.get(r.import_id)?.push(r.content_fingerprint)
    }
  }

  const exact = []
  const near = []
  for (const cand of candidates) {
    const candFps = lineMap.get(cand.id) ?? []
    const candFingerprint = importContentFingerprint({
      source: cand.source,
      payDate: cand.pay_date,
      payPeriodRef: cand.pay_period_ref,
      lineFingerprints: candFps,
    })

    if (candFingerprint === fingerprint) {
      exact.push({
        import_id: cand.id, status: cand.status, source: cand.source,
        pay_date: cand.pay_date, pay_period_ref: cand.pay_period_ref,
        line_count: cand.line_count, created_at: cand.created_at,
      })
      continue
    }

    const sim = lineSetSimilarity(lineFingerprints, candFps)
    const periodCoincident = samePayPeriod(target, cand) && sim.shared >= DUP_THRESHOLDS.PERIOD_COINCIDENT_MIN_SHARED
    if (sim.score >= DUP_THRESHOLDS.NEAR_SIMILARITY || periodCoincident) {
      near.push({
        import_id: cand.id, status: cand.status, source: cand.source,
        pay_date: cand.pay_date, pay_period_ref: cand.pay_period_ref,
        score: sim.score, shared_lines: sim.shared, line_count: cand.line_count,
        same_pay_period: samePayPeriod(target, cand), created_at: cand.created_at,
      })
    }
  }
  // Strongest near-matches first.
  near.sort((a, b) => (b.score - a.score) || (b.shared_lines - a.shared_lines))

  const verdict = exact.length > 0 ? 'exact' : near.length > 0 ? 'near' : 'clear'
  const result = {
    checked_at: new Date().toISOString(),
    fingerprint,
    verdict,
    exact,
    near,
  }

  if (persist) {
    const { error: uErr } = await client
      .from(PAYSLIP_IMPORTS_TABLE).update({ duplicate_check: result }).eq('id', importId)
    if (uErr) throw new Error(`detectImportDuplicates (persist) failed: ${uErr.message}`)
  }
  return result
}

/**
 * The owner's already-confirmed line fingerprints (those that produced a payment
 * record) — the set the confirm-bridge guard checks against (migration 12). The
 * review UI loads this once and flags any OPEN line whose content_fingerprint is in
 * it, so the operator sees "this line was already confirmed" BEFORE attempting the
 * confirm (objective 7) — the bridge is still the authoritative backstop.
 *
 * @param {string} ownerId
 * @param {object} [client]
 * @returns {Promise<Array<{ content_fingerprint: string, line_id: string,
 *                           payment_record_id: string, import_id: string,
 *                           confirmed_at: string }>>}
 */
export async function listConfirmedLineFingerprints(ownerId, client = defaultClient) {
  if (!ownerId) throw new Error('listConfirmedLineFingerprints: ownerId is required.')
  const { data, error } = await client
    .from(PAYSLIP_IMPORT_LINES_TABLE)
    .select('id, import_id, content_fingerprint, payment_record_id, confirmed_at')
    .eq('owner_id', ownerId)
    .eq('status', IMPORT_LINE_STATUS.CONFIRMED)
    .not('payment_record_id', 'is', null)
    .not('content_fingerprint', 'is', null)
  if (error) throw new Error(`listConfirmedLineFingerprints failed: ${error.message}`)
  return (data ?? []).map((r) => ({
    content_fingerprint: r.content_fingerprint,
    line_id: r.id,
    import_id: r.import_id,
    payment_record_id: r.payment_record_id,
    confirmed_at: r.confirmed_at,
  }))
}
