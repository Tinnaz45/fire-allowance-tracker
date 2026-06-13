// ─── OCR Payslip Import — screenshot upload service ───────────────────────────
// The first REAL ingestion source. Uploads a payslip image into a private,
// owner-scoped Supabase Storage bucket (migration 13) and creates a
// fat.payslip_imports row at status 'uploaded' (source='payslip_screenshot',
// file_ref, file_hash) with ZERO lines — "file stored, not yet parsed" (§ 4.1),
// awaiting future OCR (the ScreenshotIngestAdapter seam).
//
// NO OCR / AI / PDF parsing (constraints). This is strictly additive alongside the
// manual-entry path — createManualEntryImport is untouched.
//
// WIRING NOTE (a documented trap, design risk): Storage lives on the PUBLIC supabase
// client, NOT the `fat` schema client. Table reads/writes use the fat client; the
// bucket uses the public client's `.storage`. Both are injectable so the DEV test can
// pass a single service-role client for both.
//
// Spec: OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 3.3 (file_ref, not bytes-in-PG),
// § 9 (adapter), blocker #2 (storage + RLS). PAYSLIP_SCREENSHOT_UPLOAD_v1.0.md.

import { supabase as defaultStorageClient, fat as defaultClient } from '../../supabaseClient.js'
import { createImport } from './payslipImports.js'
import { screenshotIngestAdapter } from '../adapters/screenshotIngestAdapter.js'
import { PAYSLIP_IMPORTS_TABLE, IMPORT_SOURCE, IMPORT_STATUS } from '../models/payslipImport.js'

// ── Upload policy (mirrors the bucket CHECK in migration 13) ──────────────────
export const SCREENSHOT_BUCKET = 'payslip-screenshots'
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024   // 15 MiB
// image/jpeg covers both JPG and JPEG.
export const ALLOWED_MIME = Object.freeze(['image/png', 'image/jpeg', 'image/webp'])
const MIME_EXT = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })

/** Filename extension for a supported mime, or null if unsupported. */
export function extForMime(mime) {
  return MIME_EXT[String(mime || '').toLowerCase()] ?? null
}

// ── Hashing ───────────────────────────────────────────────────────────────────
/**
 * Lowercase hex SHA-256 of raw bytes via Web Crypto (browser + Node ≥ 20). The
 * digest matches Node's createHash('sha256') over identical bytes, so the DEV test
 * and the browser agree. Used for the image `file_hash` (dedup + content address).
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function sha256Hex(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Read a Blob/File into { bytes, contentType, sizeBytes }. Works for browser File and Node Blob. */
async function readBlob(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('uploadScreenshot: file must be a Blob/File with arrayBuffer().')
  }
  const bytes = await file.arrayBuffer()
  return { bytes, contentType: file.type || '', sizeBytes: file.size ?? bytes.byteLength }
}

// ── Dedup ───────────────────────────────────────────────────────────────────--
/**
 * The owner's existing LIVE import for this exact image (file_hash, stored
 * 'sha256:<hex>'), if any — the pre-upload dedup gate so an identical re-upload
 * doesn't mint a second batch. Newest first.
 *
 * DISCARDED imports are excluded: a 'superseded' or 'rejected' batch is a dead end the
 * operator deliberately abandoned, so re-uploading the same image must mint a FRESH
 * 'uploaded' batch rather than resurrect an un-actionable record (review finding).
 *
 * @returns {Promise<import('../models/payslipImport.js').PayslipImport|null>}
 */
export async function findImportByFileHash({ ownerId, fileHash }, client = defaultClient) {
  if (!ownerId) throw new Error('findImportByFileHash: ownerId is required.')
  if (!fileHash) throw new Error('findImportByFileHash: fileHash is required.')
  const { data, error } = await client
    .from(PAYSLIP_IMPORTS_TABLE)
    .select('*')
    .eq('owner_id', ownerId)
    .eq('file_hash', fileHash)
    .not('status', 'in', '(superseded,rejected)')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`findImportByFileHash failed: ${error.message}`)
  return data ?? null
}

// ── Storage ───────────────────────────────────────────────────────────────────
/**
 * Upload image bytes to the private bucket at '<ownerId>/<sha256hex>.<ext>'. The
 * content-addressed path gives idempotent re-upload (upsert) + free de-dup. Returns
 * the object path used as payslip_imports.file_ref.
 *
 * @returns {Promise<string>}  the storage object path (file_ref)
 */
export async function uploadScreenshotObject(
  { ownerId, bytes, fileHashHex, contentType },
  storageClient = defaultStorageClient,
) {
  if (!ownerId) throw new Error('uploadScreenshotObject: ownerId is required.')
  const ext = extForMime(contentType)
  if (!ext) throw new Error(`uploadScreenshotObject: unsupported content type '${contentType}'.`)
  const path = `${ownerId}/${fileHashHex}.${ext}`
  const { error } = await storageClient.storage
    .from(SCREENSHOT_BUCKET)
    .upload(path, bytes, { contentType, upsert: true })
  if (error) throw new Error(`uploadScreenshotObject failed: ${error.message}`)
  return path
}

/**
 * A short-lived signed URL for a stored screenshot (private bucket) — minted lazily
 * by the review UI from payslip_imports.file_ref. Never persisted.
 *
 * @returns {Promise<string>}
 */
export async function getScreenshotSignedUrl(fileRef, { expiresIn = 3600 } = {}, storageClient = defaultStorageClient) {
  if (!fileRef) throw new Error('getScreenshotSignedUrl: fileRef is required.')
  const { data, error } = await storageClient.storage
    .from(SCREENSHOT_BUCKET)
    .createSignedUrl(fileRef, expiresIn)
  if (error) throw new Error(`getScreenshotSignedUrl failed: ${error.message}`)
  return data?.signedUrl ?? ''
}

/**
 * Delete a stored screenshot object — the correct PII revocation path on
 * retract/reject (signed-URL expiry alone does NOT purge the CDN cache). Owner-scoped
 * by RLS on the authenticated path; service_role for the future server worker.
 */
export async function deleteScreenshotObject(fileRef, storageClient = defaultStorageClient) {
  if (!fileRef) throw new Error('deleteScreenshotObject: fileRef is required.')
  const { error } = await storageClient.storage.from(SCREENSHOT_BUCKET).remove([fileRef])
  if (error) throw new Error(`deleteScreenshotObject failed: ${error.message}`)
}

// ── End-to-end ingest ───────────────────────────────────────────────────────--
/**
 * Ingest a payslip screenshot: hash → dedup-check → upload bytes → create the import
 * row at 'uploaded' with file_ref/file_hash and ZERO lines (no OCR). Mirrors
 * createManualEntryImport's shape but STOPS before parsing — the import rests at
 * 'uploaded' awaiting a future ScreenshotOcrAdapter (§ 4.1).
 *
 * If the owner already has an import for this exact image, no second batch is created
 * — the existing one is returned with `deduped: true`.
 *
 * @param {object} input
 * @param {string} input.ownerId                       fat.profiles.id (= auth uid)
 * @param {Blob|File} input.file                       the image (browser File / Node Blob)
 * @param {string|null} [input.payDate]                operator-supplied batch pay date (ISO)
 * @param {string|null} [input.payPeriodRef]
 * @param {object} [opts]
 * @param {object} [opts.client]                       fat-schema client (tables)
 * @param {object} [opts.storageClient]                client whose .storage to use
 * @returns {Promise<{ import: object, deduped: boolean }>}
 */
export async function createScreenshotImport(input, opts = {}) {
  const { ownerId, file, payDate = null, payPeriodRef = null } = input
  const { client = defaultClient, storageClient = defaultStorageClient } = opts
  if (!ownerId) throw new Error('createScreenshotImport: ownerId is required.')

  const { bytes, contentType, sizeBytes } = await readBlob(file)
  if (!ALLOWED_MIME.includes(String(contentType).toLowerCase())) {
    throw new Error(`createScreenshotImport: unsupported file type '${contentType}'. Use PNG, JPG/JPEG, or WEBP.`)
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    throw new Error(`createScreenshotImport: file is ${(sizeBytes / 1048576).toFixed(1)} MB — the limit is 15 MB.`)
  }

  const hex = await sha256Hex(bytes)
  const fileHash = `sha256:${hex}`

  // Dedup gate — identical image already ingested ⇒ reuse it, no second batch.
  const existing = await findImportByFileHash({ ownerId, fileHash }, client)
  if (existing) return { import: existing, deduped: true }

  // Upload bytes (content-addressed, upsert-safe), then shape provenance metadata.
  const fileRef = await uploadScreenshotObject({ ownerId, bytes, fileHashHex: hex, contentType }, storageClient)
  const parsed = await screenshotIngestAdapter.parse({
    file_ref: fileRef,
    file_hash: fileHash,
    mime: contentType,
    size_bytes: sizeBytes,
    uploaded_at: new Date().toISOString(),
    pay_date: payDate,
    pay_period_ref: payPeriodRef,
  })

  // Create the import row at 'uploaded' with ZERO lines — the resting state. If the
  // row insert fails AFTER the upload, the object would be an orphaned PII blob with
  // no DB pointer — best-effort delete it before rethrowing (review finding). The
  // content-addressed path makes a later identical retry self-heal regardless.
  let imp
  try {
    imp = await createImport({
      ownerId,
      source: IMPORT_SOURCE.PAYSLIP_SCREENSHOT,
      status: IMPORT_STATUS.UPLOADED,
      fileRef,
      fileHash,
      payDate: parsed.pay_date,
      payPeriodRef: parsed.pay_period_ref,
      parserName: parsed.parser_name,
      parserVersion: parsed.parser_version,
      rawExtract: parsed.raw_extract,
    }, client)
  } catch (err) {
    try { await deleteScreenshotObject(fileRef, storageClient) } catch { /* best-effort orphan cleanup */ }
    throw err
  }

  return { import: imp, deduped: false }
}
