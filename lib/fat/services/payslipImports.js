// ─── OCR Payslip Import — staging service (canonical) ─────────────────────────
// The workspace CRUD over fat.payslip_imports / fat.payslip_import_lines plus the
// confirm-bridge wrapper. This is a PRODUCER layer (principle § 2.1): everything
// here is low-stakes staging churn (plain owner-scoped writes under RLS, audited
// only by updated_at, § 3.3) EXCEPT confirmImportLine, which crosses into the
// canonical world through the atomic migration-11 RPC.
//
// Spec: OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 3 (schema), § 4 (lifecycle),
// § 6 (confirm bridge), § 9 (adapter). Roadmap steps O5 (staging CRUD) + O6
// (confirm bridge wrapper).
//
// The fat client passed in MUST be schema-scoped to `fat` (lib/supabaseClient.js
// → `fat`). owner_id / actor identity comes from the caller; RLS enforces
// owner-only on the authenticated path.

import { fat as defaultClient } from '../../supabaseClient.js'
import {
  PAYSLIP_IMPORTS_TABLE,
  PAYSLIP_IMPORT_LINES_TABLE,
  IMPORT_SOURCE_VALUES,
  IMPORT_STATUS,
  IMPORT_STATUS_VALUES,
  IMPORT_LINE_STATUS_VALUES,
  canTransitionImport,
  canTransitionLine,
} from '../models/payslipImport.js'
import { DEFAULT_TOLERANCE } from '../models/reconciliationConstants.js'
import { manualEntryAdapter } from '../adapters/manualEntryAdapter.js'
import { scoreImportLines } from './payslipMatcher.js'
import { detectImportDuplicates } from './payslipDuplicates.js'

// ─── Imports (batch entity) ──────────────────────────────────────────────────

/**
 * Create an import batch row (§ 3.1). Plain insert under RLS — no RPC needed
 * (staging is disposable workspace, § 2.2). Defaults to status 'uploaded'.
 *
 * @param {object} input
 * @param {string} input.ownerId                       fat.profiles.id
 * @param {'manual_entry'|'payslip_screenshot'|'payslip_pdf'} input.source
 * @param {string} [input.status='uploaded']
 * @param {string|null} [input.payDate]                ISO 'YYYY-MM-DD'
 * @param {string|null} [input.payPeriodRef]
 * @param {string|null} [input.parserName]
 * @param {string|null} [input.parserVersion]
 * @param {object|null} [input.rawExtract]
 * @param {string|null} [input.fileRef]
 * @param {string|null} [input.fileHash]
 * @param {object} [client]
 * @returns {Promise<import('../models/payslipImport.js').PayslipImport>}
 */
export async function createImport(input, client = defaultClient) {
  const {
    ownerId, source, status = IMPORT_STATUS.UPLOADED,
    payDate = null, payPeriodRef = null,
    parserName = null, parserVersion = null,
    rawExtract = null, fileRef = null, fileHash = null,
  } = input

  if (!ownerId) throw new Error('createImport: ownerId is required.')
  if (!IMPORT_SOURCE_VALUES.includes(source)) {
    throw new Error(`createImport: invalid source '${source}'.`)
  }
  if (!IMPORT_STATUS_VALUES.includes(status)) {
    throw new Error(`createImport: invalid status '${status}'.`)
  }

  const { data, error } = await client
    .from(PAYSLIP_IMPORTS_TABLE)
    .insert({
      owner_id: ownerId,
      source,
      status,
      pay_date: payDate,
      pay_period_ref: payPeriodRef,
      parser_name: parserName,
      parser_version: parserVersion,
      raw_extract: rawExtract,
      file_ref: fileRef,
      file_hash: fileHash,
    })
    .select('*')
    .single()
  if (error) throw new Error(`createImport failed: ${error.message}`)
  return data
}

/**
 * Move an import to a new lifecycle status (§ 4.1). Validates the transition
 * against the canonical state machine before writing — temporary UI states are
 * mapped onto these by the caller, never persisted as new values.
 *
 * @param {object} input
 * @param {string} input.importId
 * @param {string} input.status                        target IMPORT_STATUS
 * @param {string|null} [input.error]                  populated when status='failed'
 * @param {boolean} [input.force=false]                skip transition validation (recovery only)
 * @param {object} [client]
 * @returns {Promise<import('../models/payslipImport.js').PayslipImport>}
 */
export async function updateImportStatus(input, client = defaultClient) {
  const { importId, status, error: errText = null, force = false } = input
  if (!importId) throw new Error('updateImportStatus: importId is required.')
  if (!IMPORT_STATUS_VALUES.includes(status)) {
    throw new Error(`updateImportStatus: invalid status '${status}'.`)
  }

  const current = await getImport(importId, client)
  if (!current) throw new Error(`updateImportStatus: import ${importId} not found.`)
  if (!force && current.status !== status && !canTransitionImport(current.status, status)) {
    throw new Error(`updateImportStatus: illegal transition ${current.status} → ${status}.`)
  }

  const patch = { status }
  if (status === IMPORT_STATUS.FAILED) patch.error = errText

  const { data, error } = await client
    .from(PAYSLIP_IMPORTS_TABLE)
    .update(patch)
    .eq('id', importId)
    .select('*')
    .single()
  if (error) throw new Error(`updateImportStatus failed: ${error.message}`)
  return data
}

/**
 * Read a single import by id (owner-scoped under RLS).
 * @param {string} importId
 * @param {object} [client]
 * @returns {Promise<import('../models/payslipImport.js').PayslipImport|null>}
 */
export async function getImport(importId, client = defaultClient) {
  if (!importId) throw new Error('getImport: importId is required.')
  const { data, error } = await client
    .from(PAYSLIP_IMPORTS_TABLE)
    .select('*')
    .eq('id', importId)
    .maybeSingle()
  if (error) throw new Error(`getImport failed: ${error.message}`)
  return data ?? null
}

/**
 * List imports for an owner, newest first. Optional status filter.
 * @param {string} ownerId
 * @param {{ status?: string }} [opts]
 * @param {object} [client]
 * @returns {Promise<import('../models/payslipImport.js').PayslipImport[]>}
 */
export async function listImports(ownerId, opts = {}, client = defaultClient) {
  if (!ownerId) throw new Error('listImports: ownerId is required.')
  let query = client
    .from(PAYSLIP_IMPORTS_TABLE)
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
  if (opts.status) query = query.eq('status', opts.status)
  const { data, error } = await query
  if (error) throw new Error(`listImports failed: ${error.message}`)
  return data ?? []
}

// ─── Lines (parsed lines + match candidates) ─────────────────────────────────

/**
 * Bulk-insert parsed lines onto an import (§ 3.2) and refresh import.line_count.
 * Lines come from a ParserAdapter's ParseResult (the canonical line shape) — the
 * service stays adapter-agnostic. New lines land at status 'parsed'.
 *
 * @param {object} input
 * @param {string} input.importId
 * @param {string} input.ownerId                       denormalized onto each line for RLS
 * @param {import('../adapters/manualEntryAdapter.js').ParsedLine[]} input.lines
 * @param {object} [client]
 * @returns {Promise<import('../models/payslipImport.js').PayslipImportLine[]>}
 */
export async function addImportLines(input, client = defaultClient) {
  const { importId, ownerId, lines } = input
  if (!importId) throw new Error('addImportLines: importId is required.')
  if (!ownerId) throw new Error('addImportLines: ownerId is required.')
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('addImportLines: at least one line is required.')
  }

  const rows = lines.map((l, i) => ({
    import_id: importId,
    owner_id: ownerId,
    line_index: l.line_index ?? i,
    raw_text: l.raw_text ?? null,
    parsed_reference: l.parsed_reference ?? null,
    parsed_description: l.parsed_description ?? null,
    parsed_amount: l.parsed_amount ?? null,
    parsed_date: l.parsed_date ?? null,
    status: 'parsed',
  }))

  const { data, error } = await client
    .from(PAYSLIP_IMPORT_LINES_TABLE)
    .insert(rows)
    .select('*')
  if (error) throw new Error(`addImportLines failed: ${error.message}`)

  // Refresh line_count to the import's true total (idempotent — counts all lines).
  const { count, error: cErr } = await client
    .from(PAYSLIP_IMPORT_LINES_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('import_id', importId)
  if (cErr) throw new Error(`addImportLines (count) failed: ${cErr.message}`)
  const { error: uErr } = await client
    .from(PAYSLIP_IMPORTS_TABLE)
    .update({ line_count: count ?? rows.length })
    .eq('id', importId)
  if (uErr) throw new Error(`addImportLines (line_count) failed: ${uErr.message}`)

  return data ?? []
}

/**
 * List an import's lines, ordered by line_index. Optional status filter.
 * @param {string} importId
 * @param {{ status?: string }} [opts]
 * @param {object} [client]
 * @returns {Promise<import('../models/payslipImport.js').PayslipImportLine[]>}
 */
export async function listImportLines(importId, opts = {}, client = defaultClient) {
  if (!importId) throw new Error('listImportLines: importId is required.')
  let query = client
    .from(PAYSLIP_IMPORT_LINES_TABLE)
    .select('*')
    .eq('import_id', importId)
    .order('line_index', { ascending: true })
  if (opts.status) query = query.eq('status', opts.status)
  const { data, error } = await query
  if (error) throw new Error(`listImportLines failed: ${error.message}`)
  return data ?? []
}

/**
 * Operator edit of a single staging line (§ 4.2): change its status (validated
 * against the line state machine), set/clear the candidate entitlement suggestion,
 * and/or attach a resolution note. This is the "update line" workspace mutation —
 * it never writes canonical state (that is confirmImportLine's job).
 *
 * @param {object} input
 * @param {string} input.lineId
 * @param {string} [input.status]                      target IMPORT_LINE_STATUS
 * @param {string|null} [input.resolutionNote]
 * @param {string|null} [input.candidateEntitlementId] set ('' / null clears it)
 * @param {boolean} [input.force=false]
 * @param {object} [client]
 * @returns {Promise<import('../models/payslipImport.js').PayslipImportLine>}
 */
export async function updateLineResolution(input, client = defaultClient) {
  const {
    lineId, status, resolutionNote, candidateEntitlementId, force = false,
  } = input
  if (!lineId) throw new Error('updateLineResolution: lineId is required.')

  const { data: current, error: gErr } = await client
    .from(PAYSLIP_IMPORT_LINES_TABLE)
    .select('id, status')
    .eq('id', lineId)
    .maybeSingle()
  if (gErr) throw new Error(`updateLineResolution failed: ${gErr.message}`)
  if (!current) throw new Error(`updateLineResolution: line ${lineId} not found.`)

  const patch = {}
  if (status !== undefined) {
    if (!IMPORT_LINE_STATUS_VALUES.includes(status)) {
      throw new Error(`updateLineResolution: invalid status '${status}'.`)
    }
    if (status === 'confirmed') {
      throw new Error('updateLineResolution: use confirmImportLine to confirm — it must go through the bridge RPC.')
    }
    if (!force && current.status !== status && !canTransitionLine(current.status, status)) {
      throw new Error(`updateLineResolution: illegal transition ${current.status} → ${status}.`)
    }
    patch.status = status
  }
  if (resolutionNote !== undefined) patch.resolution_note = resolutionNote
  if (candidateEntitlementId !== undefined) {
    patch.candidate_entitlement_id = candidateEntitlementId || null
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('updateLineResolution: nothing to update.')
  }

  const { data, error } = await client
    .from(PAYSLIP_IMPORT_LINES_TABLE)
    .update(patch)
    .eq('id', lineId)
    .select('*')
    .single()
  if (error) throw new Error(`updateLineResolution failed: ${error.message}`)
  return data
}

// ─── Confirm bridge wrapper (the only canonical write path) ──────────────────

/**
 * Confirm one staging line through the atomic migration-11 bridge RPC (§ 6.1).
 * Creates a payment_records row (always) and — when the operator chose a routed,
 * stream-coherent entitlement — links it and recomputes status, all in one
 * transaction. With no entitlement chosen (or an unrouted one), the record lands
 * in the unallocated queue (§ 6.4) and the line is still stamped 'confirmed'.
 *
 * @param {object} input
 * @param {string} input.lineId
 * @param {string} input.actorId                       MUST equal the line owner (§ 6.1 step 0)
 * @param {string|null} [input.entitlementId]          operator's final choice (may differ from candidate)
 * @param {'auto_match'|'manual'|null} [input.linkKind] null ⇒ record-only confirm
 * @param {number|null} [input.allocatedAmount]        defaults to parsed_amount when linking
 * @param {number} [input.tolerance=0.01]
 * @param {boolean} [input.allowDuplicate=false]       operator override of the double-confirmation guard (§ 4)
 * @param {object} [client]
 * @returns {Promise<object>}                           bridge result jsonb
 * @throws {Error & {code?: string, duplicate?: object}}  on a duplicate block, err.code = 'DUPLICATE_CONFIRMED'
 *         and err.duplicate carries { duplicate_line_id, duplicate_record_id, duplicate_import_id }.
 */
export async function confirmImportLine(input, client = defaultClient) {
  const {
    lineId, actorId, entitlementId = null, linkKind = null,
    allocatedAmount = null, tolerance = DEFAULT_TOLERANCE, allowDuplicate = false,
  } = input
  if (!lineId) throw new Error('confirmImportLine: lineId is required.')
  if (!actorId) throw new Error('confirmImportLine: actorId is required.')
  if (linkKind !== null && !['auto_match', 'manual'].includes(linkKind)) {
    throw new Error(`confirmImportLine: invalid linkKind '${linkKind}' (auto_match|manual|null).`)
  }
  if (linkKind !== null && !entitlementId) {
    throw new Error('confirmImportLine: linkKind given without an entitlementId.')
  }

  const { data, error } = await client.rpc('confirm_payslip_import_line', {
    p_line_id:          lineId,
    p_actor_id:         actorId,
    p_entitlement_id:   entitlementId,
    p_link_kind:        linkKind,
    p_allocated_amount: allocatedAmount,
    p_tolerance:        tolerance,
    p_allow_duplicate:  allowDuplicate,
  })
  if (error) {
    // The double-confirmation guard (migration 12) raises unique_violation with a
    // JSON detail. Surface it as a TYPED error so the UI can offer an explicit
    // override (re-call with allowDuplicate:true) rather than a dead end (§ 4).
    const isDup = error.code === '23505' || /duplicates already-confirmed/.test(error.message ?? '')
    const e = new Error(`confirmImportLine failed: ${error.message}`)
    if (isDup) {
      e.code = 'DUPLICATE_CONFIRMED'
      try { e.duplicate = JSON.parse(error.details) } catch { e.duplicate = null }
    }
    throw e
  }
  return data
}

// ─── High-level convenience: manual-entry import end-to-end ──────────────────

/**
 * Create a manual-entry import and materialize its lines via the ManualEntryAdapter
 * (§ 9), walking the canonical lifecycle uploaded → parsing → parsed → needs_review
 * (no synonyms; the resting state for MVP, where every line is operator-confirmed).
 * No OCR — the adapter only structures already-typed operator input.
 *
 * @param {object} input
 * @param {string} input.ownerId
 * @param {object} input.form                          { pay_date?, pay_period_ref?, lines: [...] }
 * @param {object} [client]
 * @returns {Promise<{ import: object, lines: object[] }>}
 */
export async function createManualEntryImport(input, client = defaultClient) {
  const { ownerId, form } = input
  if (!ownerId) throw new Error('createManualEntryImport: ownerId is required.')

  // uploaded — the batch exists, nothing parsed yet.
  let imp = await createImport({
    ownerId,
    source: manualEntryAdapter.source,
    status: IMPORT_STATUS.UPLOADED,
  }, client)

  try {
    // parsing — run the adapter (synchronous for manual entry).
    imp = await updateImportStatus({ importId: imp.id, status: IMPORT_STATUS.PARSING }, client)
    const result = await manualEntryAdapter.parse(form)

    // Persist the adapter's batch-level fields, then the lines.
    const { error: metaErr } = await client
      .from(PAYSLIP_IMPORTS_TABLE)
      .update({
        pay_date: result.pay_date,
        pay_period_ref: result.pay_period_ref,
        parser_name: result.parser_name,
        parser_version: result.parser_version,
        raw_extract: result.raw_extract,
      })
      .eq('id', imp.id)
    if (metaErr) throw new Error(`createManualEntryImport (meta) failed: ${metaErr.message}`)

    let lines = await addImportLines({ importId: imp.id, ownerId, lines: result.lines }, client)

    // Candidate recommendation (Step O4): score each parsed line against the
    // owner's payslip-eligible entitlements and pre-fill the suggestion columns.
    // ADDITIVE + NON-FATAL (mirrors the canonicalBridge pattern) — a matcher
    // failure must never block the import landing for manual review; lines simply
    // arrive unscored and the operator links them by hand.
    try {
      const { lines: scored } = await scoreImportLines({ importId: imp.id, ownerId }, client)
      if (scored?.length) lines = scored
    } catch (matchErr) {
      console.warn(`createManualEntryImport: matcher skipped (${matchErr.message})`)
    }

    // Duplicate detection (blocker #1): fingerprint this import and compare it to
    // the owner's prior imports, persisting the verdict onto duplicate_check for the
    // review UI. ADDITIVE + NON-FATAL (mirrors the matcher) — a detection failure
    // must never block the import landing; it simply arrives un-checked and the
    // operator reviews without the warning. The line-level fingerprints the scan
    // reads are already trigger-maintained (migration 12), so they exist regardless.
    try {
      const dup = await detectImportDuplicates({ importId: imp.id, ownerId }, client)
      imp = { ...imp, duplicate_check: dup, content_fingerprint: dup.fingerprint }
    } catch (dupErr) {
      console.warn(`createManualEntryImport: duplicate detection skipped (${dupErr.message})`)
    }

    // parsed → needs_review (every line awaits an operator decision in MVP).
    imp = await updateImportStatus({ importId: imp.id, status: IMPORT_STATUS.PARSED }, client)
    imp = await updateImportStatus({ importId: imp.id, status: IMPORT_STATUS.NEEDS_REVIEW }, client)

    return { import: imp, lines }
  } catch (err) {
    // failed — surface the parser error onto the import (re-parsable, § 4.1).
    try {
      imp = await updateImportStatus({ importId: imp.id, status: IMPORT_STATUS.FAILED, error: String(err.message ?? err), force: true }, client)
    } catch { /* best-effort status stamp */ }
    throw err
  }
}
