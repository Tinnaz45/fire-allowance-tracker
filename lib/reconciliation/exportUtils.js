// ─── Export Utilities ─────────────────────────────────────────────────────────
// Phase 4 — Export-safe data transformation layer.
//
// CANONICAL TRUTH: all export data derives from sub-claim payment_status,
// payment_method, payment_date, and component_amount — never parent-level state.
//
// SUPPORTED FORMATS:
//   - CSV (browser download)
//   - Clipboard copy (plain text)
//   - JSON (for future Excel/PDF pipeline)
//
// REPORT TYPES:
//   - Full reconciliation report (all claims)
//   - Pending-only report (outstanding reimbursements)
//   - Paid-only report (payment audit trail)
//   - Payslip reconciliation report
//   - Petty cash reconciliation report
//   - Tax summary export
// ─────────────────────────────────────────────────────────────────────────────

import {
  resolveSubclaimAmount,
  resolveSubclaimPaymentStatus,
  resolveSubclaimPaymentMethod,
  resolveSubclaimPaymentDate,
  isSubclaimPaid,
  calcNormalizedSummary,
  buildGroupReconciliationRecord,
  buildSubclaimReconciliationRecord,
  resolveChildLabel,
} from './reconciliationUtils'
import { resolveEffectiveAmount, formatDateDDMMYYYY, formatFYLabel } from '@/lib/calculations/engine'

// ─── CSV Helpers ──────────────────────────────────────────────────────────────

/**
 * Escape a CSV cell value.
 * Wraps in quotes if value contains comma, quote, or newline.
 * @param {any} val
 * @returns {string}
 */
function csvCell(val) {
  if (val == null) return ''
  const s = String(val)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/**
 * Convert an array of row-arrays to a CSV string.
 * @param {Array<Array<any>>} rows
 * @returns {string}
 */
function rowsToCSV(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

/**
 * Trigger a browser download of a CSV file.
 * @param {string} csv
 * @param {string} filename
 */
export function downloadCSV(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Full Reconciliation Report ───────────────────────────────────────────────

/**
 * Build a full reconciliation CSV from groupedView.
 * One row per sub-claim component, with parent group context.
 *
 * Columns:
 *   Group Label, Claim Type, Incident Date, Component, Amount,
 *   Payment Status, Payment Method, Payment Date, Is Overdue
 *
 * @param {{ grouped: object[], ungrouped: object[] }} groupedView
 * @param {string} fyLabel
 * @returns {string} — CSV string
 */
export function buildReconciliationCSV(groupedView, fyLabel = '') {
  const { grouped = [], ungrouped = [] } = groupedView || {}
  const now = new Date().toLocaleDateString('en-AU')

  const header = [
    ['Fire Allowance Tracker — Reconciliation Report'],
    [fyLabel ? `Financial Year: ${formatFYLabel(fyLabel)}` : '', `Generated: ${now}`],
    [],
    [
      'Group Label',
      'Claim Type',
      'Incident Date',
      'Component',
      'Amount ($)',
      'Payment Status',
      'Payment Method',
      'Payment Date',
      'Overdue',
    ],
  ]

  const dataRows = []

  // Grouped claims
  for (const entry of grouped) {
    const rec = buildGroupReconciliationRecord(entry)
    for (const comp of rec.components) {
      dataRows.push([
        rec.label,
        formatClaimTypeLabel(rec.claimType),
        formatDateAU(rec.incidentDate),
        comp.label,
        comp.amount.toFixed(2),
        comp.paymentStatus,
        comp.paymentMethod || '—',
        comp.paymentDate ? formatDateAU(comp.paymentDate) : '—',
        rec.isOverdue ? 'Yes' : 'No',
      ])
    }
    if (rec.components.length === 0) {
      dataRows.push([
        rec.label,
        formatClaimTypeLabel(rec.claimType),
        formatDateAU(rec.incidentDate),
        '(no components)',
        rec.totalAmount.toFixed(2),
        rec.paymentStatus,
        '—',
        '—',
        rec.isOverdue ? 'Yes' : 'No',
      ])
    }
  }

  // Ungrouped (legacy)
  for (const claim of ungrouped) {
    const amt = resolveEffectiveAmount(claim)
    dataRows.push([
      '(Legacy / Ungrouped)',
      formatClaimTypeLabel(claim.claimType),
      formatDateAU(claim.date),
      formatClaimTypeLabel(claim.claimType),
      amt.toFixed(2),
      claim.status || 'Pending',
      claim.payment_method || '—',
      claim.payment_date ? formatDateAU(claim.payment_date) : '—',
      'No',
    ])
  }

  // Summary footer
  const summary = calcNormalizedSummary(groupedView)
  const footer = [
    [],
    ['Summary'],
    ['Grand Total', '', '', '', summary.grandTotal.toFixed(2)],
    ['Paid Total', '', '', '', summary.paidTotal.toFixed(2)],
    ['Outstanding (Pending)', '', '', '', summary.pendingTotal.toFixed(2)],
    ['Payslip Total', '', '', '', summary.payslipTotal.toFixed(2)],
    ['Petty Cash Total', '', '', '', summary.pettyCashTotal.toFixed(2)],
  ]

  return rowsToCSV([...header, ...dataRows, ...footer])
}

/**
 * Download the full reconciliation report as CSV.
 * @param {{ grouped: object[], ungrouped: object[] }} groupedView
 * @param {string} fyLabel
 */
export function downloadReconciliationCSV(groupedView, fyLabel = '') {
  const csv      = buildReconciliationCSV(groupedView, fyLabel)
  const safeFY   = (fyLabel || 'all').replace(/[^a-zA-Z0-9]/g, '-')
  const filename = `reconciliation-${safeFY}-${datestamp()}.csv`
  downloadCSV(csv, filename)
}

// ─── Payslip Reconciliation Report ───────────────────────────────────────────

/**
 * Build a payslip-only reconciliation CSV.
 * Includes only sub-claims where payment_method = 'Payslip'.
 *
 * @param {{ grouped: object[], ungrouped: object[] }} groupedView
 * @param {string} fyLabel
 * @returns {string}
 */
export function buildPayslipReconciliationCSV(groupedView, fyLabel = '') {
  const { grouped = [], ungrouped = [] } = groupedView || {}
  const now = new Date().toLocaleDateString('en-AU')

  const header = [
    ['Fire Allowance Tracker — Payslip Reconciliation'],
    [fyLabel ? `Financial Year: ${formatFYLabel(fyLabel)}` : '', `Generated: ${now}`],
    [],
    ['Group Label', 'Claim Type', 'Date', 'Component', 'Amount ($)', 'Pay #', 'Payment Status', 'Payment Date'],
  ]

  const dataRows = []

  for (const entry of grouped) {
    const payslipChildren = (entry.children || []).filter(
      (c) => resolveSubclaimPaymentMethod(c) === 'Payslip'
    )
    for (const child of payslipChildren) {
      dataRows.push([
        entry.group?.label || '—',
        formatClaimTypeLabel(entry.group?.claim_type),
        formatDateAU(entry.group?.incident_date || child.date),
        resolveChildLabel(child),
        resolveSubclaimAmount(child).toFixed(2),
        child.payslip_pay_nbr || '—',
        resolveSubclaimPaymentStatus(child),
        resolveSubclaimPaymentDate(child) ? formatDateAU(resolveSubclaimPaymentDate(child)) : '—',
      ])
    }
  }

  // Ungrouped payslip claims
  for (const claim of ungrouped) {
    if (claim.payment_method !== 'Payslip') continue
    dataRows.push([
      '(Legacy)',
      formatClaimTypeLabel(claim.claimType),
      formatDateAU(claim.date),
      formatClaimTypeLabel(claim.claimType),
      resolveEffectiveAmount(claim).toFixed(2),
      claim.payslip_pay_nbr || '—',
      claim.status || 'Pending',
      claim.payment_date ? formatDateAU(claim.payment_date) : '—',
    ])
  }

  const summary = calcNormalizedSummary(groupedView)
  const footer  = [
    [],
    ['Payslip Summary'],
    ['Total Payslip', '', '', '', '', '', '', summary.payslipTotal.toFixed(2)],
    ['Paid via Payslip', '', '', '', '', '', '', summary.payslipPaidTotal.toFixed(2)],
    ['Pending Payslip', '', '', '', '', '', '', summary.payslipPendingTotal.toFixed(2)],
  ]

  return rowsToCSV([...header, ...dataRows, ...(dataRows.length ? footer : [])])
}

/**
 * Download the payslip reconciliation CSV.
 */
export function downloadPayslipCSV(groupedView, fyLabel = '') {
  const csv      = buildPayslipReconciliationCSV(groupedView, fyLabel)
  const safeFY   = (fyLabel || 'all').replace(/[^a-zA-Z0-9]/g, '-')
  downloadCSV(csv, `payslip-reconciliation-${safeFY}-${datestamp()}.csv`)
}

// ─── Petty Cash Reconciliation Report ────────────────────────────────────────

/**
 * Build a petty cash reconciliation CSV.
 * Includes only sub-claims where payment_method = 'Petty Cash'.
 *
 * @param {{ grouped: object[], ungrouped: object[] }} groupedView
 * @param {string} fyLabel
 * @returns {string}
 */
export function buildPettyCashReconciliationCSV(groupedView, fyLabel = '') {
  const { grouped = [], ungrouped = [] } = groupedView || {}
  const now = new Date().toLocaleDateString('en-AU')

  const header = [
    ['Fire Allowance Tracker — Petty Cash Reconciliation'],
    [fyLabel ? `Financial Year: ${formatFYLabel(fyLabel)}` : '', `Generated: ${now}`],
    [],
    ['Group Label', 'Claim Type', 'Date', 'Component', 'Amount ($)', 'Payment Status', 'Payment Date'],
  ]

  const dataRows = []

  for (const entry of grouped) {
    const pcChildren = (entry.children || []).filter(
      (c) => resolveSubclaimPaymentMethod(c) === 'Petty Cash'
    )
    for (const child of pcChildren) {
      dataRows.push([
        entry.group?.label || '—',
        formatClaimTypeLabel(entry.group?.claim_type),
        formatDateAU(entry.group?.incident_date || child.date),
        resolveChildLabel(child),
        resolveSubclaimAmount(child).toFixed(2),
        resolveSubclaimPaymentStatus(child),
        resolveSubclaimPaymentDate(child) ? formatDateAU(resolveSubclaimPaymentDate(child)) : '—',
      ])
    }
  }

  for (const claim of ungrouped) {
    if (claim.payment_method !== 'Petty Cash') continue
    dataRows.push([
      '(Legacy)',
      formatClaimTypeLabel(claim.claimType),
      formatDateAU(claim.date),
      formatClaimTypeLabel(claim.claimType),
      resolveEffectiveAmount(claim).toFixed(2),
      claim.status || 'Pending',
      claim.payment_date ? formatDateAU(claim.payment_date) : '—',
    ])
  }

  const summary = calcNormalizedSummary(groupedView)
  const footer  = [
    [],
    ['Petty Cash Summary'],
    ['Total Petty Cash', '', '', '', summary.pettyCashTotal.toFixed(2)],
    ['Paid Petty Cash', '', '', '', summary.pettyCashPaidTotal.toFixed(2)],
    ['Pending Petty Cash', '', '', '', summary.pettyCashPendingTotal.toFixed(2)],
  ]

  return rowsToCSV([...header, ...dataRows, ...(dataRows.length ? footer : [])])
}

/**
 * Download the petty cash reconciliation CSV.
 */
export function downloadPettyCashCSV(groupedView, fyLabel = '') {
  const csv    = buildPettyCashReconciliationCSV(groupedView, fyLabel)
  const safeFY = (fyLabel || 'all').replace(/[^a-zA-Z0-9]/g, '-')
  downloadCSV(csv, `petty-cash-reconciliation-${safeFY}-${datestamp()}.csv`)
}

// ─── Outstanding Reimbursements Report ───────────────────────────────────────

/**
 * Build a pending/outstanding reimbursements CSV.
 * Includes only sub-claims that are Pending.
 *
 * @param {{ grouped: object[], ungrouped: object[] }} groupedView
 * @param {string} fyLabel
 * @returns {string}
 */
export function buildOutstandingCSV(groupedView, fyLabel = '') {
  const { grouped = [], ungrouped = [] } = groupedView || {}
  const now = new Date().toLocaleDateString('en-AU')

  const header = [
    ['Fire Allowance Tracker — Outstanding Reimbursements'],
    [fyLabel ? `Financial Year: ${formatFYLabel(fyLabel)}` : '', `Generated: ${now}`],
    [],
    ['Group Label', 'Claim Type', 'Incident Date', 'Component', 'Amount ($)', 'Payment Method', 'Overdue'],
  ]

  const dataRows = []

  for (const entry of grouped) {
    const pendingChildren = (entry.children || []).filter(
      (c) => !isSubclaimPaid(c)
    )
    for (const child of pendingChildren) {
      const isOverdue = entry.group?.overdue_at
        ? new Date() > new Date(entry.group.overdue_at)
        : false
      dataRows.push([
        entry.group?.label || '—',
        formatClaimTypeLabel(entry.group?.claim_type),
        formatDateAU(entry.group?.incident_date),
        resolveChildLabel(child),
        resolveSubclaimAmount(child).toFixed(2),
        resolveSubclaimPaymentMethod(child) || '—',
        isOverdue ? 'Yes' : 'No',
      ])
    }
  }

  for (const claim of ungrouped) {
    if ((claim.status || '').toLowerCase() === 'paid') continue
    dataRows.push([
      '(Legacy)',
      formatClaimTypeLabel(claim.claimType),
      formatDateAU(claim.date),
      formatClaimTypeLabel(claim.claimType),
      resolveEffectiveAmount(claim).toFixed(2),
      claim.payment_method || '—',
      'No',
    ])
  }

  const summary = calcNormalizedSummary(groupedView)
  const footer  = [
    [],
    ['Outstanding Total', '', '', '', summary.pendingTotal.toFixed(2)],
  ]

  return rowsToCSV([...header, ...dataRows, ...(dataRows.length ? footer : [])])
}

/**
 * Download outstanding reimbursements CSV.
 */
export function downloadOutstandingCSV(groupedView, fyLabel = '') {
  const csv    = buildOutstandingCSV(groupedView, fyLabel)
  const safeFY = (fyLabel || 'all').replace(/[^a-zA-Z0-9]/g, '-')
  downloadCSV(csv, `outstanding-${safeFY}-${datestamp()}.csv`)
}

// ─── Financial Summary Report ─────────────────────────────────────────────────

/**
 * Build a financial summary CSV suitable for accountants/tax agents.
 * Aggregated totals by claim type and payment method.
 *
 * @param {{ grouped: object[], ungrouped: object[] }} groupedView
 * @param {string} fyLabel
 * @param {object} [taxSummary] — optional from calcTaxSummary()
 * @returns {string}
 */
export function buildFinancialSummaryCSV(groupedView, fyLabel = '', taxSummary = null) {
  const summary = calcNormalizedSummary(groupedView)
  const now = new Date().toLocaleDateString('en-AU')

  const rows = [
    ['Fire Allowance Tracker — Financial Summary'],
    [fyLabel ? `Financial Year: ${formatFYLabel(fyLabel)}` : '', `Generated: ${now}`],
    [],

    ['Payment Overview', 'Amount ($)'],
    ['Grand Total', summary.grandTotal.toFixed(2)],
    ['Total Paid', summary.paidTotal.toFixed(2)],
    ['Total Pending (Outstanding)', summary.pendingTotal.toFixed(2)],
    [],

    ['By Payment Method', 'Total ($)', 'Paid ($)', 'Pending ($)'],
    [
      'Payslip',
      summary.payslipTotal.toFixed(2),
      summary.payslipPaidTotal.toFixed(2),
      summary.payslipPendingTotal.toFixed(2),
    ],
    [
      'Petty Cash',
      summary.pettyCashTotal.toFixed(2),
      summary.pettyCashPaidTotal.toFixed(2),
      summary.pettyCashPendingTotal.toFixed(2),
    ],
    [],

    ['By Claim Type', 'Total ($)'],
    ...Object.entries(summary.byClaimType).map(([type, amt]) => [
      formatClaimTypeLabel(type),
      amt.toFixed(2),
    ]),
    [],

    ['Claim Counts'],
    ['Total Claim Groups', summary.groupCount],
    ['Paid Groups', summary.paidGroupCount],
    ['Pending Groups', summary.pendingGroupCount],
    ['Total Sub-Claims', summary.subclaimCount],
    ['Paid Sub-Claims', summary.paidSubclaimCount],
  ]

  // Append tax summary if provided
  if (taxSummary) {
    rows.push(
      [],
      ['Tax Summary (ATO)'],
      ['Small Meals', taxSummary.smallMealCount, `$${taxSummary.smallMealTotal.toFixed(2)}`],
      ['Large Meals', taxSummary.largeMealCount, `$${taxSummary.largeMealTotal.toFixed(2)}`],
      ['Travel km', taxSummary.travelKm.toFixed(1), `$${taxSummary.travelTotal.toFixed(2)}`],
      ['ATO Grand Total', '', `$${taxSummary.grandTotal.toFixed(2)}`],
    )
  }

  return rowsToCSV(rows)
}

/**
 * Download the financial summary CSV.
 */
export function downloadFinancialSummaryCSV(groupedView, fyLabel = '', taxSummary = null) {
  const csv    = buildFinancialSummaryCSV(groupedView, fyLabel, taxSummary)
  const safeFY = (fyLabel || 'all').replace(/[^a-zA-Z0-9]/g, '-')
  downloadCSV(csv, `financial-summary-${safeFY}-${datestamp()}.csv`)
}

// ─── Clipboard Export ─────────────────────────────────────────────────────────

/**
 * Build plain text reconciliation summary for clipboard.
 * @param {{ grouped: object[], ungrouped: object[] }} groupedView
 * @param {string} fyLabel
 * @returns {string}
 */
export function buildClipboardSummary(groupedView, fyLabel = '') {
  const summary = calcNormalizedSummary(groupedView)
  const lines = [
    `Fire Allowance Tracker — Summary`,
    fyLabel ? `Financial Year: ${formatFYLabel(fyLabel)}` : '',
    '',
    `Grand Total:     $${summary.grandTotal.toFixed(2)}`,
    `Paid:            $${summary.paidTotal.toFixed(2)}`,
    `Outstanding:     $${summary.pendingTotal.toFixed(2)}`,
    '',
    `Payslip:         $${summary.payslipTotal.toFixed(2)}  (Paid: $${summary.payslipPaidTotal.toFixed(2)} / Pending: $${summary.payslipPendingTotal.toFixed(2)})`,
    `Petty Cash:      $${summary.pettyCashTotal.toFixed(2)}  (Paid: $${summary.pettyCashPaidTotal.toFixed(2)} / Pending: $${summary.pettyCashPendingTotal.toFixed(2)})`,
    '',
    `Groups:          ${summary.groupCount} total, ${summary.paidGroupCount} paid, ${summary.pendingGroupCount} pending`,
  ]
  return lines.filter((l) => l !== null).join('\n')
}

// ─── JSON Export (Future Excel/PDF pipeline) ──────────────────────────────────

/**
 * Build a normalized JSON export of all reconciliation data.
 * Safe for passing to Excel or PDF generators.
 *
 * @param {{ grouped: object[], ungrouped: object[] }} groupedView
 * @param {string} fyLabel
 * @returns {object}
 */
export function buildExportJSON(groupedView, fyLabel = '') {
  const { grouped = [], ungrouped = [] } = groupedView || {}
  const summary = calcNormalizedSummary(groupedView)

  return {
    exportedAt:    new Date().toISOString(),
    financialYear: fyLabel || null,
    summary,
    groups:        grouped.map(buildGroupReconciliationRecord),
    legacyClaims:  ungrouped.map((c) => ({
      id:            c.id,
      claimType:     c.claimType,
      date:          c.date,
      amount:        resolveEffectiveAmount(c),
      status:        c.status,
      paymentMethod: c.payment_method || null,
      paymentDate:   c.payment_date || null,
    })),
  }
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

const CLAIM_TYPE_LABELS = {
  recalls:      'Recall',
  retain:       'Retain',
  standby:      'Standby',
  md:           'Muster & Dismiss',
  spoilt:       'Spoilt Meal',
  delayed_meal: 'Delayed Meal',
}

function formatClaimTypeLabel(type) {
  return CLAIM_TYPE_LABELS[type] || type || '—'
}

function formatDateAU(date) {
  if (!date) return '—'
  try {
    const d = new Date(date.includes('T') ? date : date + 'T00:00:00')
    const dd = String(d.getDate()).padStart(2, '0')
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const yyyy = d.getFullYear()
    return `${dd}/${mm}/${yyyy}`
  } catch {
    return date
  }
}

function datestamp() {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm   = String(now.getMonth() + 1).padStart(2, '0')
  const dd   = String(now.getDate()).padStart(2, '0')
  return `${yyyy}${mm}${dd}`
}
