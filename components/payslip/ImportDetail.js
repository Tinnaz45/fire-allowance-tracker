'use client'

// ─── ImportDetail ─────────────────────────────────────────────────────────────
// The selected import expanded: its lifecycle (objective 3), its staged lines
// (objective 4), and per-line review via ImportLineRow (objectives 5–9). Offers an
// import-level Supersede where the lifecycle permits it (a pre-confirm batch the
// operator is discarding, § 4.1) — superseding is terminal and is the only
// import-level mutation the MVP exposes (confirm/reject happen per line and the
// import auto-advances to 'confirmed' when no line is left open, § 6.1 step 5).
//
// Payslip-line candidates (pending, payslip-routed entitlements) are loaded once
// here and passed to every line so the confirm picker is consistent and cheap.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react'
import {
  getImport,
  listImportLines,
  updateImportStatus,
} from '@/lib/fat/services/payslipImports'
import { listPendingPayslip } from '@/lib/fat/services/reconciliationQueues'
import { scoreImportLines } from '@/lib/fat/services/payslipMatcher'
import { detectImportDuplicates, listConfirmedLineFingerprints } from '@/lib/fat/services/payslipDuplicates'
import { getScreenshotSignedUrl } from '@/lib/fat/services/payslipUploads'
import { requestExtraction, getOcrAvailability } from '@/lib/payslip/extractClient'
import { canTransitionImport, isImportTerminal, IMPORT_SOURCE } from '@/lib/fat/models/payslipImport'
import {
  CARD_STYLE, SectionHeading, EmptyState, Banner, GHOST_BTN, PRIMARY_BTN, fmtDate, fmtDateTime,
} from '@/components/reconciliation/ui'
import { ImportStatusBadge, importSourceLabel } from './statusUi'
import ImportLineRow from './ImportLineRow'
import DuplicateWarning from './DuplicateWarning'

// ── Screenshot preview: lazily mint a short-lived signed URL from file_ref ──────
// The image lives in a PRIVATE bucket (migration 13); it is never publicly
// addressable. We fetch a 1-hour signed URL on demand for the operator to eyeball
// what was uploaded while extraction is still pending.
function ScreenshotPreview({ fileRef }) {
  const [url, setUrl] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    setUrl(null); setError(null)
    if (!fileRef) return
    getScreenshotSignedUrl(fileRef, { expiresIn: 3600 })
      .then((u) => { if (alive) setUrl(u) })
      .catch((e) => { if (alive) setError(e.message || 'Could not load image.') })
    return () => { alive = false }
  }, [fileRef])

  if (error) return <Banner tone="error">{error}</Banner>
  if (!url) return <EmptyState>Loading image…</EmptyState>
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt="Uploaded payslip screenshot"
      style={{ maxWidth: '100%', maxHeight: '480px', borderRadius: '10px', border: '1px solid #2a2a2a', display: 'block' }}
    />
  )
}

export default function ImportDetail({ importId, ownerId, reloadToken, onChanged, onSelectImport }) {
  const [imp, setImp] = useState(null)
  const [lines, setLines] = useState([])
  const [candidates, setCandidates] = useState([])
  const [confirmedFps, setConfirmedFps] = useState(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [superseding, setSuperseding] = useState(false)
  const [rematching, setRematching] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const [extracting, setExtracting] = useState(false)
  // Whether automatic OCR extraction is available server-side (a real provider is
  // configured). Defaults false so the Extract action stays hidden until proven
  // available — fail-safe, and never surfaces the fabricating stub.
  const [ocrAvailable, setOcrAvailable] = useState(false)

  const load = useCallback(async () => {
    if (!importId || !ownerId) return
    setLoading(true)
    setError(null)
    try {
      const [impRow, lineRows, cand, confirmed, ocrOk] = await Promise.all([
        getImport(importId),
        listImportLines(importId),
        listPendingPayslip(ownerId),
        listConfirmedLineFingerprints(ownerId),
        getOcrAvailability(),
      ])
      setImp(impRow)
      setLines(lineRows)
      setCandidates(cand)
      setOcrAvailable(ocrOk)
      // fingerprint → an already-confirmed line that settled identical content.
      setConfirmedFps(new Map(confirmed.map((c) => [c.content_fingerprint, c])))
    } catch (err) {
      setError(err.message || 'Failed to load import.')
    } finally {
      setLoading(false)
    }
  }, [importId, ownerId])

  useEffect(() => { load() }, [load, reloadToken])

  // Refresh this panel AND the parent list (status badges may have changed).
  const handleChanged = useCallback(() => {
    load()
    onChanged?.()
  }, [load, onChanged])

  const handleSupersede = async () => {
    setError(null)
    setSuperseding(true)
    try {
      await updateImportStatus({ importId, status: 'superseded' })
      handleChanged()
    } catch (err) {
      setError(err.message || 'Failed to supersede import.')
    } finally {
      setSuperseding(false)
    }
  }

  if (loading) {
    return <div style={CARD_STYLE}><EmptyState>Loading import…</EmptyState></div>
  }
  if (error && !imp) {
    return <div style={CARD_STYLE}><Banner tone="error">{error}</Banner></div>
  }
  if (!imp) {
    return <div style={CARD_STYLE}><EmptyState>Import not found.</EmptyState></div>
  }

  const canSupersede = canTransitionImport(imp.status, 'superseded')
  // A screenshot import is the first real ingestion source: stored image, ZERO lines,
  // resting at 'uploaded' until OCR lands. Suppress the line-oriented affordances.
  const isScreenshot = imp.source === IMPORT_SOURCE.PAYSLIP_SCREENSHOT
  const awaitingExtraction = isScreenshot && lines.length === 0
  // Extraction runs the real OCR adapter server-side, materializing lines and walking
  // the import into the review pipeline. Only from a pre-extraction state (uploaded)
  // or a re-parsable failure (failed) — the idempotency guard — AND only when a real
  // OCR provider is configured (ocrAvailable). When unavailable the action is hidden
  // and the route returns 503, so the fabricating stub never reaches the operator.
  const inExtractableState = isScreenshot && ['uploaded', 'failed'].includes(imp.status)
  const canExtract = inExtractableState && ocrAvailable

  const handleExtract = async () => {
    setError(null)
    setExtracting(true)
    try {
      await requestExtraction(importId)
      handleChanged()
    } catch (err) {
      setError(err.message || 'Failed to extract lines.')
    } finally {
      setExtracting(false)
    }
  }
  // Re-run the matcher (Step O4) — useful after entitlements are created/routed or
  // a line is edited. Only meaningful while the import is still open (non-terminal).
  const canRematch = !isImportTerminal(imp.status) && lines.length > 0

  const handleRematch = async () => {
    setError(null)
    setRematching(true)
    try {
      await scoreImportLines({ importId, ownerId })
      handleChanged()
    } catch (err) {
      setError(err.message || 'Failed to re-run matching.')
    } finally {
      setRematching(false)
    }
  }

  // Re-run duplicate detection (objective 6) — useful after editing lines or after
  // other imports change. Advisory; persists a fresh duplicate_check verdict.
  const handleRecheck = async () => {
    setError(null)
    setRechecking(true)
    try {
      await detectImportDuplicates({ importId, ownerId })
      handleChanged()
    } catch (err) {
      setError(err.message || 'Failed to re-check duplicates.')
    } finally {
      setRechecking(false)
    }
  }

  return (
    <div style={CARD_STYLE}>
      <SectionHeading
        title={`${importSourceLabel(imp.source)} import`}
        subtitle={`Pay ${fmtDate(imp.pay_date)}${imp.pay_period_ref ? ` · ${imp.pay_period_ref}` : ''} · ${imp.line_count} line${imp.line_count === 1 ? '' : 's'}`}
        right={<ImportStatusBadge status={imp.status} />}
      />

      {/* Lifecycle meta (objective 3) */}
      <div style={{
        display: 'flex', gap: '16px', flexWrap: 'wrap',
        fontSize: '0.74rem', color: '#6b7280', marginBottom: '14px',
      }}>
        <span>Created {fmtDateTime(imp.created_at)}</span>
        {imp.confirmed_at && <span>Confirmed {fmtDateTime(imp.confirmed_at)}</span>}
        {imp.parser_name && <span>Parser {imp.parser_name} v{imp.parser_version}</span>}
      </div>

      {imp.error && (
        <div style={{ marginBottom: '14px' }}><Banner tone="error">Import error: {imp.error}</Banner></div>
      )}

      {/* Duplicate verdict (objectives 4–6) */}
      <DuplicateWarning check={imp.duplicate_check} onSelectImport={onSelectImport} />

      {/* Stored screenshot preview + awaiting-extraction state (first ingestion source) */}
      {isScreenshot && imp.file_ref && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
            Uploaded image
          </div>
          <ScreenshotPreview fileRef={imp.file_ref} />
          {canExtract && (
            <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={handleExtract}
                disabled={extracting}
                style={extracting ? { ...PRIMARY_BTN, opacity: 0.6 } : PRIMARY_BTN}
                title="Run OCR extraction and materialize lines for review (every line is still operator-confirmed)"
              >
                {extracting
                  ? 'Extracting…'
                  : imp.status === 'failed' ? 'Retry extraction' : 'Extract lines'}
              </button>
              <span style={{ fontSize: '0.72rem', color: '#6b7280' }}>
                Reads the image into reviewable lines. Every line still requires your confirmation.
              </span>
            </div>
          )}
          {inExtractableState && !ocrAvailable && (
            <div style={{ marginTop: '12px' }}>
              <Banner tone="info">
                Automatic OCR extraction isn’t enabled in this environment. Your screenshot is
                stored securely — add its lines with <strong>Manual entry</strong> for now, or
                extract here once an OCR provider is configured.
              </Banner>
            </div>
          )}
        </div>
      )}

      {canSupersede && (
        <div style={{ marginBottom: '16px' }}>
          <button
            type="button"
            onClick={handleSupersede}
            disabled={superseding}
            style={{ ...GHOST_BTN, opacity: superseding ? 0.6 : 1 }}
          >
            {superseding ? 'Superseding…' : 'Supersede import'}
          </button>
          <span style={{ marginLeft: '10px', fontSize: '0.72rem', color: '#6b7280' }}>
            Discards this pre-confirm batch. Terminal — confirmed lines already produced records are unaffected.
          </span>
        </div>
      )}

      {error && <div style={{ marginBottom: '12px' }}><Banner tone="error">{error}</Banner></div>}

      {/* Lines (objective 4) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
        <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#f9fafb' }}>
          Lines ({lines.length})
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {!isImportTerminal(imp.status) && !isScreenshot && (
            <button
              type="button"
              onClick={handleRecheck}
              disabled={rechecking}
              style={{ ...GHOST_BTN, opacity: rechecking ? 0.6 : 1 }}
              title="Re-check this import against your other imports for duplicates"
            >
              {rechecking ? 'Checking…' : 'Re-check duplicates'}
            </button>
          )}
          {canRematch && (
            <button
              type="button"
              onClick={handleRematch}
              disabled={rematching}
              style={{ ...GHOST_BTN, opacity: rematching ? 0.6 : 1 }}
              title="Re-score every open line against your pending payslip entitlements"
            >
              {rematching ? 'Matching…' : 'Re-run matching'}
            </button>
          )}
        </div>
      </div>
      {lines.length === 0 ? (
        awaitingExtraction ? (
          <EmptyState>
            {imp.status === 'failed'
              ? `Extraction failed — see the error above.${ocrAvailable ? ' Use “Retry extraction” to run it again.' : ''}`
              : ocrAvailable
                ? 'Awaiting extraction — the image is stored, but no lines have been read yet. Use “Extract lines” above to read it into reviewable lines.'
                : 'The image is stored securely. Automatic extraction isn’t enabled in this environment — add its lines with Manual entry above, or extract here once OCR is configured.'}
          </EmptyState>
        ) : (
          <EmptyState>This import has no lines.</EmptyState>
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {lines.map((line) => (
            <ImportLineRow
              key={line.id}
              line={line}
              ownerId={ownerId}
              candidates={candidates}
              confirmedFps={confirmedFps}
              onChanged={handleChanged}
            />
          ))}
        </div>
      )}
    </div>
  )
}
