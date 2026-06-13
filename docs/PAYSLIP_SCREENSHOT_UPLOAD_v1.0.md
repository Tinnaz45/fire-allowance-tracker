# Fire Allowance Tracker — Payslip Screenshot Upload: Design & Implementation

Version: v1.0
Status: BUILT + validated in DEV (ingest-only — no OCR)
Last Updated: 2026-06-04
Branch: `dev`

Builds on (does not supersede):

- [OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md](OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md) — § 3.3 (file_ref, not bytes-in-Postgres), § 4.1 (lifecycle), § 9 (parser adapter interface), blocker #2 (storage + RLS), blocker #5 (PII/retention)
- [PAYSLIP_DUPLICATE_DETECTION_v1.0.md](PAYSLIP_DUPLICATE_DETECTION_v1.0.md) — the content-fingerprint dedup this complements with file-hash dedup

**Constraints honoured:** no OCR extraction, no AI extraction, no PDF parsing, no
production change, DEV only.

---

## 0. Headline & MVP recommendation

The OCR pipeline is complete (staging, review UI, matcher, duplicate detection,
confirm bridge, payment-record generation, reconciliation) **except a real ingestion
source** — every import to date is manual entry. The highest-value next step is
**screenshot upload**.

**MVP recommendation — ship the file-capture half of the future `ScreenshotOcrAdapter`
and nothing more.** An operator uploads a payslip image; the bytes land in a private,
owner-scoped Storage bucket; one `fat.payslip_imports` row is created with
`source='payslip_screenshot'`, `file_ref=<object path>`, `file_hash='sha256:<hex>'`,
`status='uploaded'`, `line_count=0`, and **zero** `payslip_import_lines`. The import
**rests at `uploaded`** ("file stored, not yet parsed", § 4.1) and shows in the
existing `/payments/imports` surface as an *awaiting-extraction* batch with an image
preview.

**Why this slice:** it delivers a usable, first-class new ingestion source today, and
it is *exactly* the bytes-on-disk substrate the real OCR adapter will consume — so no
work is throwaway. Everything downstream (matcher, confirm bridge, reconciliation)
already works the moment a future adapter materializes lines.

**Explicitly deferred (NOT built):** OCR/AI/PDF parsing, line materialization, the
matcher run, the confirm bridge for screenshot imports (moot at zero lines), a
`service_role` batch-parse worker, and the PII/retention policy (blocker #5). The
manual-entry path (`ManualEntryAdapter` / `createManualEntryImport`) is **untouched**.

---

## 1. Where it sits

```
            ┌──────────────────────────────┐
 NEW ─────▶ │ Screenshot upload            │  PNG / JPG / JPEG / WEBP
            │  (private Storage bucket)    │  ← migration 13 + RLS
            └──────────────┬───────────────┘
                           │ ScreenshotIngestAdapter.parse() → { lines: [] }
                           ▼
            ┌──────────────────────────────┐
            │ payslip_imports              │  source=payslip_screenshot
            │  status='uploaded', 0 lines  │  file_ref + file_hash
            └──────────────┬───────────────┘
                           ┆ (FUTURE) ScreenshotOcrAdapter re-parses file_ref → real lines
                           ▼
            ┌──────────────────────────────┐
            │ parsing → parsed →           │  ← the EXISTING pipeline, unchanged
            │  needs_review → confirm …    │
            └──────────────────────────────┘
```

The solid path is this feature; the dotted transition is future OCR (O10).

---

## 2. Storage design (migration 13)

| Aspect | Decision |
|--------|----------|
| Bucket | `payslip-screenshots`, **private** (`public=false`) — payslip images are PII |
| Path | `<owner_id>/<sha256hex>.<ext>` — owner is the first folder segment (drives RLS); content-addressed name gives free dedup + idempotent re-upload |
| Size limit | 15 MiB (covers a high-res phone screenshot; under the project global limit) |
| MIME | `image/png`, `image/jpeg` (JPG+JPEG), `image/webp` |
| RLS | 4 policies on `storage.objects` (select/insert/update/delete), role `authenticated`, pinned `bucket_id` **and** `(storage.foldername(name))[1] = (select auth.uid())::text` — a user only ever touches their own prefix; `service_role` bypasses for the future worker |
| Read | on-demand **signed URLs** (`createSignedUrl`, 1 h), minted lazily in the review UI; never persisted |

`storage.objects` already has RLS enabled by Supabase — the migration only adds
policies (guarded `DO` blocks → replay-safe). `fat.payslip_imports` is **unchanged**:
`file_ref`/`file_hash` already exist (migration 10) and the `source` CHECK already
permits `payslip_screenshot`.

**True PII revocation** = *deleting* the object (signed-URL expiry does **not** purge
the CDN cache). `deleteScreenshotObject` is provided and used on cleanup; wiring it
into retract/reject UX is a follow-up alongside the `service_role` worker.

---

## 3. Adapter seam (objectives 8 + 9)

`lib/fat/adapters/screenshotIngestAdapter.js` adds `ScreenshotIngestAdapter extends
ParserAdapter` (the § 9 base, imported from the **untouched** `manualEntryAdapter.js`).
It declares `source = payslip_screenshot` and `parse()` returns the canonical
`ParseResult` with `lines: []` and a `raw_extract` carrying `{ file_ref, file_hash,
mime, size_bytes, uploaded_at, extraction: 'pending' }`.

**The empty `lines` array IS the seam.** Because no parser ran and no lines exist, the
import legitimately rests at `uploaded`. When real OCR lands, a `ScreenshotOcrAdapter`
(sketched in the file) implements the *same* `parse()` contract, fetches the bytes at
the retained `file_ref`, and returns real `ParsedLine[]` — the staging service,
matcher, confirm bridge, and review UI are all unchanged.

---

## 4. Service layer (`lib/fat/services/payslipUploads.js`)

| Function | Contract |
|----------|----------|
| `sha256Hex(bytes)` | lowercase hex SHA-256 via Web Crypto (browser + Node ≥ 20) — agrees with Node's `createHash` in tests |
| `extForMime(mime)` | supported mime → `png`/`jpg`/`webp`, else null |
| `findImportByFileHash({ownerId,fileHash})` | the owner's existing import for this exact image (dedup gate) |
| `uploadScreenshotObject({ownerId,bytes,fileHashHex,contentType})` | upload to `<owner>/<hex>.<ext>`, `upsert:true`; returns `file_ref` |
| `getScreenshotSignedUrl(fileRef,{expiresIn})` | lazy signed URL for the review preview |
| `deleteScreenshotObject(fileRef)` | the correct PII-revocation path (cleanup/retract) |
| `createScreenshotImport({ownerId,file,payDate?,payPeriodRef?},{client,storageClient})` | end-to-end: hash → dedup-check → upload → `createImport(... source=payslip_screenshot, status=uploaded ...)`; returns `{ import, deduped }` |

**Wiring discipline (a real trap):** Storage lives on the **public** `supabase`
client, tables on the **`fat`** schema client. Both are injectable so the DEV test
can drive both with one service-role client.

`createImport` already accepts `fileRef`/`fileHash` (migration-10 era) — no change
needed there.

---

## 5. UI

- `components/payslip/ScreenshotUploadForm.js` — file picker (`accept` PNG/JPG/JPEG/WEBP),
  client-side mime + 15 MB validation, local `URL.createObjectURL` preview, optional
  pay-date / pay-period, dedup + error messaging. Wired into `/payments/imports` as a
  **second** create card under the unchanged manual-entry form.
- `ImportDetail` — for `source=payslip_screenshot`: renders the stored image (lazy
  signed URL) and an **"Awaiting extraction"** empty state instead of the line table;
  suppresses the line-oriented affordances (re-check duplicates / re-run matching are
  meaningless at zero lines). Supersede stays available (pre-confirm).
- `ImportsList` / `statusUi` already label `payslip_screenshot` ("Screenshot") and the
  `uploaded` lifecycle badge — no change needed.

---

## 6. Risks (carried)

1. **Owner-id ↔ path mismatch.** The path's first segment MUST be the signed-in
   `auth.uid` (= `ownerId`); anything else 403s under storage RLS. Enforced by building
   the path from `session.user.id`.
2. **CDN cache survives token expiry.** Real revocation on retract/reject =
   `deleteScreenshotObject`, not expiry. Deferred to the `service_role` worker.
3. **PII/retention (blocker #5) unresolved.** Keep DEV-only; production rollout is
   gated on the privacy review.
4. **Odd mobile `file.type`.** Validated client-side and in the service before upload.
5. **Zero-line imports.** All line-oriented UI paths are suppressed for an `uploaded`
   screenshot import so nothing throws or misleads.
6. **`upsert:true`** needs the UPDATE + SELECT storage policies (both included).

None block the MVP slice.

---

## 7. Validation (DEV)

`scripts/test-payslip-screenshot-import.mjs` (refuses unless DEV; deletes the import
row + storage object on exit) — **31/31 pass**: adapter zero-line seam + ManualEntry
preserved; `createScreenshotImport` → `uploaded` import with `file_ref`/`file_hash`/
zero lines; the stored object downloads + serves over a signed URL with matching
bytes; identical re-upload de-dups to the same import; unsupported-mime + oversize
rejected. No regression: manual-entry bench **55/55**, duplicate-detection **32/32**,
matcher **41/41**. `/payments/imports` compiles clean (798 modules). PROD untouched.

---

## 8. Roadmap (after this)

| Step | Deliverable |
|------|-------------|
| O10 | `ScreenshotOcrAdapter` (server route + OCR/AI extraction) re-parsing the stored `file_ref` → real lines; the import advances `uploaded → parsing → parsed`. |
| — | `service_role` batch-parse worker + object-delete on retract/reject. |
| — | PII / retention policy (blocker #5) before any production rollout. |
| — | PDF upload (`PdfLineAdapter`) reusing this exact storage + adapter substrate. |

---

## 9. Cross-references

- [supabase/canonical/13_payslip_screenshot_bucket.sql](../supabase/canonical/13_payslip_screenshot_bucket.sql) — bucket + storage RLS
- [lib/fat/adapters/screenshotIngestAdapter.js](../lib/fat/adapters/screenshotIngestAdapter.js) — ingest adapter + future-OCR seam
- [lib/fat/services/payslipUploads.js](../lib/fat/services/payslipUploads.js) — upload/hash/dedup/signed-URL service
- [components/payslip/ScreenshotUploadForm.js](../components/payslip/ScreenshotUploadForm.js), [ImportDetail.js](../components/payslip/ImportDetail.js) — UI
- [scripts/test-payslip-screenshot-import.mjs](../scripts/test-payslip-screenshot-import.mjs) — DEV validation
