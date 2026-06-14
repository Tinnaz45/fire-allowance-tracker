// ─── Payslip-import status vocabulary (presentational) ────────────────────────
// Badge metadata + labels for the OCR-import lifecycles. Pure rendering — mirrors
// lib/fat/models/payslipImport.js so the UI never disagrees with the canonical
// state machine (IMPORT_STATUS / IMPORT_LINE_STATUS — no synonyms). The richer
// reconciliation badges (derived payment status) come from reconciliation/ui.js;
// these cover only the staging lifecycles the /payments/imports surface owns.
//
// Visual language matches the rest of the app: dark surface, red accent. The
// tone palette is the same one reconciliation/ui.js uses, redeclared here (it is
// not exported there) so a payslip badge is colour-consistent with a status badge.
// ─────────────────────────────────────────────────────────────────────────────

const PALETTE = Object.freeze({
  grey: { color: '#9ca3af', bg: 'rgba(156,163,175,0.1)', border: 'rgba(156,163,175,0.25)' },
  amber: { color: '#fde68a', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.3)' },
  blue: { color: '#93c5fd', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.3)' },
  green: { color: '#4ade80', bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.3)' },
  red: { color: '#f87171', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)' },
})

// Import lifecycle (payslip_imports.status, § 4.1).
export const IMPORT_STATUS_META = Object.freeze({
  uploaded: { label: 'Uploaded', tone: 'grey' },
  parsing: { label: 'Parsing', tone: 'amber' },
  parsed: { label: 'Parsed', tone: 'blue' },
  needs_review: { label: 'Needs review', tone: 'amber' },
  confirmed: { label: 'Confirmed', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  superseded: { label: 'Superseded', tone: 'grey' },
  failed: { label: 'Failed', tone: 'red' },
})

// Line lifecycle (payslip_import_lines.status, § 4.2).
export const LINE_STATUS_META = Object.freeze({
  parsed: { label: 'Parsed', tone: 'blue' },
  needs_review: { label: 'Needs review', tone: 'amber' },
  confirmed: { label: 'Confirmed', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  superseded: { label: 'Superseded', tone: 'grey' },
  failed: { label: 'Failed', tone: 'red' },
})

// How the batch was created (payslip_imports.source, § 3.1). MVP only ever writes
// 'manual_entry'; the file-backed sources are listed for forward-compat display.
export const IMPORT_SOURCE_LABELS = Object.freeze({
  manual_entry: 'Manual entry',
  payslip_screenshot: 'Screenshot',
  payslip_pdf: 'PDF',
})

export function importSourceLabel(source) {
  return IMPORT_SOURCE_LABELS[source] ?? source ?? '—'
}

function Badge({ meta, status, small }) {
  const t = PALETTE[meta?.tone] ?? PALETTE.grey
  const label = meta?.label ?? status ?? '—'
  return (
    <span style={{
      display: 'inline-block',
      padding: small ? '2px 8px' : '3px 10px',
      borderRadius: '999px',
      fontSize: small ? '0.66rem' : '0.72rem',
      fontWeight: 700,
      letterSpacing: '0.02em',
      color: t.color,
      background: t.bg,
      border: `1px solid ${t.border}`,
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

export function ImportStatusBadge({ status, small = false }) {
  return <Badge meta={IMPORT_STATUS_META[status]} status={status} small={small} />
}

export function LineStatusBadge({ status, small = false }) {
  return <Badge meta={LINE_STATUS_META[status]} status={status} small={small} />
}

// ─── Match confidence (Step O4) ───────────────────────────────────────────────
// The matcher's band is DISPLAY-ONLY (the persisted line status has no 'matched'
// value). 'auto' = strong pre-selected candidate; 'review' = candidate shown to
// confirm/change; 'none' = no confident match, operator links manually. Operator
// confirmation is mandatory in every band — the badge orders the queue, it never
// settles a line. Thresholds mirror payslipMatcher.MATCH_THRESHOLDS.

export const MATCH_BAND_META = Object.freeze({
  auto: { label: 'Strong match', tone: 'green' },
  review: { label: 'Likely match', tone: 'blue' },
  none: { label: 'No match', tone: 'grey' },
})

/** `0.873` → `87%`; safe on null/NaN. */
export function confidencePct(confidence) {
  const c = Number(confidence)
  if (!Number.isFinite(c)) return '—'
  return `${Math.round(c * 100)}%`
}

export function ConfidenceBadge({ confidence, band, small = false }) {
  const meta = MATCH_BAND_META[band] ?? MATCH_BAND_META.none
  const t = PALETTE[meta.tone] ?? PALETTE.grey
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      padding: small ? '2px 8px' : '3px 10px',
      borderRadius: '999px',
      fontSize: small ? '0.66rem' : '0.72rem',
      fontWeight: 700,
      letterSpacing: '0.02em',
      color: t.color,
      background: t.bg,
      border: `1px solid ${t.border}`,
      whiteSpace: 'nowrap',
    }}>
      {meta.label}
      <span style={{ opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>{confidencePct(confidence)}</span>
    </span>
  )
}

// ─── Extraction confidence (OCR_EXTRACTION_MVP § 8) ───────────────────────────
// SEPARATE from match confidence — this answers "did OCR read the line correctly?".
// Display + attention-routing only; it NEVER auto-confirms and NEVER feeds the
// matcher. Bands mirror lib/fat/models/payslipImport.js EXTRACT_CONFIDENCE.
export const EXTRACT_BAND_META = Object.freeze({
  high: { label: 'OCR read', tone: 'green' },
  medium: { label: 'Verify OCR', tone: 'amber' },
  low: { label: 'Low OCR', tone: 'red' },
  unknown: { label: 'OCR', tone: 'grey' },
})

function extractBandFor(confidence) {
  const c = Number(confidence)
  if (!Number.isFinite(c)) return 'unknown'
  if (c >= 0.85) return 'high'
  if (c >= 0.5) return 'medium'
  return 'low'
}

/** Badge for a line's OCR extraction confidence; null when the line has no OCR read. */
export function ExtractConfidenceBadge({ confidence, small = false }) {
  if (confidence == null) return null
  const meta = EXTRACT_BAND_META[extractBandFor(confidence)]
  const t = PALETTE[meta.tone] ?? PALETTE.grey
  return (
    <span
      title="OCR extraction confidence — did the reader get this line right? Separate from the match suggestion; operator confirmation is always required."
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        padding: small ? '2px 8px' : '3px 10px',
        borderRadius: '999px',
        fontSize: small ? '0.66rem' : '0.72rem',
        fontWeight: 700,
        letterSpacing: '0.02em',
        color: t.color,
        background: t.bg,
        border: `1px solid ${t.border}`,
        whiteSpace: 'nowrap',
      }}>
      {meta.label}
      <span style={{ opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>{confidencePct(confidence)}</span>
    </span>
  )
}
