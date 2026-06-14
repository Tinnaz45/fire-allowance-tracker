# Fire Allowance Tracker — Payslip Import Duplicate Detection: Design & Implementation

Version: v1.0
Status: BUILT + validated in DEV (manual-entry MVP)
Last Updated: 2026-06-04
Branch: `dev`

Builds on (does not supersede):

- [OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md](OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md) — the producer layer; this resolves its **blocker #1** (§ 4.1 / § 11) for the manual-entry MVP
- [PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md](PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md) — the immutable `payment_records` contract the guard protects
- [PAYSLIP_MATCHING_ENGINE_v1.0.md](PAYSLIP_MATCHING_ENGINE_v1.0.md) — the sibling per-line scoring layer this sits beside

**Constraints honoured:** no OCR, no PDF parsing, no screenshot OCR, no
auto-confirm, no production change, operator decision final, DEV only.

---

## 0. Headline

Users can now create imports and confirm matches. The next risk is **duplicate
imports** — re-typing (or, later, re-uploading) the same payslip and minting a
**second** `payment_records` row for a pay line that was already settled.
`create_payment_record` has **no** dedup ([08:158-188](../supabase/canonical/08_reconciliation_service_layer.sql)),
and the confirm bridge's per-line idempotency guard ([11:104](../supabase/canonical/11_payslip_confirm_bridge.sql))
deliberately does **not** span imports — each re-entry mints fresh staging lines
with fresh ids. So nothing stopped a double-confirm. This feature closes that gap.

The architecture frames blocker #1 around a file `file_hash` — but that is an O9
(file-upload) concern. The **manual-entry MVP has no file**, so detection here is
**content-based** (the objective's fingerprint inputs: source, pay period, line
content, amount, reference text).

Blocker #1 has two halves and both are served:

| Half | Mechanism | Where | Hard/soft |
|------|-----------|-------|-----------|
| (a) "this import looks like one you already made" | content fingerprint + Jaccard near-match → `duplicate_check` metadata → review-UI warning | JS detection service | **advisory** |
| (b) "don't re-confirm already-confirmed lines into duplicate records" (the load-bearing half, § 4.1) | confirm-bridge fingerprint guard, overridable only with explicit intent | migration 12 RPC | **hard, but operator-overridable** |

---

## 1. Why two mechanisms, split by language

A single fingerprint computed in one place and read everywhere would be ideal, but
the two halves run in different worlds: half (b) must be **atomic and server-side**
(inside the confirm transaction, so the service-role batch path is also protected),
while half (a) is a **JS read-side advisory**. Computing the same hash in both SQL
and JS invites drift (a normalization mismatch = the UI says "clear" while the RPC
blocks, or vice-versa).

Resolution — **each fingerprint lives in exactly one language; the other only
reads it:**

- **Line fingerprint → SQL.** `fat.payslip_line_content_fp(...)` (migration 12) is
  the single source of truth for "is this the same line of content." A
  trigger maintains `payslip_import_lines.content_fingerprint`. The confirm guard
  and the JS layer both only **read** it.
- **Import fingerprint → JS.** `importContentFingerprint(...)` derives a batch-level
  hash from the import's metadata + its (already-computed) line fingerprints. Used
  by the detection service only — never by the RPC — so it needs no SQL parity.

This is the same discipline the matcher used for hours-first amounts: keep a value
in the layer that owns it, never recompute it across a boundary.

---

## 2. Fingerprints

### 2.1 Line content fingerprint (SQL, authoritative)

```sql
md5(
  lower(btrim(reference))   || US ||   -- case- + whitespace-insensitive
  lower(btrim(description)) || US ||
  to_char(round(amount,2),'FM999999990.00')  -- 50 / 50.0 / 50.00 collapse; null → '~'
                            || US ||
  resolved_date                         -- coalesce(parsed_date, import.pay_date); null → '~'
)               -- US = chr(31), unit separator
```

- **Resolved date** is folded in because the `payment_records` row the bridge mints
  uses exactly `coalesce(parsed_date, import.pay_date)` ([11:129](../supabase/canonical/11_payslip_confirm_bridge.sql)).
  Two lines that would produce the same-dated record must share a fingerprint.
- **Amount normalized** to 2dp fixed text; **null amount** (hours-first line) and
  **null date** use a `~` sentinel so they don't collide with empty strings.
- Trigger fires `before insert or update of` the four content columns; a backfill
  stamps any pre-migration lines. So the guard never sees a null fingerprint on
  current data.

### 2.2 Import content fingerprint (JS)

```
importContentFingerprint({ source, payDate, payPeriodRef, lineFingerprints }) =
  'imp1:' + cyrb53hex(
     source ⊕ payPeriodRef ⊕ payDate ⊕ sort(lineFingerprints).join(',')
  )
```

- **Order-independent** (line fingerprints are sorted), so re-typing the same
  payslip with rows reordered still collides.
- `cyrb53` is a fast, dependency-free, deterministic 53-bit hash (integer ops only —
  identical in browser, Node, and the test bench; no `crypto` import). It is **not**
  cryptographic and does not need to be: a collision only ever produces a *false
  "exact duplicate" flag*, which the operator reviews and can dismiss.

---

## 3. Detection (the advisory half)

`detectImportDuplicates({ importId, ownerId })` ([payslipDuplicates.js](../lib/fat/services/payslipDuplicates.js)):

1. Recompute + persist the target's import fingerprint.
2. Load the owner's prior imports (newest-first, capped at `SCAN_LIMIT = 200`) and,
   in one batched read, all their line fingerprints.
3. For each candidate, recompute its import fingerprint in JS:
   - **exact** — identical import fingerprint (same batch identity + same line set).
   - **near** — line-set **Jaccard ≥ 0.5**, OR **same pay period** (date or ref) with
     **≥ 1 shared line** (same-period re-entry is the highest-risk path).
4. Persist `{ checked_at, fingerprint, verdict, exact[], near[] }` to
   `payslip_imports.duplicate_check`. `verdict ∈ {exact, near, clear}`.

Detection runs automatically at the end of `createManualEntryImport` — **additive +
non-fatal** (mirrors the matcher): a failure never blocks the import from landing;
it simply arrives un-checked. It is also re-runnable from the UI ("Re-check
duplicates").

### 3.1 Thresholds (`DUP_THRESHOLDS`, Recommendation defaults)

| Knob | Value | Rationale |
|------|-------|-----------|
| `NEAR_SIMILARITY` | 0.5 | half the combined line set overlaps |
| `PERIOD_COINCIDENT_MIN_SHARED` | 1 | one shared line in the same pay period is already suspicious |

These are display/ordering knobs only — they never block. Final numbers can move
without touching the hard guard.

### 3.2 Storage

| Column (migration 12, additive) | Holds |
|---|---|
| `payslip_imports.content_fingerprint` | import-level hash; indexed `(owner_id, content_fingerprint)` |
| `payslip_imports.duplicate_check jsonb` | the verdict + matched imports + scores + `checked_at` |
| `payslip_import_lines.content_fingerprint` | trigger-maintained SQL line hash; indexed `(owner_id, content_fingerprint)` |

`duplicate_check` is disposable workspace data (architecture § 3.3) — recomputable
from the fingerprints at any time.

---

## 4. The double-confirmation guard (the hard half)

The confirm bridge (`fat.confirm_payslip_import_line`, replaced in migration 12)
gains one parameter `p_allow_duplicate boolean default false` and one step,
**1.5**, between the idempotency guard and the source mapping:

> Before creating the record, look for **another** line (`id <> p_line_id`), same
> owner, `status = 'confirmed'`, `payment_record_id is not null`, with the **same
> `content_fingerprint`**. If found and `not p_allow_duplicate` → `raise exception`
> (`unique_violation`) carrying a JSON `detail` of the prior line/record/import.

Properties:

- **Spans imports** (owner + fingerprint), which the per-line idempotency guard
  (step 1, keyed on the line's own id) deliberately does not.
- **Operator-overridable** — `p_allow_duplicate = true` proceeds and reports
  `duplicate_overridden: true`. This is the governance invariant "manual override of
  every decision must remain available" (architecture principle § 2.4). Detection
  *warns*; the operator *decides*.
- **Retraction-safe** — a retracted record clears `payment_record_id` (the column is
  `on delete set null`, § 6.5), so the prior line no longer matches and a corrected
  re-confirm is **not** blocked.
- **Atomic** — it is part of the existing single-transaction bridge; everything else
  in migration 11 (owner coherence, idempotency, source map, link pre-branch, record
  creation, link, line stamp, import recompute) is **verbatim**. The new param forced
  a `DROP + CREATE` (a signature change), not a `CREATE OR REPLACE`.

The JS wrapper `confirmImportLine` surfaces the block as a **typed** error
(`err.code === 'DUPLICATE_CONFIRMED'`, `err.duplicate = {duplicate_line_id,
duplicate_record_id, duplicate_import_id}`) so the UI offers an explicit "Confirm
anyway (override)" button rather than a dead end.

---

## 5. Review-UI surfacing (objectives 6–8)

- **Import level** — `DuplicateWarning` renders `duplicate_check`: a red banner +
  matched-import list for `exact`, an info banner for `near`, each with a "View"
  jump. Shown at the top of `ImportDetail`.
- **Line level (pre-confirm advisory)** — `ImportDetail` loads the owner's confirmed
  line fingerprints once (`listConfirmedLineFingerprints`) and passes them to each
  row; an open line whose fingerprint is already-confirmed shows an "Already
  confirmed" pill *before* the operator even opens the confirm panel.
- **Line level (the block)** — if the operator confirms anyway and the guard fires,
  the confirm panel swaps to a warning + an explicit override button.

Nothing here changes lifecycle state; the only hard stop is the guard, and it is
overridable.

---

## 6. What is deliberately NOT done

- **File hashing (`file_hash`).** Belongs to O9 file upload — no file exists in
  manual entry. The column is already present (migration 10) for that future.
- **Cross-owner detection.** Duplicate detection is owner-scoped, exactly like RLS
  and every other staging read.
- **Auto-merge / auto-supersede.** A detected duplicate is never auto-discarded;
  superseding stays a deliberate, pre-confirm-only operator action (architecture
  § 4.1).
- **Blocking the import.** Detection is advisory end-to-end; only the per-line
  record-minting step is guarded.

---

## 7. Validation (DEV)

`scripts/test-payslip-duplicates.mjs` (mirrors the existing DEV test benches;
refuses to run unless `NEXT_PUBLIC_SUPABASE_URL` targets DEV; cleans up every row it
creates) proves:

- pure fingerprint model — determinism, order-independence, Jaccard, period match;
- the SQL line trigger stamps `content_fingerprint`;
- an identical second import is detected `exact`; a partial-overlap same-period
  import is detected `near`; a unique import is `clear`;
- the confirm guard **blocks** a second confirm of identical content
  (`DUPLICATE_CONFIRMED`), and the explicit override **proceeds** and mints the
  second record (`duplicate_overridden: true`);
- `listConfirmedLineFingerprints` returns the confirmed fingerprint.

---

## 8. Cross-references

- [OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md](OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md) § 4.1 (supersede restriction + blocker #1b), § 11 (blocker #1)
- [supabase/canonical/12_payslip_duplicate_detection.sql](../supabase/canonical/12_payslip_duplicate_detection.sql) — columns, line-fp function + trigger, guarded bridge
- [lib/fat/models/payslipFingerprint.js](../lib/fat/models/payslipFingerprint.js) — pure fingerprint + similarity
- [lib/fat/services/payslipDuplicates.js](../lib/fat/services/payslipDuplicates.js) — detection + confirmed-fingerprint lookup
- [components/payslip/DuplicateWarning.js](../components/payslip/DuplicateWarning.js) — the warning surface
