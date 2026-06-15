// ─── Browser helper: trigger screenshot OCR extraction ────────────────────────
// Calls the server-side /api/payslip/extract route, forwarding the Supabase access
// token exactly like lib/distance/googleRouting.js does for the travel route. The
// extractor is a deterministic STUB server-side (no real OCR/AI) — this helper does
// not know or care; it just kicks the import from 'uploaded'/'failed' into the
// review pipeline and returns the summary.

import { supabase } from '@/lib/supabaseClient'

async function getAccessToken() {
  const { data, error } = await supabase.auth.getSession()
  if (error || !data?.session?.access_token) {
    throw new Error('Not signed in — sign in again to refresh your session.')
  }
  return data.session.access_token
}

/**
 * Probe whether automatic OCR extraction is available here (a real provider is
 * configured server-side). The UI uses this to hide the "Extract lines" action when
 * extraction would only ever return 503. Never throws — resolves false on any error,
 * so a probe failure fails safe (extraction hidden).
 *
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<boolean>}
 */
export async function getOcrAvailability(opts = {}) {
  try {
    const res = await fetch('/api/payslip/extract', {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: opts.signal,
    })
    const body = await res.json()
    return res.ok && body?.ok === true && body?.available === true
  } catch {
    return false
  }
}

/**
 * Request extraction of a stored screenshot import. Resolves with the route's
 * summary; rejects with a typed error (err.code) on a guard/auth/extraction failure.
 *
 * @param {string} importId
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ ok: true, importId: string, status: string, summary: object }>}
 */
export async function requestExtraction(importId, opts = {}) {
  if (!importId) throw new Error('requestExtraction: importId is required.')

  const token = await getAccessToken()
  const res = await fetch('/api/payslip/extract', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ importId }),
    signal: opts.signal,
  })

  let bodyJson
  try { bodyJson = await res.json() }
  catch { throw new Error('Extraction API returned invalid JSON.') }

  if (!res.ok || !bodyJson?.ok) {
    const msg = bodyJson?.message
      || (bodyJson?.code ? `Extraction error (${bodyJson.code}).` : 'Extraction error.')
    const err = new Error(msg)
    err.code = bodyJson?.code || `http_${res.status}`
    err.detail = bodyJson
    throw err
  }
  return bodyJson
}
