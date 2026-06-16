// ─── Payslip API: Screenshot OCR Extraction (the 2nd server-side route) ───────
// Triggers extraction of a stored payslip SCREENSHOT import into staged
// ParsedLine[] and walks it into the existing review pipeline. Modelled on
// app/api/travel/google/route.js (the established server-route pattern, per memory
// `project_no_server_routes`): authenticated-only, owner-scoped, server-side.
//
// MVP EXTRACTOR = DETERMINISTIC STUB (lib/fat/adapters/stubScreenshotOcrAdapter.js).
// There is NO real OCR / AI / Vision / Textract / PDF here — by design. This route
// validates the extraction FRAMEWORK end-to-end before a real provider is chosen.
// When a real adapter lands it slots in behind runScreenshotExtraction with no
// change to auth, ownership, lifecycle, or the downstream pipeline. (A real provider
// would also download the image bytes here, server-side, and pass them to the
// adapter; the stub needs only the import's file_hash as a deterministic seed, so no
// byte download is performed.)
//
// Auth: the caller MUST forward the Supabase access token (`Authorization: Bearer
// <token>`). We build a per-request fat-schema client carrying that token, so RLS
// enforces owner-only access on every staging read/write — and we additionally
// assert owner == auth uid in the service (defense in depth).
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { runScreenshotExtraction, ExtractionStateError, resolveExtractionAdapter } from '@/lib/fat/services/payslipExtraction'
import { SCREENSHOT_BUCKET } from '@/lib/fat/services/payslipUploads'
import { isPaymentsEnabled } from '@/lib/featureFlags'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RATE_LIMIT_PER_MIN = 20   // OCR is heavier + rarer than a distance lookup

// In-memory rate-limit map: user_id → { count, windowStart }. Per-instance only
// (Vercel may run multiple isolates) — best-effort, like the travel route.
const rateMap = new Map()

function jsonError(status, code, message, extras = {}) {
  return NextResponse.json({ ok: false, code, message, ...extras }, { status })
}

async function authenticate(req) {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization')
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return { ok: false, status: 401, code: 'missing_token' }
  }
  const token = authHeader.slice(7).trim()
  if (!token) return { ok: false, status: 401, code: 'missing_token' }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return { ok: false, status: 500, code: 'server_misconfigured' }

  const authClient = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data, error } = await authClient.auth.getUser(token)
  if (error || !data?.user) return { ok: false, status: 401, code: 'invalid_token' }
  return { ok: true, userId: data.user.id, token, url, anonKey }
}

function rateLimit(userId) {
  const now = Date.now()
  const window = 60_000
  const entry = rateMap.get(userId)
  if (!entry || now - entry.windowStart > window) {
    rateMap.set(userId, { count: 1, windowStart: now })
    return { ok: true }
  }
  if (entry.count >= RATE_LIMIT_PER_MIN) {
    return { ok: false, retryAfterMs: window - (now - entry.windowStart) }
  }
  entry.count++
  return { ok: true }
}

// Map a service-layer state error to the right HTTP status.
function statusForCode(code) {
  switch (code) {
    case 'NOT_FOUND': return 404
    case 'NOT_OWNER': return 403
    case 'WRONG_SOURCE':
    case 'NOT_EXTRACTABLE': return 409
    default: return 400
  }
}

export async function POST(req) {
  // Feature-flag gate (audit P1-5): mirror the Payments UI kill-switch. When
  // Payments is disabled in this environment the route is unavailable BEFORE any
  // auth/work — exactly as the /payments pages short-circuit to PaymentsDisabled.
  if (!isPaymentsEnabled()) {
    return jsonError(503, 'payments_disabled',
      'Payments is not enabled in this environment.')
  }

  const auth = await authenticate(req)
  if (!auth.ok) return jsonError(auth.status, auth.code, 'Not authenticated.')

  const rl = rateLimit(auth.userId)
  if (!rl.ok) {
    return jsonError(429, 'rate_limited', 'Too many extraction requests; slow down.', {
      retryAfterMs: rl.retryAfterMs,
    })
  }

  let body
  try { body = await req.json() }
  catch { return jsonError(400, 'bad_json', 'Request body must be JSON.') }

  const importId = body?.importId
  if (!importId || typeof importId !== 'string') {
    return jsonError(400, 'bad_request', 'importId (string) is required.')
  }

  // ── Hard availability gate (run BEFORE any work) ─────────────────────────────
  // Only the real provider adapter (or, in an explicitly opted-in dev box, the stub)
  // is acceptable here. When no real OCR provider is configured we return 503 and
  // never run the deterministic stub — its lines are fabricated and must never reach
  // a user (e.g. production has no provider key). Manual entry remains the supported
  // path. This is the single non-bypassable guarantee, independent of the UI.
  const adapter = resolveExtractionAdapter()
  if (!adapter) {
    return jsonError(503, 'ocr_unavailable',
      'Automatic payslip OCR is not enabled in this environment. Enter the lines with Manual entry, or ask an administrator to configure an OCR provider.')
  }

  // Per-request fat-schema client carrying the user's JWT → RLS enforces owner-only.
  const client = createClient(auth.url, auth.anonKey, {
    db: { schema: 'fat' },
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${auth.token}` } },
  })

  // The real adapter needs the image bytes — download them owner-scoped from Storage
  // (the same JWT client; storage RLS pins the user's own '<uid>/' prefix). Bytes
  // and the provider key are handled SERVER-SIDE only.
  const loadBytes = async (imp) => {
    if (!imp?.file_ref) throw new Error('Import has no stored image (file_ref missing).')
    const { data, error } = await client.storage.from(SCREENSHOT_BUCKET).download(imp.file_ref)
    if (error || !data) throw new Error(`Could not download the stored image: ${error?.message || 'not found'}.`)
    return new Uint8Array(await data.arrayBuffer())
  }

  try {
    const { import: imp, summary } = await runScreenshotExtraction(
      { importId, ownerId: auth.userId, adapter, loadBytes }, client)
    return NextResponse.json({ ok: true, importId, status: imp.status, summary }, { status: 200 })
  } catch (err) {
    if (err instanceof ExtractionStateError) {
      return jsonError(statusForCode(err.code), err.code.toLowerCase(), err.message)
    }
    // A genuine extraction failure has already stamped the import 'failed' (re-parsable).
    return jsonError(502, 'extraction_failed', err?.message || 'Extraction failed.')
  }
}

// Capability probe for the UI: is automatic OCR extraction available in this
// environment? Lets the client hide the "Extract lines" action instead of offering
// a button that would only ever return 503. No auth required — this reveals only
// whether a provider is configured (a boolean), never any secret or user data.
export async function GET() {
  // When Payments is disabled, the capability probe reports unavailable (P1-5) so
  // the UI hides the Extract action — consistent with the POST gate above.
  if (!isPaymentsEnabled()) {
    return NextResponse.json({ ok: true, available: false }, { status: 200 })
  }
  return NextResponse.json(
    { ok: true, available: resolveExtractionAdapter() !== null },
    { status: 200 },
  )
}
