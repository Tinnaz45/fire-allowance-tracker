# Fire Allowance Tracker — OCR Extraction MVP (O10): Design & Implementation Plan

Version: v1.0
Status: **Framework BUILT in DEV with a deterministic stub adapter** (X1–X8 done; no real OCR provider yet — that remains § 7's deferred decision). Original design below unchanged.
Last Updated: 2026-06-05
Branch: `dev`

> **Build note (2026-06-05).** The extraction *framework* is implemented and validated
> in DEV using `StubScreenshotOcrAdapter` (deterministic, no provider). Delivered:
> migration `14_payslip_extract_confidence.sql` (additive `extract_confidence` +
> `extract_meta`); `lib/fat/adapters/stubScreenshotOcrAdapter.js`;
> `lib/fat/services/payslipExtraction.js` (`runScreenshotExtraction`);
> `app/api/payslip/extract/route.js` (2nd server route); `lib/payslip/extractClient.js`;
> UI wiring (Extract-lines action + OCR-confidence badge); and
> `scripts/test-payslip-extraction.mjs` (**49/49**, no regression: import 55/55, matcher
> 41/41, duplicates 32/32, screenshot 40/40). The real provider (§ 6–7) is the only
> remaining piece and slots in behind `runScreenshotExtraction` unchanged.

> **Real-provider build note (2026-06-05).** The real `ScreenshotOcrAdapter` is now
> implemented (`lib/fat/adapters/screenshotOcrAdapter.js`) — production-capable,
> provider-pluggable (OpenAI Vision default via the app's `OPENAI_API_KEY`, Anthropic
> selectable via `PAYSLIP_OCR_PROVIDER`), zero new dependencies (direct REST via
> `fetch`, mirroring the Google route). It populates `ParsedLine[]` + `extract_confidence`
> (model self-report **floored** by deterministic sanity checks) + `extract_meta`, with
> lenient normalization (a bad field becomes null + lowers confidence, never throws).
> `runScreenshotExtraction` gained an **additive** `loadBytes` hook; the route downloads
> the image owner-scoped and selects the real adapter when `isOcrConfigured()`, else the
> stub (keyless DEV still works). Provider failures (timeout/network/HTTP/malformed-JSON/
> zero-line) → import `failed` + error, re-parsable. Validated by
> `scripts/test-payslip-ocr-adapter.mjs` (**41/41**, incl. a live wire-proof to OpenAI)
> with no regression (extraction 49/49, import 55/55, matcher 41/41, duplicates 32/32,
> screenshot 40/40) and a clean build. **Remaining blocker for live extraction: a valid
> `OPENAI_API_KEY`** — the app's current key returns 401 — plus the PII/privacy review
> before any production rollout. NOTE: the design's §7 first-choice was Claude Haiku via
> the Vercel AI Gateway; OpenAI was chosen for the MVP build purely because it is the
> provider the app already has a key slot for — the adapter seam makes switching a
> one-env-var change.

Builds on (does not supersede):

- [OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md](OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md) — § 4.1 (import lifecycle), § 5 (confidence model), § 6 (confirm bridge), § 9 (parser adapter interface), roadmap O10
- [PAYSLIP_SCREENSHOT_UPLOAD_v1.0.md](PAYSLIP_SCREENSHOT_UPLOAD_v1.0.md) — the **built** file-capture substrate this consumes (bucket, RLS, `ScreenshotIngestAdapter`, `file_ref`/`file_hash`, the `extraction:'pending'` seam marker)
- [PAYSLIP_MATCHING_ENGINE_v1.0.md](PAYSLIP_MATCHING_ENGINE_v1.0.md) — the matcher that runs *after* extraction, unchanged

**Constraints honoured (restated from the task):** no auto-confirm, no PDF parsing,
no production change, DEV only, human review remains mandatory on every line. This
document is **architecture + plan only** — it does not add OCR code, install
dependencies, or run a provider. Every speculative choice is marked
**Recommendation:** and separated from the already-built contracts it plugs into.

---

## 0. Headline finding

**O10 is the single drop-in that fills one dotted arrow.** Everything else in the
payslip pipeline — staging tables, matcher, duplicate detection, confirm bridge,
payment-record generation, reconciliation, review UI — is built and validated in
DEV. The screenshot-upload step (`PAYSLIP_SCREENSHOT_UPLOAD_v1.0`) already lands the
bytes in a private owner-scoped bucket and parks the import at `status='uploaded'`
with `lines: []` and `raw_extract.extraction = 'pending'`. **O10 is the function
that turns those parked bytes into `ParsedLine[]` and lets the import resume the
existing lifecycle.**

```
   BUILT (screenshot upload)            O10 (this doc)            BUILT (everything after)
 ┌─────────────────────────┐     ┌────────────────────────┐    ┌──────────────────────────┐
 │ uploaded, lines:[],     │ ┄┄▶ │ ScreenshotOcrAdapter   │ ─▶ │ parsing → parsed →       │
 │ extraction:'pending',   │     │ (server route, vision  │    │ needs_review → confirm → │
 │ file_ref retained       │     │  extraction → lines)   │    │ payment_records + recon. │
 └─────────────────────────┘     └────────────────────────┘    └──────────────────────────┘
```

Three facts make O10 narrow:

| Pre-built seam | Where | Consequence for O10 |
|----------------|-------|---------------------|
| `ScreenshotIngestAdapter` retains `file_ref` + `extraction:'pending'` | [screenshotIngestAdapter.js:81-91](../lib/fat/adapters/screenshotIngestAdapter.js) | O10 reads the exact stored object; nothing about capture changes |
| The canonical line shape (`ParsedLine`) + `addImportLines` + `scoreImportLines` | [manualEntryAdapter.js:18-36](../lib/fat/adapters/manualEntryAdapter.js), [payslipImports.js:178-217](../lib/fat/services/payslipImports.js) | O10 emits the *same* shape; matcher + bridge + UI are untouched |
| The import lifecycle already enumerates `uploaded→parsing→parsed→needs_review` (+`failed`, +`failed→parsing` re-parse) | [payslipImport.js:67-76](../lib/fat/models/payslipImport.js) | **Zero new lifecycle states.** O10 only *drives* transitions that already exist |

**The genuinely new surface is one server route + one adapter + one orchestration
service + one optional additive migration (extraction confidence) + UI wiring to
trigger and display.** No reconciliation semantics, no new staging columns required
for the core path, no change to the matcher or confirm bridge.

---

## 1. Objective 1 — OCR architecture review (where O10 sits)

The OCR_PAYSLIP_IMPORT architecture (§ 9) always anticipated three adapters behind
one `ParserAdapter.parse(input, ctx) → ParseResult` contract:

- `ManualEntryAdapter` — **built** (MVP).
- `PdfLineAdapter` — deferred (O9; **explicitly out of scope here** — no PDF).
- `ScreenshotOcrAdapter` — **this document (O10)**.

The architecture's § 9 server-side note already mandates the shape O10 must take:
> real OCR/AI extraction (Phase 3) should run as a Vercel Function / route (the repo
> already has the pattern at `app/api/travel/google/route.js`), not in the browser —
> keep extraction keys server-side and write staging rows via the `service_role` path.

So O10 is not novel architecture — it is the **execution** of a seam the design
reserved. The only open architectural questions O10 must *answer* (not invent) are:
(a) which provider, (b) how extraction confidence is represented, (c) the failure
taxonomy. Sections 6–9 answer those.

---

## 2. Objective 2 — `ScreenshotIngestAdapter` review

The ingest adapter ([screenshotIngestAdapter.js](../lib/fat/adapters/screenshotIngestAdapter.js))
is the file-capture half of `ScreenshotOcrAdapter`. Reviewed against O10's needs:

| Property | Today (ingest) | What O10 reuses verbatim |
|----------|----------------|--------------------------|
| `source` | `payslip_screenshot` | unchanged — the OCR adapter shares it |
| `parse()` return | `{ pay_date, pay_period_ref, raw_extract, lines: [], parser_name, parser_version }` | same shape, but `lines` is **populated** |
| `raw_extract` | `{ adapter, version, file_ref, file_hash, mime, size_bytes, uploaded_at, extraction: 'pending' }` | O10 reads `file_ref` to fetch bytes; **flips `extraction` to `'ocr'`** and appends the OCR payload |
| Lifecycle effect | rests at `uploaded` (empty lines) | O10 advances `uploaded → parsing → parsed → needs_review` |

**Key finding:** the ingest adapter already wrote the *exact* breadcrumbs an OCR
re-parse needs (`file_ref` to locate the object, `file_hash` for integrity, `mime`
to branch decoding). The sketched `ScreenshotOcrAdapter` in its trailer comment
([screenshotIngestAdapter.js:115-122](../lib/fat/adapters/screenshotIngestAdapter.js))
is the blueprint O10 fills in. **No change to the ingest adapter is required** — O10
adds a *sibling* adapter, exactly as the ingest adapter was a strictly-additive
sibling of `ManualEntryAdapter`.

One subtlety the review surfaces: the ingest adapter's `parse()` takes upload
*metadata*, not pixels. The OCR adapter's `parse()` needs the actual bytes. The
clean resolution (§ 5) is that the **server route** downloads the bytes from Storage
and hands the OCR adapter a `{ file_ref, bytes, mime }` input — the adapter stays
pure-ish (it shapes a provider response into lines) and never itself talks to
Storage or holds credentials.

---

## 3. Objective 3 — OCR extraction service design

Two cooperating pieces, mirroring the existing wiring discipline (Storage on the
public client, tables on the `fat` client, both injectable):

### 3.1 Server route — `app/api/payslip/extract/route.js` (the 2nd server function)

Modelled directly on `app/api/travel/google/route.js` (the established server-route
pattern, per memory `project_no_server_routes`). Responsibilities:

1. **Auth** — identical to the Google route: require `Authorization: Bearer <token>`,
   validate against Supabase auth with the anon key, derive `userId`. The extraction
   API key (provider/gateway) **never** leaves the server.
2. **Rate limit** — reuse the Google route's per-user in-memory token bucket sized
   for human review cadence (**Recommendation:** 20 req / 60 s — OCR is heavier and
   rarer than a distance lookup).
3. **Authorize the import** — load the `payslip_imports` row by `id`; assert
   `owner_id === userId` (the load-bearing owner check — the route runs with elevated
   credentials to read Storage, so this is the sole owner guard, mirroring confirm
   bridge § 6.1 step 0). Refuse unless `source = 'payslip_screenshot'` and
   `status ∈ {uploaded, failed}` (the only re-parsable states).
4. **Download bytes** — `getScreenshot bytes` from the private bucket using a
   server-side client. **Recommendation:** download via the service-role client
   (server-only env) so the worker path the architecture anticipated (§ 3.4) works;
   on the interactive path a signed-URL fetch also works. Verify `sha256` matches
   `file_hash` (integrity / tamper guard) before spending a provider call.
5. **Extract** — call `ScreenshotOcrAdapter.parse({ file_ref, bytes, mime })` → real
   `ParsedLine[]` + per-line extraction confidence + batch `pay_date`/`pay_period_ref`.
6. **Materialize + advance** — call the orchestration service (§ 3.2) which writes
   lines and walks the lifecycle. Return a compact JSON summary
   (`{ ok, importId, status, lineCount, lowConfidenceCount }`) — never the raw image.

The route is the **only** place a provider key lives and the **only** place raw
bytes are handled, exactly like the Google key in the travel route.

### 3.2 Orchestration service — `runScreenshotExtraction()` in `lib/fat/services/payslipExtraction.js`

The server-side glue that drives the lifecycle (mirrors `createManualEntryImport`'s
shape, [payslipImports.js:373-441](../lib/fat/services/payslipImports.js)):

```
runScreenshotExtraction({ importId, ownerId, bytes, mime }, { client, adapter }) :
  0. load import; assert owner + source=payslip_screenshot + status∈{uploaded,failed}
  1. uploaded|failed → parsing            (updateImportStatus; force on failed→parsing)
  2. result = await adapter.parse({ file_ref, bytes, mime })
  3. persist batch meta (pay_date, pay_period_ref, parser_name/version,
       raw_extract = { ...ingest raw_extract, extraction:'ocr', provider, model,
                       usage, per-line extract payload })
  4. addImportLines({ importId, ownerId, lines: result.lines })   // status 'parsed'
  5. (additive + non-fatal) scoreImportLines(...)   // matcher pre-fills suggestions
  6. (additive + non-fatal) detectImportDuplicates(...)
  7. set per-line status from extraction confidence (§ 8):
       confident → leave 'parsed' (then matcher); low → 'needs_review' + note
  8. parsed → needs_review                (the MVP resting state)
  9. on ANY throw in 1–8: status → failed, error populated, re-parsable (§ 9)
```

Steps 4–6 are **the exact calls `createManualEntryImport` already makes** — O10
reuses them, proving the adapter-agnostic design. The only O10-specific logic is
steps 2, 3, and 7 (extraction + provenance + confidence→status).

**Why a service, not inline in the route:** keeps the route thin (auth/rate/IO) and
lets the DEV test bench (`scripts/test-payslip-extraction.mjs`) drive extraction
with a **stub adapter** (deterministic fake lines) — no network, no key, no spend —
exactly how the matcher/bridge tests run today.

---

## 4. Objective 4 — extraction lifecycle

**No new states.** The four states the task names already exist and are already wired
into `IMPORT_TRANSITIONS` ([payslipImport.js:67-76](../lib/fat/models/payslipImport.js)).
O10 simply *exercises* this slice for the first time on a screenshot import:

```
            (O10 route fires)        (adapter returns lines)     (matcher + resting)
 uploaded ───────────────▶ parsing ────────────────▶ parsed ──────────────▶ needs_review
    ▲                         │                                                   │
    │ (re-upload, pre-confirm)│ (provider error / unreadable / 0 lines)           │ per line:
    │                         ▼                                                   ▼ confirm/ignore/reject
 (superseded)              failed ──(operator re-tries extraction)──▶ parsing   (existing bridge, unchanged)
                              │
                              └──(operator types lines instead)──▶ manual fallback on the SAME import (§ 9.3)
```

- **uploaded** — bytes stored, `extraction:'pending'`. Resting state after upload.
- **parsing** — the route/adapter is running. For MVP this is a **synchronous**
  request/response (one screenshot, one operator click); the `service_role` batch
  worker (async fan-out over many uploads) stays deferred (architecture § 7, O10
  trailer). `parsing` is therefore short-lived, not a durable queue state, in MVP.
- **parsed** — `ParsedLine[]` materialized; matcher has scored candidates.
- **needs_review** — the resting state: every line awaits an operator decision
  (human review **mandatory** — constraint). Low-extraction-confidence lines are
  flagged here too (§ 8).
- **failed** — terminal-for-now but **re-parsable** (`failed → parsing`), carrying
  `error`. The retained `file_ref` + `raw_extract` make a re-try cheap (§ 9).

The line lifecycle is **also unchanged**: OCR lines land `parsed` and flow through
`parsed → needs_review → confirmed|rejected|ignored` exactly as manual lines do.
The matcher never sets a persisted `matched` status (the band is display-only,
[payslipMatcher.js:11-14](../lib/fat/services/payslipMatcher.js)) — O10 keeps that.

---

## 5. Objective 5 — OCR adapter interface

The interface already exists (`ParserAdapter`, [manualEntryAdapter.js:49-61](../lib/fat/adapters/manualEntryAdapter.js)).
O10 adds one concrete subclass. **Recommendation** (the contract, not the impl):

```js
// lib/fat/adapters/screenshotOcrAdapter.js  (NEW — strictly additive sibling)
export class ScreenshotOcrAdapter extends ParserAdapter {
  name = 'screenshot_ocr'
  version = '1.0.0'
  source = IMPORT_SOURCE.PAYSLIP_SCREENSHOT     // same source as ingest

  // input: { file_ref, bytes: Uint8Array, mime }  ← the route supplies bytes
  // ctx:   { pay_date? } fallback hint
  // returns the canonical ParseResult, with lines POPULATED and each line
  //   carrying an extra non-canonical `extract_confidence` + `extract_meta`
  //   that the orchestration service peels off (§ 8) before addImportLines.
  async parse(input, ctx = {}) {
    const { lines, pay_date, pay_period_ref, usage } =
      await extractPayslip(input.bytes, input.mime)   // ← provider call (§ 7)
    return {
      pay_date: pay_date ?? ctx.pay_date ?? null,
      pay_period_ref,
      raw_extract: { adapter: this.name, version: this.version,
                     file_ref: input.file_ref, extraction: 'ocr',
                     provider: PROVIDER_ID, model: MODEL_ID, usage,
                     lines /* full per-line OCR payload for audit */ },
      lines: lines.map(normalizeOcrLine),   // → canonical ParsedLine[] (+confidence)
      parser_name: this.name, parser_version: this.version,
    }
  }
}
```

Contract guarantees O10 must uphold (so the rest of the pipeline stays untouched):

1. **Same `ParseResult` shape** — `normalizeOcrLine` produces the canonical
   `ParsedLine` fields (`line_index, raw_text, parsed_reference, parsed_description,
   parsed_amount, parsed_date`) using the **same coercion discipline** as
   `normalizeLine` (trim→null, 2dp non-negative money, strict `YYYY-MM-DD`).
   Reuse/extract a shared normalizer so a provider that returns `"$1,234.50"` or a
   localised date can't poison the bridge.
2. **`raw_text` always populated** for an OCR line — the verbatim text the model
   read for that row, so a human reviewing a low-confidence line sees ground truth.
3. **No Storage, no keys inside the adapter** — bytes are injected by the route; the
   provider client is constructed from server-only env. Keeps the adapter
   unit-testable with a stub and keeps secrets in one place.
4. **Pure, deterministic post-processing** — everything after the provider response
   (normalisation, confidence derivation) is pure, so it is testable without spend.

The architecture's `ScreenshotOcrAdapter` sketch is honoured exactly; O10 only fills
`extractPayslip()`.

---

## 6. Objective 6 — provider / option evaluation

The task is **structured field extraction from a screenshot of an FRV payslip**, not
plain page OCR: the output must be discrete lines with `reference / description /
amount / date`. Two solution classes:

**A. Raw OCR → heuristic parse.** A text-OCR engine returns characters/blocks; a
second bespoke pass reconstructs rows and fields per payslip layout.

**B. Vision LLM → structured extraction.** A multimodal model reads the image and
emits the line objects directly, schema-constrained.

| Option | Class | Key/host | Strengths | Weaknesses for this task |
|--------|-------|----------|-----------|--------------------------|
| **Vision LLM via Vercel AI Gateway + AI SDK `generateObject`** (e.g. `anthropic/claude-haiku-4-5` or `claude-sonnet-4-6`) | B | Gateway key, server-side | Emits canonical `ParsedLine[]` **directly** via a Zod schema; robust to payslip layout variance; one call does OCR+layout+field mapping; Vercel-native (observability, provider fallback, zero-retention); trivially swappable model string | Per-call cost (cents); needs a careful extraction prompt + schema; non-determinism (mitigated by `temperature:0` + schema + human review) |
| OpenAI GPT-4o vision (same AI SDK, `openai/gpt-4o`) | B | Gateway/key | Same structured-output path; strong vision | Same class as above; provider choice is a one-line swap under the Gateway — kept as the built-in fallback |
| Google Cloud Vision (`DOCUMENT_TEXT_DETECTION`) | A | GCP key | Excellent raw OCR; cheap; the repo already uses a Google key for Maps (familiar billing) | Returns text/blocks only → O10 must **build and maintain a payslip-layout parser** (brittle across FRV payslip variants); no field semantics |
| AWS Textract (`AnalyzeExpense`) | A/hybrid | AWS key | Purpose-built for pay/receipt key-value + tables | New cloud vendor + IAM to introduce; tuned for invoices/receipts, not FRV payslip rows; still needs mapping to entitlement vocabulary |
| Azure Document Intelligence | A/hybrid | Azure key | Strong layout/table model, custom-trainable | New vendor; custom model training is heavy for an MVP |
| **Tesseract.js** (local, `tesseract.js`) | A | none (in-process) | Zero key, zero per-call cost, fully local/private, no data leaves the box | Weak on screenshot/tabular layout & small fonts; raw text only → same bespoke-parser burden as Vision OCR; slower cold start. **Good zero-cost fallback, weak primary** |

**Decision axes that matter here:** (1) the output we need is *structured lines*, not
text — class B collapses two brittle steps into one; (2) the app is already on Vercel
and the platform guidance is AI-SDK-through-the-Gateway with plain `"provider/model"`
strings; (3) volume is low (a human uploads and reviews one payslip at a time), so
per-call LLM cost is negligible and accuracy/maintainability dominate; (4) the
adapter seam makes the provider a swappable detail, so this is a low-regret choice.

---

## 7. Objective 7 — recommended MVP provider

**Recommendation: a vision LLM through the Vercel AI Gateway, called with the AI SDK's
`generateObject` against a Zod schema that mirrors `ParsedLine[]`. Default model
`anthropic/claude-haiku-4-5` (cost-efficient, strong document vision), with
`anthropic/claude-sonnet-4-6` as the accuracy-escalation and an OpenAI model as the
Gateway fallback.**

Why this over the alternatives, concretely:

- **It returns the canonical shape directly.** `generateObject({ schema, messages:[{image}] })`
  yields `{ lines: [{ reference, description, amount, date, raw_text }], pay_date }`
  already typed — no payslip-layout parser to write or maintain (the entire weakness
  of the class-A options). The adapter's `normalizeOcrLine` only does final coercion.
- **Vercel-native, swappable.** Per the platform knowledge update, prefer plain
  `"provider/model"` strings through the Gateway; provider fallback, usage/cost
  observability, and zero data retention come for free, and switching `haiku → sonnet
  → gpt-4o` is a one-line change — important while we tune accuracy on real FRV
  payslips in DEV.
- **Determinism knobs + mandatory human review.** `temperature: 0`, a strict schema,
  and a tightly-scoped extraction prompt make output stable; and because **every line
  is operator-confirmed (no auto-confirm — constraint)**, residual model error is
  caught at review, never auto-written.
- **Cost is a non-issue at this volume** and the adapter seam means if cost/PII ever
  argues for it, dropping in **Tesseract.js** (no key, fully local) or Google Vision
  is a contained change behind the same `ParserAdapter` contract.

**Dependencies this introduces (DEV first):** `ai` (AI SDK v6) and — only if not
routing purely through the Gateway string — a provider package; configured via
`AI_GATEWAY_API_KEY` (or provider key) as a **server-only** env var (never
`NEXT_PUBLIC_*`), exactly like `GOOGLE_MAPS_API_KEY`. **Recommendation:** also add
`PAYSLIP_OCR_MODEL` env so the model is swappable without a deploy.

> **Privacy note (carries blocker #5).** Payslip images are PII. The Gateway's
> zero-data-retention posture is the right default; still, sending payslip images to
> a third-party model is a **privacy decision that must clear the same review gating
> production rollout** (PAYSLIP_SCREENSHOT_UPLOAD § 6.3, architecture blocker #5).
> For a fully-local option, Tesseract.js keeps bytes on the server — name it as the
> privacy-maximal fallback if the review forbids third-party vision. **DEV-only until
> that review passes** (constraint).

---

## 8. Objective 8 — confidence handling

There are now **two independent confidences**, and conflating them would corrupt the
matcher:

| Confidence | Owner | Question it answers | Stored where |
|------------|-------|---------------------|--------------|
| **Extraction confidence** (NEW) | `ScreenshotOcrAdapter` | "Did OCR read this *line/field* correctly?" | per-line (§ 8.1) |
| **Match confidence** (built) | `payslipMatcher` | "Which *entitlement* does this line settle?" | `match_confidence` / `match_breakdown` ([payslipImport.js:160-161](../lib/fat/models/payslipImport.js)) |

These must stay separate: a perfectly-read line (`extract=0.99`) can still have no
confident entitlement match (`match=0.2`), and vice-versa. **The matcher must never
see extraction confidence as input** — it scores the parsed fields as given.

### 8.1 Where extraction confidence lives — **Recommendation**

Two viable representations; recommend the first:

- **(Recommended) Additive migration `canonical_14`** — add two nullable columns to
  `fat.payslip_import_lines`: `extract_confidence numeric(5,4)` and
  `extract_meta jsonb` (per-field confidences + the verbatim model text). This keeps
  extraction confidence first-class and queryable, cleanly separate from
  `match_breakdown`, and lets the review UI badge "OCR unsure — verify" independently
  of the match badge. Additive + idempotent + DEV-first, consistent with the
  migration-10/11/12/13 pattern. **It is the only schema change O10 needs, and it is
  optional** (the path works without it via the fallback below).
- **(No-migration fallback)** Stash per-line extraction confidence in
  `payslip_imports.raw_extract` keyed by `line_index`, and translate it only into
  line *status* + a `resolution_note` flag at materialization. Loses per-line
  queryability and a clean UI badge, but needs zero schema change. Use this if O10
  must ship before a migration window.

### 8.2 How extraction confidence is used (MVP) — bands, not gates

The extraction band's **only** MVP job is to route the operator's attention — it
**never** confirms or skips a line (no auto-confirm):

| Extraction confidence | Line status after materialize | Review UI treatment |
|-----------------------|-------------------------------|---------------------|
| ≥ 0.85 (high) | `parsed` → matcher → resting `needs_review` | normal row; matcher band shown as usual |
| 0.50 – 0.85 (medium) | `parsed`, flagged | amber "verify OCR" badge; `raw_text` shown inline |
| < 0.50 (low) | `needs_review` directly, parsed fields **kept but flagged** | red "low OCR confidence — check against image" badge; image preview emphasised |

Deriving the score (**Recommendation**): ask the vision model to self-report a
per-line confidence in the schema, **and** floor it with deterministic sanity checks
(amount parses to a number; date parses to ISO; required fields non-empty) so a
confidently-wrong model can't claim 0.99 on an unparseable amount. Persist the full
breakdown in `extract_meta` for audit.

**Every line, regardless of band, still requires an explicit operator confirm** — the
band orders and colours the queue, exactly as the match band does (architecture §5.3).

---

## 9. Objective 9 — failure handling

OCR is the first pipeline step that can fail for *external* reasons. The taxonomy and
the lifecycle response:

### 9.1 Failure taxonomy

| Failure | Detected | Response |
|---------|----------|----------|
| No provider key / server misconfigured | route startup | `500 server_misconfigured`; import **untouched** (stays `uploaded`) — nothing was attempted |
| Auth missing/invalid | route auth | `401`; import untouched |
| Rate limited | route | `429 retryAfterMs`; import untouched |
| Not owner / wrong source / wrong status | route authorize | `403`/`409`; import untouched |
| Object missing or hash mismatch | byte download | `failed` + `error='image unreadable / integrity mismatch'`; re-parsable |
| Provider timeout / network / 5xx | adapter | `failed` + `error=<reason>`; re-parsable (retry later) |
| Provider returns malformed / non-schema output | adapter | `failed` + `error='extraction unparseable'`; re-parsable |
| **Zero lines extracted** (blank/illegible image) | adapter | `failed` + `error='no payslip lines found'`; operator re-tries or switches to manual fallback (§ 9.3) |
| Partial — some lines low-confidence | normal success | **not a failure**: lands `needs_review`, low lines flagged (§ 8.2) |

### 9.2 Lifecycle response — `failed`, never silent

Any in-flight failure (download/extract/materialize) drives the import to `failed`
with `error` populated, mirroring `createManualEntryImport`'s catch
([payslipImports.js:434-440](../lib/fat/services/payslipImports.js)). `failed` is
**re-parsable** (`failed → parsing`) — the retained `file_ref` + `raw_extract` mean a
re-try costs only the provider call. **No partial lines are left behind:** if
materialization throws mid-way, the operator re-parses from a clean `failed` state
(MVP keeps extraction atomic-per-import — write all lines or none; **Recommendation:**
delete any partially-inserted lines on failure before stamping `failed`, so re-parse
starts clean).

### 9.3 Manual fallback on the *same* import (graceful degradation)

When extraction can't succeed (illegible image, provider down, or the operator simply
distrusts the read), the operator must not be stuck. **Recommendation:** allow
**manual line entry onto the existing screenshot import** — the operator types lines
against the image they're looking at. Provenance stays correct because the confirm
bridge maps `payment_records.source` from `import.source` (`payslip_screenshot`),
which is *truthful*: the evidence genuinely is a screenshot, the operator just keyed
it. This is strictly better than the architecture's "start a new `manual_entry`
import" for this case (it preserves the image link and `file_hash` dedup) and reuses
the **built** `addImportLines` + review UI. It also doubles as the low-confidence
correction path. (The architecture's "new manual import" remains valid when there is
no uploaded image at all.)

No new state is needed: manual lines land `parsed` and the import sits at
`needs_review` like any other.

---

## 10. Objective 10 — implementation plan

Each step is independently shippable, DEV-first, additive. No production change; no
PDF; no auto-confirm; human review mandatory throughout.

| Step | Deliverable | Depends on | Notes |
|------|-------------|------------|-------|
| **X1** | `canonical_14_payslip_extract_confidence.sql` — additive nullable `extract_confidence numeric(5,4)` + `extract_meta jsonb` on `payslip_import_lines` (§ 8.1). Idempotent, DEV first. **Optional** — path works without it via the §8.1 fallback. | migration 10 | The *only* schema change; ship first so models can reference it |
| **X2** | `ScreenshotOcrAdapter` + shared `normalizeOcrLine` (extract the coercion core from `normalizeLine` so both adapters share it). Provider call isolated behind `extractPayslip(bytes, mime)`. Pure post-processing. (§ 5) | X1 (or fallback) | Strictly-additive sibling; `ManualEntryAdapter`/`ScreenshotIngestAdapter` untouched |
| **X3** | `extractPayslip()` — AI SDK `generateObject` + Zod `ParsedLine[]` schema, model from `PAYSLIP_OCR_MODEL` env, `temperature:0`, extraction prompt tuned to FRV payslip vocabulary. Server-only. (§ 7) | X2 | Add `ai` dep; key as server-only env (never `NEXT_PUBLIC_*`) |
| **X4** | `runScreenshotExtraction()` service in `lib/fat/services/payslipExtraction.js` — lifecycle orchestration (§ 3.2), reuses `addImportLines`/`scoreImportLines`/`detectImportDuplicates`; confidence→status mapping (§ 8.2); atomic-per-import + clean `failed` on throw (§ 9). | X2 | Accepts an injectable adapter so tests use a stub |
| **X5** | `app/api/payslip/extract/route.js` — the 2nd server function: auth + rate-limit + owner/source/status authorize + service-role byte download + hash verify + call X4 (§ 3.1). Modelled on the Google route. | X3, X4 | Returns a compact summary, never the image |
| **X6** | Review-UI wiring in `ImportDetail` — an **"Extract lines"** action on an `uploaded`/`failed` screenshot import (POSTs to X5, shows progress), the OCR-confidence badges (§ 8.2), and the **manual-fallback** affordance on a screenshot import (§ 9.3). Image preview already exists. | X5 | Reuses `ImportLineRow`/confirm picker unchanged |
| **X7** | DEV test bench `scripts/test-payslip-extraction.mjs` — drives X2/X4 with a **stub adapter** (deterministic fake lines, no spend): asserts lifecycle `uploaded→parsing→parsed→needs_review`, line materialization, confidence→status mapping, the `failed`+re-parse path, the zero-line path, and **owner/source/status guards**. Plus one **opt-in live smoke** (gated on a real key + a sample image, off by default) to validate the real provider end-to-end. Asserts **no regression** on the existing benches (manual 55/55, matcher 41/41, duplicates 32/32, screenshot 31/31). | X2–X6 | Mirrors `test-payslip-screenshot-import.mjs`; refuses unless DEV; cleans up |
| **X8** *(post-MVP)* | `service_role` async batch-parse worker (fan-out over many `uploaded` imports), object-delete on retract/reject (true PII revocation), and the **PII/retention privacy review** that gates any production rollout (blocker #5). | X5 | Deferred — MVP is synchronous, one-image-per-click |

**Sequencing note:** X1 is optional and can be skipped for a first cut (use the §8.1
fallback), but doing it first keeps `extract_meta` first-class from day one. X3 is the
only step that introduces a dependency and an external call; X2/X4/X7 are fully
testable with no key and no network via the stub adapter, so most of O10 can be built
and validated **before** any provider decision is finalised — de-risking the spend.

---

## 11. What O10 deliberately does NOT do (scope fence)

- **No auto-confirm.** Extraction populates lines; every line is operator-confirmed
  through the existing bridge. (constraint)
- **No PDF.** `PdfLineAdapter` (O9) is a separate adapter on the same seam; not here.
  (constraint)
- **No production change; DEV only** until the PII/privacy review (§ 7, blocker #5)
  passes. (constraint)
- **No reconciliation/bridge/matcher changes.** O10 emits the canonical line shape;
  everything downstream is the built, validated pipeline.
- **No new lifecycle vocabulary.** O10 exercises existing states only (§ 4).
- **No async batch worker in MVP.** Synchronous one-image extraction; the
  `service_role` fan-out worker is X8 (post-MVP).
- **No overdue/non-appearance detection.** Out-of-scope-by-design (architecture § 8)
  — a line-driven producer is structurally blind to an entitlement that never appears.

---

## 12. Cross-references

- [OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md](OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md) § 4.1 (lifecycle), § 5 (confidence), § 6 (confirm bridge), § 9 (adapter + server-route note), roadmap O10, blocker #5 (PII)
- [PAYSLIP_SCREENSHOT_UPLOAD_v1.0.md](PAYSLIP_SCREENSHOT_UPLOAD_v1.0.md) — the built substrate (bucket, RLS, ingest adapter, the `extraction:'pending'` seam)
- [PAYSLIP_MATCHING_ENGINE_v1.0.md](PAYSLIP_MATCHING_ENGINE_v1.0.md) — the matcher that runs after extraction, unchanged
- [lib/fat/adapters/screenshotIngestAdapter.js](../lib/fat/adapters/screenshotIngestAdapter.js) — the `ScreenshotOcrAdapter` sketch O10 fills in
- [lib/fat/adapters/manualEntryAdapter.js](../lib/fat/adapters/manualEntryAdapter.js) — `ParserAdapter` base + `normalizeLine` coercion to share
- [lib/fat/services/payslipImports.js](../lib/fat/services/payslipImports.js) — `addImportLines` / `updateImportStatus` / `createManualEntryImport` (the lifecycle shape O10 mirrors)
- [lib/fat/services/payslipUploads.js](../lib/fat/services/payslipUploads.js) — Storage download / signed-URL helpers the route reuses
- [app/api/travel/google/route.js](../app/api/travel/google/route.js) — the server-route pattern X5 mirrors (auth, rate-limit, server-only key)
- Platform: Vercel AI Gateway + AI SDK `generateObject` (knowledge-update guidance) — the recommended extraction path
