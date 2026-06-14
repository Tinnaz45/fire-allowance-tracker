'use client'

// ─── ScreenshotUploadForm ─────────────────────────────────────────────────────
// Objective 3 — the FIRST real ingestion source: the operator uploads a payslip
// screenshot (PNG / JPG / JPEG / WEBP). The image is stored privately + owner-scoped
// (migration 13) and a payslip_imports row is created at status 'uploaded' with
// file_ref + file_hash and ZERO lines — held for future OCR extraction.
//
// There is NO OCR / AI / PDF parsing here (constraints): this only captures + stores
// the file. The manual-entry path (CreateImportForm) is unchanged and sits above it.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect } from 'react'
import { createScreenshotImport, ALLOWED_MIME, MAX_UPLOAD_BYTES } from '@/lib/fat/services/payslipUploads'
import {
  CARD_STYLE, INPUT_STYLE, LABEL_STYLE, PRIMARY_BTN, GHOST_BTN, disabledBtn,
  Banner, SectionHeading,
} from '@/components/reconciliation/ui'

function todayISO() {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10)
}

const ACCEPT = 'image/png,image/jpeg,image/webp'

export default function ScreenshotUploadForm({ ownerId, onCreated }) {
  const [file, setFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [payDate, setPayDate] = useState(todayISO())
  const [payPeriodRef, setPayPeriodRef] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)
  const inputRef = useRef(null)
  const successTimer = useRef(null)

  // Revoke the object URL when the preview changes / the component unmounts.
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])
  // Clear any pending success-banner timer on unmount (no setState after unmount).
  useEffect(() => () => { if (successTimer.current) clearTimeout(successTimer.current) }, [])

  const pickFile = (f) => {
    setError(null)
    setSuccess(null)
    if (!f) return
    if (!ALLOWED_MIME.includes(String(f.type).toLowerCase())) {
      setError('Unsupported file type. Use PNG, JPG/JPEG, or WEBP.')
      return
    }
    if (f.size > MAX_UPLOAD_BYTES) {
      setError(`That image is ${(f.size / 1048576).toFixed(1)} MB — the limit is 15 MB.`)
      return
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(f)
    setPreviewUrl(URL.createObjectURL(f))
  }

  const reset = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(null)
    setPreviewUrl(null)
    setPayPeriodRef('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    if (!file) { setError('Choose a payslip image to upload.'); return }

    setSubmitting(true)
    try {
      const { import: imp, deduped } = await createScreenshotImport({
        ownerId,
        file,
        payDate: payDate || null,
        payPeriodRef: payPeriodRef.trim() || null,
      })
      setSuccess(deduped
        ? 'That exact image was already uploaded — opening the existing import.'
        : 'Screenshot uploaded and stored — held for extraction (no OCR yet).')
      reset()
      onCreated?.(imp)
      if (successTimer.current) clearTimeout(successTimer.current)
      successTimer.current = setTimeout(() => setSuccess(null), 5000)
    } catch (err) {
      setError(err.message || 'Failed to upload the screenshot.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={CARD_STYLE}>
      <SectionHeading
        title="Upload payslip screenshot"
        subtitle="Store a payslip image as an import. No OCR yet — the image is saved securely and held for extraction later."
      />

      <form onSubmit={handleSubmit} noValidate>
        {/* File picker + preview */}
        <label style={LABEL_STYLE}>Payslip image (PNG, JPG/JPEG, WEBP — max 15 MB)</label>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          style={{ ...INPUT_STYLE, padding: '8px', cursor: 'pointer' }}
        />

        {previewUrl && (
          <div style={{ marginTop: '12px' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="Selected payslip preview"
              style={{
                maxWidth: '100%', maxHeight: '320px', borderRadius: '10px',
                border: '1px solid #2a2a2a', display: 'block',
              }}
            />
            <div style={{ marginTop: '6px', fontSize: '0.72rem', color: '#6b7280' }}>
              {file?.name} · {(file?.size / 1024).toFixed(0)} KB · {file?.type}
            </div>
          </div>
        )}

        {/* Optional batch metadata */}
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '16px' }}>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}>
            <label style={LABEL_STYLE}>Pay date (optional)</label>
            <input
              type="date"
              value={payDate}
              onChange={(e) => setPayDate(e.target.value)}
              style={{ ...INPUT_STYLE, colorScheme: 'dark' }}
            />
          </div>
          <div style={{ flex: '1 1 180px', minWidth: 0 }}>
            <label style={LABEL_STYLE}>Pay period ref (optional)</label>
            <input
              type="text" placeholder="e.g. PP-13"
              value={payPeriodRef}
              onChange={(e) => setPayPeriodRef(e.target.value)}
              style={INPUT_STYLE}
            />
          </div>
        </div>

        <p style={{ margin: '10px 0 0', fontSize: '0.72rem', color: '#6b7280', lineHeight: 1.5 }}>
          The image is stored privately (only you can view it). Extraction into payslip lines is not built yet —
          the upload is tracked as an import that is ready for OCR when that lands.
        </p>

        {error && <div style={{ marginTop: '14px' }}><Banner tone="error">{error}</Banner></div>}
        {success && <div style={{ marginTop: '14px' }}><Banner tone="success">✓ {success}</Banner></div>}

        <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
          <button type="submit" disabled={submitting || !file} style={(submitting || !file) ? disabledBtn(PRIMARY_BTN) : PRIMARY_BTN}>
            {submitting ? 'Uploading…' : 'Upload screenshot'}
          </button>
          {file && <button type="button" onClick={reset} disabled={submitting} style={GHOST_BTN}>Clear</button>}
        </div>
      </form>
    </div>
  )
}
