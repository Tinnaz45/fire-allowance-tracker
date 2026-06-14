// ─── Real screenshot OCR adapter (production-capable, provider-pluggable) ──────
// The drop-in that REPLACES StubScreenshotOcrAdapter as the production extraction
// path (OCR_EXTRACTION_MVP_v1.0.md § 5–7, roadmap O10). It implements the EXACT
// same ParserAdapter contract the stub did — so runScreenshotExtraction, the
// lifecycle, the matcher, duplicate detection, and the review UI are ALL unchanged.
// The only difference from the stub is that `parse()` reads real pixels through a
// vision model instead of synthesizing deterministic lines.
//
// PROVIDER: a vision-capable LLM called over plain REST (global fetch — NO new
// dependencies, mirroring app/api/travel/google/route.js, per memory
// `project_no_server_routes`). Default backend = OpenAI Vision (the app's
// configured provider, OPENAI_API_KEY); an Anthropic backend is selectable via
// PAYSLIP_OCR_PROVIDER for a gateway/Anthropic key. The model is swappable via
// PAYSLIP_OCR_MODEL without a code change. Keys are SERVER-ONLY — this module must
// only ever run server-side (the extraction route), never in the browser.
//
// WHY a vision LLM over raw OCR (Tesseract / Google Vision / Textract): the output
// must be STRUCTURED payslip lines, not page text. A vision LLM emits the canonical
// ParsedLine shape directly, collapsing OCR + layout reconstruction + field mapping
// into one call. The provider stays a swappable detail behind this adapter.
//
// HARD GUARANTEES (so nothing downstream changes):
//   · returns the canonical ParseResult; lines carry the same fields the stub did,
//     PLUS extract_confidence + extract_meta (peeled off by the service → migration 14).
//   · NEVER auto-confirms — it only proposes parsed lines; every line is still
//     operator-confirmed (constraint). · NEVER touches the match score.
//   · LENIENT normalization: untrusted model output is coerced safely (never throws
//     on one bad field — a malformed amount/date becomes null + lowers confidence),
//     unlike the manual adapter's strict normalizeLine which rejects bad input.

import { ParserAdapter } from './manualEntryAdapter.js'
import { IMPORT_SOURCE, IMPORT_SOURCE_VALUES } from '../models/payslipImport.js'

// ── Provider configuration ─────────────────────────────────────────────────────
export const OCR_PROVIDER = (process.env.PAYSLIP_OCR_PROVIDER || 'openai').toLowerCase()
export const OCR_MODEL = process.env.PAYSLIP_OCR_MODEL
  || (OCR_PROVIDER === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-4o-mini')

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
const OCR_TIMEOUT_MS = Number(process.env.PAYSLIP_OCR_TIMEOUT_MS || 30000)

/**
 * Is a real OCR provider configured (a key for the selected provider)? The route
 * uses this to choose the real adapter vs the deterministic stub fallback, so a
 * keyless DEV box still runs the validated framework. PAYSLIP_OCR_PROVIDER='stub'
 * forces the stub.
 */
export function isOcrConfigured() {
  if (OCR_PROVIDER === 'stub') return false
  if (OCR_PROVIDER === 'anthropic') return !!process.env.ANTHROPIC_API_KEY
  return !!process.env.OPENAI_API_KEY
}

// ── Extraction prompt (FRV payslip vocabulary) ─────────────────────────────────
const SYSTEM_PROMPT = [
  'You are a precise payslip data extractor for Fire Rescue Victoria (FRV) allowance payslips.',
  'You receive ONE image of a payslip (or a screenshot of one).',
  'Extract every distinct allowance / payment LINE you can read. Do NOT invent lines.',
  'Return STRICT JSON only — no prose, no markdown fences — with this exact shape:',
  '{',
  '  "pay_date": "YYYY-MM-DD" | null,',
  '  "pay_period_ref": string | null,',
  '  "lines": [',
  '    {',
  '      "reference": string | null,        // the line code / short label, e.g. "EXCESS TRAVEL STANDBY"',
  '      "description": string | null,      // longer narrative if present',
  '      "amount": number | null,           // gross dollar amount as a plain number (no $ or commas)',
  '      "date": "YYYY-MM-DD" | null,       // line-level date if shown, else null',
  '      "payment_stream": "payslip" | "petty_cash" | null,  // best guess if indicated',
  '      "confidence": number,              // YOUR confidence this line was read correctly, 0..1',
  '      "field_confidence": { "reference": number, "amount": number, "date": number }',
  '    }',
  '  ]',
  '}',
  'If a value is unreadable, use null and lower the relevant confidence. Never guess an amount you cannot read.',
].join('\n')

const USER_TEXT = 'Extract all payslip allowance lines from this image as the specified JSON object.'

// ── Lenient coercion (untrusted model output — must never throw on one bad field) ─
function str(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
/** → { value:number|null, ok:boolean }. ok=false means a value was present but unparseable. */
function coerceMoney(v) {
  if (v === null || v === undefined || v === '') return { value: null, ok: true }
  const n = Number(String(v).replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n) || n < 0) return { value: null, ok: false }
  return { value: Math.round(n * 100) / 100, ok: true }
}
/** → { value:'YYYY-MM-DD'|null, ok:boolean }. */
function coerceDate(v) {
  const s = str(v)
  if (!s) return { value: null, ok: true }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { value: s, ok: true }
  const d = new Date(s)
  if (!Number.isNaN(d.getTime())) return { value: d.toISOString().slice(0, 10), ok: true }
  return { value: null, ok: false }
}
function clamp01(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return null
  return Math.max(0, Math.min(1, x))
}

/**
 * Derive the persisted extract_confidence: the model's self-reported confidence
 * FLOORED by deterministic sanity checks, so a confidently-wrong model cannot claim
 * 0.99 on an unparseable amount (OCR_EXTRACTION_MVP § 8). Returns 4dp in [0,1].
 */
function deriveConfidence(modelConf, checks) {
  let sanity = 1
  if (!checks.amountOk) sanity *= 0.35              // amount is the load-bearing field
  if (!checks.dateOk) sanity *= 0.7
  if (!checks.hasLabel) sanity *= 0.3               // no reference AND no description
  const mc = clamp01(modelConf)
  const base = mc == null ? 0.6 : mc                // no self-report → neutral prior
  return Math.round(Math.min(base, sanity) * 10000) / 10000
}

/**
 * Normalize ONE raw model line into a canonical ParsedLine + extraction signals.
 * Lenient: bad fields become null and lower the confidence; this never throws.
 */
export function normalizeOcrLine(raw, index) {
  const reference = str(raw?.reference)
  const description = str(raw?.description)
  const amount = coerceMoney(raw?.amount)
  const date = coerceDate(raw?.date)
  const checks = {
    amountOk: amount.ok,
    dateOk: date.ok,
    hasLabel: !!(reference || description),
  }
  const extract_confidence = deriveConfidence(raw?.confidence, checks)
  const stream = str(raw?.payment_stream)
  return {
    line_index: index,
    raw_text: str(raw?.raw_text) || [reference, amount.value != null ? amount.value.toFixed(2) : null].filter(Boolean).join('  ') || null,
    parsed_reference: reference,
    parsed_description: description,
    parsed_amount: amount.value,
    parsed_date: date.value,
    extract_confidence,
    extract_meta: {
      adapter: 'screenshot_ocr',
      provider: OCR_PROVIDER,
      model: OCR_MODEL,
      payment_stream: ['payslip', 'petty_cash'].includes(stream) ? stream : null,
      model_confidence: clamp01(raw?.confidence),
      field_confidence: raw?.field_confidence ?? null,
      sanity: { amount_ok: checks.amountOk, date_ok: checks.dateOk, has_label: checks.hasLabel },
      verbatim_text: str(raw?.raw_text) ?? null,
    },
  }
}

// ── JSON parsing of a model text response (tolerant of code fences) ─────────────
export function parseModelJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('OCR provider returned an empty response.')
  }
  let body = text.trim()
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) body = fence[1].trim()
  else {
    const first = body.indexOf('{')
    const last = body.lastIndexOf('}')
    if (first > 0 && last > first) body = body.slice(first, last + 1)
  }
  let obj
  try { obj = JSON.parse(body) }
  catch { throw new Error('OCR provider returned unparseable JSON.') }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.lines)) {
    throw new Error('OCR provider JSON is missing a `lines` array.')
  }
  return obj
}

// ── Network helpers ─────────────────────────────────────────────────────────────
async function fetchWithTimeout(url, opts, ms = OCR_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try { return await fetch(url, { ...opts, signal: ctrl.signal }) }
  finally { clearTimeout(timer) }
}

function toBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  // Buffer is available in the Node server runtime (Fluid Compute).
  return Buffer.from(u8).toString('base64')
}

/** OpenAI Vision (chat/completions, JSON-object response). Server-side only. */
async function extractViaOpenAI({ bytes, mime }) {
  const key = process.env.OPENAI_API_KEY
  if (!key) { const e = new Error('OpenAI OCR not configured (OPENAI_API_KEY missing).'); e.code = 'no_provider_key'; throw e }
  const dataUrl = `data:${mime || 'image/png'};base64,${toBase64(bytes)}`
  let res
  try {
    res = await fetchWithTimeout(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OCR_MODEL,
        temperature: 0,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'text', text: USER_TEXT },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ] },
        ],
      }),
    })
  } catch (err) {
    const e = new Error(err?.name === 'AbortError' ? 'OpenAI OCR timed out.' : `OpenAI OCR network error: ${err.message}`)
    e.code = err?.name === 'AbortError' ? 'timeout' : 'network_error'
    throw e
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const e = new Error(`OpenAI OCR HTTP ${res.status}: ${body.slice(0, 200)}`)
    e.code = res.status === 401 ? 'provider_unauthorized' : `http_${res.status}`
    throw e
  }
  const json = await res.json().catch(() => null)
  const text = json?.choices?.[0]?.message?.content
  const parsed = parseModelJson(text)
  return { ...parsed, _usage: json?.usage ?? null }
}

/** Anthropic Vision (messages API). Server-side only. Selectable via PAYSLIP_OCR_PROVIDER. */
async function extractViaAnthropic({ bytes, mime }) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) { const e = new Error('Anthropic OCR not configured (ANTHROPIC_API_KEY missing).'); e.code = 'no_provider_key'; throw e }
  let res
  try {
    res = await fetchWithTimeout(`${ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OCR_MODEL,
        max_tokens: 1500,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mime || 'image/png', data: toBase64(bytes) } },
          { type: 'text', text: `${USER_TEXT} Return ONLY the JSON object.` },
        ] }],
      }),
    })
  } catch (err) {
    const e = new Error(err?.name === 'AbortError' ? 'Anthropic OCR timed out.' : `Anthropic OCR network error: ${err.message}`)
    e.code = err?.name === 'AbortError' ? 'timeout' : 'network_error'
    throw e
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const e = new Error(`Anthropic OCR HTTP ${res.status}: ${body.slice(0, 200)}`)
    e.code = res.status === 401 ? 'provider_unauthorized' : `http_${res.status}`
    throw e
  }
  const json = await res.json().catch(() => null)
  const text = Array.isArray(json?.content) ? json.content.map((c) => c?.text ?? '').join('') : ''
  const parsed = parseModelJson(text)
  return { ...parsed, _usage: json?.usage ?? null }
}

/** Dispatch to the configured provider. Injectable as `generate` for testing. */
export async function defaultGenerate(input) {
  if (OCR_PROVIDER === 'anthropic') return extractViaAnthropic(input)
  return extractViaOpenAI(input)
}

/**
 * ScreenshotOcrAdapter — the real extraction adapter. Same ParserAdapter contract
 * as the stub; the ONLY difference is `parse()` reads pixels through a vision model.
 */
export class ScreenshotOcrAdapter extends ParserAdapter {
  name = 'screenshot_ocr'
  version = '1.0.0'
  source = IMPORT_SOURCE.PAYSLIP_SCREENSHOT

  /**
   * @param {object} [deps]
   * @param {(input:{bytes:Uint8Array,mime:string})=>Promise<object>} [deps.generate]
   *        the model call — injectable so tests exercise the full adapter with NO network.
   */
  constructor({ generate } = {}) {
    super()
    this._generate = generate || defaultGenerate
  }

  /**
   * @param {object} input
   * @param {Uint8Array} input.bytes   the image bytes (the route downloads them from Storage)
   * @param {string} [input.mime]
   * @param {string} [input.file_ref]
   * @param {string} [input.file_hash]
   * @param {object} [ctx]
   * @param {string|null} [ctx.pay_date]   fallback batch pay date
   * @returns {Promise<import('./manualEntryAdapter.js').ParseResult>}
   */
  async parse(input, ctx = {}) {
    if (!input || typeof input !== 'object') {
      throw new Error('ScreenshotOcrAdapter: input must include the image bytes.')
    }
    if (!input.bytes || !(input.bytes instanceof Uint8Array || ArrayBuffer.isView(input.bytes))) {
      const e = new Error('ScreenshotOcrAdapter: image bytes are required (download the object first).')
      e.code = 'no_image_bytes'
      throw e
    }
    const mime = input.mime || 'image/png'
    const raw = await this._generate({ bytes: input.bytes, mime })
    const rawLines = Array.isArray(raw?.lines) ? raw.lines : []
    const lines = rawLines.map((l, i) => normalizeOcrLine(l, i))

    return {
      pay_date: coerceDate(raw?.pay_date).value ?? ctx.pay_date ?? null,
      pay_period_ref: str(raw?.pay_period_ref),
      raw_extract: {
        adapter: this.name,
        version: this.version,
        extraction: 'ocr',                    // ← real read (vs 'pending'/'stub')
        provider: OCR_PROVIDER,
        model: OCR_MODEL,
        file_ref: input.file_ref ?? null,
        file_hash: input.file_hash ?? null,
        line_count: lines.length,
        usage: raw?._usage ?? null,
      },
      lines,
      parser_name: this.name,
      parser_version: this.version,
    }
  }
}

/** Default instance — the route uses this when a provider is configured. */
export const screenshotOcrAdapter = new ScreenshotOcrAdapter()

// Guard: keep the adapter's declared source inside the canonical import-source set.
if (!IMPORT_SOURCE_VALUES.includes(screenshotOcrAdapter.source)) {
  throw new Error(`ScreenshotOcrAdapter.source '${screenshotOcrAdapter.source}' is not a canonical import source.`)
}
