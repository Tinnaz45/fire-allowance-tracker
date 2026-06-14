# Fire Allowance Tracker — OCR Payslip Import: Architecture & Implementation Roadmap

Version: v1.0
Status: Design — no implementation (architecture + roadmap only)
Last Updated: 2026-06-04
Branch: `dev`

Builds on (does not supersede):

- [RECONCILIATION_STATE_ARCHITECTURE_v1.0.md](RECONCILIATION_STATE_ARCHITECTURE_v1.0.md) — the canonical state contract (§ 4 payment-record semantics, § 4.5 the `payslip_imports` reservation, § 9 helper contracts, § 12 invariants)
- [PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md](PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md) — the built service layer (RPCs in migration 08, MVP terminal rule, tolerance)
- [CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md](CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md) — transition rules
- Governance canonical source: `…/governance-system/chatgpt-project-sources/fire-allowance-tracker/PAYMENT_RECONCILIATION_v1.0.md` § *Payslip Verification (Future)*, § *Future Architecture Guidance*

This document is **architecture only**. It does not implement OCR, does not build
PDF parsers, does not build AI extraction, and does not modify production. Every
speculative choice is marked **Recommendation:** and distinguished from the
already-canonical decisions it builds on.

---

## 0. Headline finding

**The OCR Payslip Import layer is a pure *producer* that sits on top of a finished
consumer contract. It does not touch reconciliation logic — it feeds it.**

The reconciliation layer was deliberately built source-agnostic. The OCR layer's
entire job is to turn an uploaded payslip into validated `payment_records` rows
and (when confident) `entitlement_payment_links` rows — using the **existing,
deployed migration-08 RPCs verbatim**. Three facts make this clean:

| Pre-built seam | Where | Consequence for OCR |
|----------------|-------|---------------------|
| `payment_records.source` already enumerates `payslip_screenshot`, `payslip_pdf` | [reconciliationConstants.js:118-127](../lib/fat/models/reconciliationConstants.js), [08:179](../supabase/canonical/08_reconciliation_service_layer.sql) | Zero change to `payment_records` to ingest OCR output |
| `payment_records.raw_payload jsonb` | [01_canonical_foundation.sql:332](../supabase/canonical/01_canonical_foundation.sql), spec § 4.1 | Per-line OCR snapshot has a home with no schema change |
| `create_payment_record` + `link_entitlement_payment` are atomic, owner-scoped RPCs | [08 § 4–5](../supabase/canonical/08_reconciliation_service_layer.sql) | OCR confirm step *calls* these; it never re-implements status/audit logic |

The genuine new surface is therefore narrow and self-contained:

1. **Two staging tables** (`payslip_imports`, `payslip_import_lines`) — the "raw
   payslip → parsed lines → match candidates → confirmed matches" data model the
   governance doc mandates (§ *Future Architecture Guidance*).
2. **A parser adapter interface** — pluggable, so the pipeline runs end-to-end
   *before* any real OCR/PDF/AI parser exists (MVP is fed by manual structured
   entry).
3. **A confidence model + a confirm bridge** — the only two pieces that translate
   "parsed line" into "call `create_payment_record` then maybe
   `link_entitlement_payment`."

Everything downstream of confirm is already shipped and validated in DEV (37/37
service tests, operator UI at `/payments`). This document resolves blocker #6
(`payslip_imports` staging table) from RECONCILIATION_STATE_ARCHITECTURE § 11.

---

## 1. Where this layer sits

```
┌──────────────────────┐
│ Payslip upload       │  PDF / screenshot / (MVP) manual structured entry
│  (raw file)          │
└──────────┬───────────┘
           │ parser adapter (pluggable; OCR / PDF / manual)
           ▼
┌──────────────────────┐
│ payslip_imports      │  one upload, batch lifecycle           ◀── NEW
│   + import_lines     │  parsed lines + match candidates       ◀── NEW
└──────────┬───────────┘
           │ confirm bridge (per line, atomic RPC)              ◀── NEW
           │   → create_payment_record  (existing RPC, migration 08)
           │   → link_entitlement_payment (existing RPC, optional)
           ▼
┌──────────────────────┐
│ payment_records      │  one observed real-world pay line   (EXISTING)
│   + entitlement_     │  N:M evidence layer                 (EXISTING)
│     payment_links    │
└──────────┬───────────┘
           │ recompute (inside link RPC; EXISTING)
           ▼
┌──────────────────────┐
│ claim_entitlements   │  payment_status flips to paid/claimed (EXISTING)
│   .payment_status    │  every transition audited             (EXISTING)
└──────────────────────┘
```

The dashed boundary is the entire scope of this document: **upload → staging →
confirm bridge.** Below the bridge, nothing is new.

---

## 2. Design principles (inherited, non-negotiable)

These come straight from the reconciliation contract and the governance doc and
constrain every decision below.

1. **Producer-only.** The OCR layer NEVER writes `claim_entitlements`,
   `entitlement_payment_links`, or `reconciliation_audit` directly. It calls the
   migration-08 RPCs, which own those writes atomically (invariant § 12.5).
2. **Staging is disposable; `payment_records` is the source of truth.** A
   `payslip_imports` row and its lines are a *workspace*. Deleting an import
   never deletes a confirmed `payment_records` row — the bridge already copied
   the line into the canonical record (spec § 4.5: "the staging table will
   simply write `payment_records` rows on confirm, with no schema change").
3. **Routing is never inferred.** A matched line against an unrouted entitlement
   does NOT auto-route. It surfaces a needs-routing discrepancy and waits for the
   operator (spec § 3.5). The OCR confidence score is *evidence*, not *policy*.
4. **Manual override is always available.** Governance § *Payslip Verification*:
   "Manual override of every auto-match decision must remain available." Every
   auto-match the matcher proposes is operator-rejectable; every line is
   manually linkable.
5. **No silent entitlement creation.** An unmatched payslip line never
   fabricates an entitlement (governance § *Discrepancy Handling*). It becomes a
   `payment_records` row in the unallocated queue (§ 8.4 of the reconciliation
   spec) or is marked out-of-scope.
6. **Append-only audit, immutable records.** Confirmed `payment_records` are
   immutable; correcting an OCR misread is *retraction* (hard-delete + cascade +
   audit), not an in-place edit (spec § 4.3).

---

## 3. Staging schema

Two tables in the `fat.*` domain. **Additive only** — no change to any existing
table. Proposed migration file: `09_payslip_import_staging.sql` (design only;
not written here).

### 3.1 `fat.payslip_imports` — the upload / batch entity

```sql
create table fat.payslip_imports (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references fat.profiles(id) on delete cascade,
  source         text not null,            -- 'payslip_screenshot' | 'payslip_pdf' | 'manual_entry'
  status         text not null default 'uploaded',
                                            -- uploaded|parsing|parsed|needs_review|confirmed|rejected|superseded|failed
  file_ref       text,                     -- Supabase Storage object path; NOT the bytes (blocker #2)
  file_hash      text,                     -- sha256 of the upload — duplicate detection (blocker #1)
  pay_date       date,                     -- the payslip pay date (parsed or operator-entered)
  pay_period_ref text,                     -- payroll period identifier, if present
  parser_name    text,                     -- which adapter produced the parse
  parser_version text,
  line_count     integer not null default 0,
  raw_extract    jsonb,                    -- full pre-split OCR/parse payload (audit + re-parse)
  error          text,                     -- populated when status = 'failed'
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  confirmed_at   timestamptz
);
```

`source` deliberately adds `'manual_entry'` alongside the two
`payment_records.source` values. Rationale: the *import* can originate from an
operator typing lines (MVP, § 7), while the *payment_records* it eventually
produces still carries a `payment_records.source` ∈
{`payslip_screenshot`,`payslip_pdf`} per the line's true provenance. The two
enums are related but not identical — the import-level enum describes *how the
batch was created*; the record-level enum describes *what kind of evidence a
line is*. (See § 6.2 for the mapping.)

### 3.2 `fat.payslip_import_lines` — parsed lines + match candidates

```sql
create table fat.payslip_import_lines (
  id                      uuid primary key default gen_random_uuid(),
  import_id               uuid not null references fat.payslip_imports(id) on delete cascade,
  owner_id                uuid not null references fat.profiles(id) on delete cascade,  -- denormalized for RLS
  line_index              integer not null,         -- order within the payslip
  raw_text                text,                      -- source text the parser saw for this line
  parsed_reference        text,                      -- payslip line code
  parsed_description       text,                     -- line description / narrative
  parsed_amount           numeric(12,2),             -- gross dollar amount on the line
  parsed_date             date,                      -- line date if line-level (else inherit import.pay_date)
  candidate_entitlement_id uuid references fat.claim_entitlements(id) on delete set null,
  match_confidence        numeric(5,4),              -- 0.0000 – 1.0000 (§ 5)
  match_breakdown         jsonb,                     -- per-signal scores (§ 5.2)
  status                  text not null default 'parsed',
                                                     -- parsed|matched|needs_review|confirmed|rejected|ignored
  payment_record_id       uuid references fat.payment_records(id) on delete set null,  -- bridge output (§ 6)
  link_id                 uuid references fat.entitlement_payment_links(id) on delete set null,
  resolution_note         text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index ix_payslip_import_lines_import on fat.payslip_import_lines(import_id);
create index ix_payslip_import_lines_owner_status on fat.payslip_import_lines(owner_id, status);
create index ix_payslip_import_lines_candidate on fat.payslip_import_lines(candidate_entitlement_id)
  where candidate_entitlement_id is not null;
```

Key relationships:

- **`payment_record_id` is the bridge output** — null until the line is
  confirmed; set to the `payment_records.id` the confirm RPC produced.
  `on delete set null` so a retraction (hard-delete of the payment record,
  spec § 4.3) reverses cleanly back to the staging line without deleting the
  audit trail of what was parsed.
- **`candidate_entitlement_id` is a *suggestion*, not a commitment.** The
  operator may accept, change, or clear it. Cleared on entitlement delete.
- **`link_id`** records which `entitlement_payment_links` row the confirm
  produced (when the line was both confirmed *and* linked), so a per-line undo
  can find it. `on delete set null` because the link can be removed
  independently via the existing `unlinkPayment` path.

### 3.3 What is deliberately NOT stored

- **The file bytes.** `file_ref` points at Supabase Storage; the image/PDF lives
  in a bucket with owner-scoped RLS, not in Postgres (blocker #2). Retention/PII
  policy is a separate decision (§ 9, blocker #5).
- **Any `payment_status` / entitlement state.** Staging never mirrors entitlement
  state; it reads candidate entitlements but the *only* writer of
  `claim_entitlements.payment_status` remains `fat._reconc_recompute` inside the
  link RPC.
- **A second audit log.** Staging mutations (parse, match, operator edits) are
  low-stakes workspace churn and use `updated_at` only. The *canonical* audit
  (`reconciliation_audit`) begins at the confirm bridge, exactly where a
  `payment_records`/link write happens — consistent with spec § 7.3 ("record
  INSERT is not audited"; the *link* is).

### 3.4 RLS

Mirror the existing owner-only posture
([01_canonical_foundation.sql § 10](../supabase/canonical/01_canonical_foundation.sql)):
`users_manage_own` keyed on `owner_id` for both tables. A future
`service_role` batch-parse worker (§ 7, Phase 3) inserts on the user's behalf via
the service-role bypass, exactly as the spec anticipates for batch payslip
import (§ 4.6).

---

## 4. Import lifecycle (state machine)

### 4.1 Import-level status

```
                 parser adapter            operator review            confirm bridge
 uploaded ─────▶ parsing ─────▶ parsed ─────▶ needs_review ─────▶ confirmed
    │             ▲  │                           │                   (terminal)
    │             │  │ (parser error)            │ (all lines
    │             │  ▼                           │  ignored/rejected)
    │             │ failed ──(re-parse)──┘       ▼
    │             └──────────────────┐        rejected
    │                                │
    └──── superseded ◀───────────────┴── (re-upload, same file_hash —
          (PRE-confirm imports only)      only from a NON-confirmed state)
```

- **uploaded** → file stored, not yet parsed.
- **parsing** → parser adapter running (async for real OCR; synchronous for
  manual entry).
- **parsed** → lines materialized; matcher has scored candidates.
- **needs_review** → at least one line needs an operator decision (the default
  resting state for MVP, where *every* line is operator-confirmed).
- **confirmed** → every line is in a terminal line-state
  (`confirmed`/`rejected`/`ignored`); `confirmed_at` stamped. **Terminal at the
  import level** — see the supersede restriction below.
- **rejected** → operator discarded the whole import before confirming any line.
- **superseded** → replaced by a re-upload of the same `file_hash` (blocker #1).
  **Only legal from a PRE-confirm state** (`uploaded`/`parsing`/`parsed`/
  `needs_review`/`failed`). A `confirmed` or partially-confirmed import has
  already produced **immutable** `payment_records` rows (principle § 2.2, § 2.6),
  so it MUST NOT be silently superseded — doing so would strand those records
  while a re-upload re-confirms the same lines into **duplicates**
  (`create_payment_record` has no dedup, [08:158-188](../supabase/canonical/08_reconciliation_service_layer.sql),
  and the per-line idempotency guard does not span imports — each re-upload mints
  fresh lines). Replacing a *confirmed* import therefore requires explicit
  per-record retraction (§ 6.5) of the prior records first; this is folded into
  the duplicate-detection rule (blocker #1 / O9), which must prevent
  *double-confirm of already-confirmed lines*, not merely mark the older upload
  superseded.
- **failed** → parser raised; `error` populated. **Not terminal** — the operator
  may **re-parse** (`failed → parsing`, e.g. with a newer `parser_version`; the
  retained `raw_extract` makes this cheap) or abandon the import (`failed →
  superseded` via a fresh upload). "Fall back to manual entry" means starting a
  *new* `manual_entry` import, not mutating the failed row.

An import is **confirmable** when no line is still in `parsed`/`matched`/
`needs_review`. Partial confirmation is allowed (confirm some lines, leave the
import open) — the import only reaches `confirmed` when the last line resolves.

### 4.2 Line-level status (carries the real detail)

```
 parsed ──(matcher)──▶ matched ──(operator accepts)──▶ confirmed ──▶ [payment_record + maybe link]
   │                      │                                ▲
   │                      │ (low confidence)               │
   │                      ▼                                │
   └──────────────▶ needs_review ──(operator links/types)──┘
                         │
                         ├──(operator: not mine / payroll noise)──▶ ignored
                         └──(operator: wrong, discard)────────────▶ rejected
```

- **parsed** → extracted, not yet scored (transient).
- **matched** → matcher attached a `candidate_entitlement_id` with confidence ≥
  review threshold (§ 5.3).
- **needs_review** → no confident candidate; operator must link or resolve.
- **confirmed** → bridge fired; `payment_record_id` (and maybe `link_id`) set.
  **Terminal, idempotent** — re-confirming is a no-op (§ 6.3).
- **ignored** → operator says "this line is not a tracked entitlement"
  (out-of-scope payroll line). No `payment_records` row. Auditable as a
  resolution_note.
- **rejected** → operator says "this is a misread / garbage line." No record.

`ignored` vs `rejected` is the governance distinction (§ *Discrepancy Handling*):
*out-of-scope* vs *error*. Both are terminal and produce no canonical row, but
they answer different questions in a later "what did this pay cycle look like?"
review.

---

## 5. Confidence scoring model

The matcher proposes a `candidate_entitlement_id` and a `match_confidence ∈
[0,1]` per line. This resolves blocker #5 (matcher confidence threshold) with
**Recommendation** defaults; the canonical doc owns final numbers.

### 5.1 Candidate set (hard filters before scoring)

A line is only scored against entitlements that are *eligible to receive it*:

- `entitlement.owner_id = import.owner_id` (owner coherence, spec § 5.6 inv 1).
- `entitlement.payment_method = 'payslip'` **OR** `payment_method IS NULL`.
  A payslip line can never settle a petty-cash-routed entitlement (stream
  coherence, spec § 5.6 inv 2). Unrouted candidates are *scoreable* but produce a
  needs-routing outcome on confirm, never an auto-link (§ 6.4).
- `entitlement.payment_status ≠ terminal` preferred (already-paid entitlements
  rank lower but are not excluded — a correcting/duplicate line is legitimate).

### 5.2 Signals (weighted, stored in `match_breakdown`)

| Signal | What it compares | Weight (Recommendation) |
|--------|------------------|--------------------------|
| `amount` | line `parsed_amount` vs entitlement `effective_amount` (dollars-first) or vs the expected payslip dollar value (hours-first — needs an hours→$ expectation, see note) | 0.45 |
| `pay_cycle` | `parsed_date` / `import.pay_date` vs the entitlement's expected pay cycle for its claim date | 0.25 |
| `reference` | `parsed_reference` / `parsed_description` token overlap with the entitlement's type label / rule | 0.20 |
| `type` | entitlement_type ↔ line description heuristics (e.g. "EXCESS TRAVEL", "MEAL") | 0.10 |

`match_confidence` = Σ(weight × signal_score), each signal_score ∈ [0,1].
`match_breakdown` persists the per-signal contribution so the operator (and a
later audit) can see *why* a line matched.

> **Hours-first note (MVP-critical).** Two of the three Standby entitlement types
> are hours-first (`generated_amount = NULL`), so the `amount` signal cannot
> compare against a stored dollar value — the entitlement carries no dollar
> quantity at generation (PAYMENT_RECORDS_LAYER_DESIGN § 1.4, § 4.3). For
> hours-first rows the matcher must derive an *expected* payslip dollar value
> (hours × rate snapshot) purely as a **matching hint** — it is NOT persisted and
> NOT used for terminal determination (the hours-first terminal rule is "≥ 1
> status-eligible link exists", [reconciliationHelpers.js:92](../lib/fat/models/reconciliationHelpers.js)).
> This keeps the unit-conflict memory invariant intact (never derive hours from
> dollars or vice-versa for *state*; here it is a transient ranking hint only).
>
> **Rate-accessor dependency.** The entitlement read path the queues expose
> ([reconciliationQueues.js:27-29](../lib/fat/services/reconciliationQueues.js))
> carries `generated_hours` and the unit but **no rate** — so the `amount` signal
> cannot compute the hours×rate hint for hours-first rows without a new accessor
> over the seeded canonical rates (canonical_04/05). This is a real O4 dependency
> (see roadmap § 10 and blocker #8). **MVP fallback** (chosen): if the accessor
> isn't ready, the matcher scores hours-first rows on `pay_cycle` + `reference` +
> `type` only (0.55 of the weight) and the `amount` signal is dollars-first-only.
> Lines are still scored and pre-matched — ranking degrades, it does not break.

### 5.3 Bands (Recommendation — gated by blocker #5)

| Confidence | Line status after parse | MVP behaviour |
|------------|--------------------------|---------------|
| ≥ 0.90 | `matched` (auto-match eligible) | **Still operator-confirmed in MVP.** The band only pre-selects the candidate and pre-fills the link. Auto-confirm is a later phase (§ 7, Phase 4). |
| 0.50 – 0.90 | `matched` (review) | Candidate shown, operator confirms/changes. |
| < 0.50 | `needs_review` | No candidate pre-filled; operator links manually or ignores. |

MVP deliberately keeps a human in the loop on every line (governance: manual
override always available). The confidence band's only MVP job is to **order and
pre-fill** the review queue, not to bypass it.

---

## 6. The confirm bridge — OCR line → payment_record (the only new write path)

This is the single seam where staging becomes canonical. One atomic RPC per line.

### 6.1 `fat.confirm_payslip_import_line` (proposed, design only)

```
confirm_payslip_import_line(
  p_line_id        uuid,
  p_actor_id       uuid,
  p_entitlement_id uuid    default null,   -- operator's final choice (may differ from candidate)
  p_link_kind      text    default null,   -- 'auto_match' | 'manual' | null (record only, no link)
  p_allocated_amount numeric default null, -- defaults to parsed_amount when linking
  p_tolerance      numeric default 0.01
) returns jsonb
```

Declared **`SECURITY INVOKER`** with `search_path = fat, pg_temp`, exactly like
the migration-08 functions — so on the operator path RLS still guards the
`create_payment_record` insert via `with check (auth.uid() = owner_id)`
([01_canonical_foundation.sql:474-475](../supabase/canonical/01_canonical_foundation.sql)).

Transaction (mirrors the migration-08 RPC composition style exactly):

0. **Assert owner coherence (do NOT skip on the record-only path).** Refuse
   unless `line.owner_id = p_actor_id`. This is load-bearing: `create_payment_record`
   itself performs **no** owner==actor check ([08:158-188](../supabase/canonical/08_reconciliation_service_layer.sql)
   — its only owner protection is RLS), and for a record-only / unrouted line
   (§ 6.4) the bridge never calls `link_entitlement_payment`, whose owner check
   ([08:247-250](../supabase/canonical/08_reconciliation_service_layer.sql))
   would otherwise be the only guard — and even that check only compares
   entitlement-vs-record owner, not the `= auth.uid()` third leg invariant § 12.9
   requires. For the anticipated `service_role` batch worker (§ 3.4, § 9, O10),
   RLS is bypassed entirely, so this in-RPC assertion is the *sole* owner guard:
   the worker MUST derive `owner_id` from the authenticated batch owner and pass
   `p_actor_id` = that same owner — never trust a client-supplied `owner_id` on
   the staging line.
1. **Guard idempotency.** If `line.status = 'confirmed'` and
   `payment_record_id IS NOT NULL`, return the existing result (no double
   record). Refuse if `line.status ∈ {rejected, ignored}`.
2. **Create the payment record** by calling the *existing*
   `fat.create_payment_record` with:
   - `p_owner_id` = line.owner_id
   - `p_stream` = `'payslip'`
   - `p_record_date` = `coalesce(line.parsed_date, import.pay_date)`
   - `p_gross_amount` = `line.parsed_amount`
   - `p_source` = the import's record-level source (§ 6.2)
   - `p_reference` = `line.parsed_reference`
   - `p_raw_payload` = the staging-line snapshot (raw_text, parsed fields,
     match_breakdown, import_id, line_id) — full provenance, spec § 4.1.
3. **Decide link-eligibility BEFORE calling the link RPC** (this is a deliberate
   branch, not a caught exception — see the atomicity note below). The bridge
   reads the chosen entitlement and links *only* when all of these hold:
   `p_entitlement_id` and `p_link_kind` are set **and** the entitlement is routed
   (`payment_method = 'payslip'`) **and** stream-coherent. When they hold, it
   calls the *existing* `fat.link_entitlement_payment`, which re-enforces owner +
   stream coherence, the allocation cap, recompute, and the audit row (08 § 5) —
   the OCR layer adds nothing to that logic. When they do **not** hold (no
   entitlement chosen, or the entitlement is unrouted), the bridge skips the link
   entirely and the record stays in the unallocated queue (§ 6.4).
4. **Stamp the line**: `payment_record_id`, `link_id` (null when unlinked),
   `status = 'confirmed'`, `resolution_note`.
5. **Recompute import status**: if no non-terminal lines remain, set the import
   to `confirmed`, stamp `confirmed_at`.

All steps commit in one transaction. The bridge must *pre-branch* on routing
(step 3) rather than call the link RPC and catch its failure: a `RAISE EXCEPTION`
inside `link_entitlement_payment` ([08:262](../supabase/canonical/08_reconciliation_service_layer.sql))
aborts the whole transaction, which would roll back the step-2 record insert too.
So "create the record, leave it unlinked" is achieved by *not attempting* the
link, never by swallowing its exception. A genuine link error that the pre-branch
can't predict (e.g. allocation over-cap on a routed entitlement) DOES abort the
whole confirm and surfaces to the operator — correct, because that record
shouldn't exist without its intended link.

### 6.2 Source mapping (import enum → record enum)

| `payslip_imports.source` | `payment_records.source` written by bridge |
|--------------------------|---------------------------------------------|
| `payslip_pdf` | `payslip_pdf` |
| `payslip_screenshot` | `payslip_screenshot` |
| `manual_entry` | `payslip_pdf` **or** `manual` — **Recommendation:** use `manual` so the canonical provenance reads "operator typed it," matching spec § 4.4. |

The `payment_records.source` CHECK in `create_payment_record`
([08:179](../supabase/canonical/08_reconciliation_service_layer.sql)) already
accepts all of `manual`, `payslip_screenshot`, `payslip_pdf` — **no migration-08
change is required.**

### 6.3 Cardinality — line ↔ payment_record is 1:1

**One confirmed staging line produces exactly one `payment_records` row.** This
holds even for a "combined" payslip line that settles several entitlements:

- The single line → one `payment_records` row carrying the full `gross_amount`.
- Multiple entitlements are then served by **multiple
  `entitlement_payment_links`** off that one record, each with its own
  `allocated_amount` (the existing combined-payment capability, spec § 5.4 / § 5,
  PAYMENT_RECORDS_LAYER_DESIGN § 5). In MVP this means: confirm the line to create
  the record, then use the existing `/payments` manual-link UI to add the second+
  allocation. (A multi-allocation confirm form is a later UI nicety, § 7 Phase 2.)

The inverse — one entitlement settled across several payslip lines (partial
payments across pay cycles) — is also already supported: each line is its own
record, each links to the same entitlement, and the dollars-first terminal rule
sums allocations until `≥ effective − tolerance` (08 `_reconc_recompute`).

### 6.4 Routing-unknown lines (the deliberate dead-end)

If the operator's chosen entitlement is unrouted (`payment_method IS NULL`),
the bridge's step-3 pre-branch (§ 6.1) detects this and **does not call the link
RPC at all** — it creates the `payment_record` (step 2) and stamps the line
`confirmed` with `link_id = null`. The record lands in the unallocated-payments
queue and the entitlement stays in the needs-routing queue. The operator routes,
then links the now-unallocated record via the existing `/payments` manual-link
UI. This preserves "routing is never inferred" (principle § 2.3) without relying
on catching the link RPC's `RAISE EXCEPTION` (which would roll back the record —
§ 6.1 atomicity note).

> **Routing helper dependency.** Routing an unrouted entitlement requires
> `routeEntitlement` (spec § 9.1), which is **Step G of the payment-records
> roadmap and is NOT yet built** (PAYMENT_RECORDS_LAYER_DESIGN § 7 Step G — lower
> priority because SB/MD arrive pre-routed). For the OCR **MVP** this is not a
> blocker *only because* MVP entitlements (SB/MD) are pre-routed by the engine
> (§ 1.3 of the payment-records design), so the unrouted branch is effectively
> dead in MVP. The moment Recall/Retain entitlements (which defer routing) enter
> reconciliation, this path becomes live and Step G must ship first. This is
> called out honestly in § 8 and the roadmap (§ 10) rather than hidden under
> "zero blockers."

### 6.5 Retraction / reverse bridge

Retracting an OCR-sourced `payment_records` row (operator realizes the OCR
misread an amount) uses the `retractPayment` path (spec § 9.4 — hard-delete +
cascade links + per-former-link `unlink_payment` audit). **`retractPayment` is
NOT yet built** — it is Step F of the payment-records roadmap
([PAYMENT_RECORDS_LAYER_DESIGN § 7](PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md), and
there is no `retract_payment` RPC in migration 08), so the OCR reverse-bridge and
MVP exit criterion (6) below **depend on Step F shipping first** (tracked in the
roadmap § 10, O-deps). Because
`payslip_import_lines.payment_record_id` is `on delete set null`, the staging
line automatically reverts to "confirmed but unlinked record gone." **Recommendation:**
the retraction UI also resets that line's `status` to `needs_review` so it
re-enters the operator's queue rather than silently disappearing. This is a
staging-side convenience, not a canonical requirement.

---

## 7. Reconciliation touchpoints (summary)

Everything the OCR layer touches in the reconciliation layer, and how:

| Touchpoint | Direction | Mechanism | Invariant honoured |
|------------|-----------|-----------|--------------------|
| `payment_records` | write (insert) | `create_payment_record` RPC | § 12.10 immutability — bridge inserts, never updates |
| `entitlement_payment_links` | write (insert) | `link_entitlement_payment` RPC | § 12.4 stream coherence; § 12.11 allocation cap — enforced by the RPC |
| `claim_entitlements.payment_status` | indirect | recompute *inside* the link RPC | § 12.5 atomic transitions; § 12.6 routing deliberate |
| `reconciliation_audit` | indirect | written by the link RPC | § 12.8 append-only |
| needs-routing queue | read | `listNeedsRouting` (built) | § 12.6 — OCR never auto-routes |
| unallocated queue | read | `listUnallocatedPayments` (built) | unmatched lines surface here, never auto-create entitlements |
| `auto_match` vs `manual` link_kind | write | confidence ≥ auto-band & operator-accepted ⇒ `auto_match`; operator-typed ⇒ `manual` | § 5.3 status-eligibility unchanged |

**The OCR layer introduces zero new reconciliation semantics.** It chooses
*which* existing RPC to call and *what arguments* to pass. The
`auto_match`/`manual` distinction (link_kind) is the only reconciliation-visible
artifact it sets, and both kinds are already status-eligible and already audited.

---

## 8. MVP scope

**Scope: end-to-end payslip import driven by manual structured entry, producing
canonical `payment_records` + links through the confirm bridge — with NO OCR, NO
PDF parser, NO AI extraction.**

This is the smallest slice that delivers the *entire pipeline shape*. It carries
no *canonical* blockers (duplicate-detection and storage, blockers #1/#2, don't
apply to manual entry; the matcher's rate accessor, #8, has a working MVP
fallback in § 5.2). Two **same-codebase dependencies** are honestly flagged
rather than hidden: the reverse-bridge / exit-criterion (6) needs `retractPayment`
(Step F of the payment-records roadmap, not yet built — § 6.5), and the unrouted
branch (§ 6.4) needs `routeEntitlement` (Step G) — but Step G is dead in MVP
because SB/MD entitlements arrive pre-routed. The slice proves the staging schema,
the lifecycle, the confidence-band UI ordering, and — most importantly — the
confirm bridge against the live migration-08 RPCs.

In MVP:

- `payslip_imports` + `payslip_import_lines` tables (migration 09).
- A **manual-entry parser adapter**: the operator creates an import and types
  lines (reference, amount, date, description). `source = 'manual_entry'`;
  produced records carry `payment_records.source = 'manual'` (§ 6.2).
- The **matcher** scoring candidates against payslip-eligible entitlements (§ 5),
  pre-filling the review queue. Confidence is computed and shown; **no
  auto-confirm** — every line is operator-confirmed.
- The **confirm bridge RPC** (`confirm_payslip_import_line`) calling the existing
  `create_payment_record` + `link_entitlement_payment`.
- A **review UI**: a new sub-surface under `/payments` listing an import's lines
  with their candidate, confidence, and per-line confirm/ignore/reject actions.
- Reuse of the built `/payments` manual-link UI for the combined-line second
  allocation (§ 6.3) and for the unallocated/needs-routing queues.

Out of MVP (deferred, each independently — none block the slice above):

- **Real parsers.** PDF structured-line extraction; screenshot OCR; AI
  field extraction. The parser-adapter interface (§ 7-below) makes these
  drop-in.
- **Auto-confirm.** The ≥ 0.90 band creating `auto_match` links without an
  operator click (blocker #5 final thresholds).
- **File storage + duplicate detection** (blockers #1, #2) — irrelevant to
  manual entry; required the moment real file upload lands.
- **Batch/async parse worker** running as `service_role` (spec § 4.6).
- **PII / image retention policy** (blocker #5-PII).
- **Overdue / non-appearance detection — OUT OF SCOPE BY DESIGN.** Governance
  § *Discrepancy Handling* has two halves; this OCR layer satisfies only the
  first ("a payslip *line* doesn't match an entitlement" → unmatched-line
  surfacing, principle § 2.5). The second half — "an expected entitlement that
  *never appears* on a payslip must stay `pending` past its pay cycle and be
  surfaced as overdue" — **cannot** be served by a line-driven producer: an
  entitlement with no corresponding line produces no staging line, so the OCR
  layer is structurally blind to it. Overdue-surfacing is an *entitlement-driven*
  "expected-but-absent" pass that belongs in the **reconciliation queue layer**
  (keyed on `import.pay_date` coverage), governed by the overdue heuristic
  (reconciliation blocker #8 / governance TODO). Named here so OCR is not
  mistaken for full § *Discrepancy Handling* coverage.

MVP exit criteria: an operator can (1) create a manual import and type N payslip
lines, (2) see each line scored and pre-matched to an SB/MD entitlement, (3)
confirm a line and watch a `payment_records` row appear and the entitlement flip
to `paid` via the existing recompute, (4) see the transition in
`reconciliation_audit`, (5) ignore an out-of-scope line and reject a misread one
with no canonical write, (6) retract a confirmed record and watch the staging
line revert — all owner-scoped and atomic server-side. **Criterion (6) depends
on `retractPayment` (Step F of the payment-records roadmap), which is NOT yet
built** (§ 6.5); if Step F has not shipped when OCR MVP lands, drop (6) and treat
§ 6.5 retraction as the first post-MVP follow-up.

---

## 9. The parser adapter interface (why the MVP scales)

The single abstraction that lets MVP ship without OCR and lets OCR drop in later
without touching staging, the bridge, or reconciliation:

```
ParserAdapter.parse(file_or_input, ctx) ──▶ {
  pay_date?, pay_period_ref?, raw_extract,
  lines: [{ line_index, raw_text?, parsed_reference?, parsed_description?,
            parsed_amount?, parsed_date? }]
}
```

- **MVP adapter:** `ManualEntryAdapter` — `lines` come straight from the operator
  form; `raw_extract` is the form payload.
- **Phase 2 adapter:** `PdfLineAdapter` — parse a structured FRV payslip PDF into
  lines (the easier real parser; PDFs have extractable text).
- **Phase 3 adapter:** `ScreenshotOcrAdapter` — OCR a screenshot, then AI/heuristic
  field extraction into the same `lines` shape.

Every adapter returns the **same line shape**, so the matcher (§ 5), the bridge
(§ 6), and the review UI are written once. This mirrors the architectural move
that made `payment_records` source-agnostic — the OCR layer is *adapter*-agnostic
the same way.

> Server-side note: real OCR/AI extraction (Phase 3) should run as a Vercel
> Function / route (the repo already has the pattern at
> `app/api/travel/google/route.js`, per memory `project_no_server_routes`), not in
> the browser — keep extraction keys server-side and write staging rows via the
> `service_role` path (spec § 4.6).

---

## 10. Implementation roadmap

Each step is independently shippable; later steps depend on earlier ones.

| Step | Deliverable | Depends on | Blockers it clears |
|------|-------------|------------|--------------------|
| **O1** | `09_payslip_import_staging.sql` — the two tables + RLS + indexes (§ 3). Additive, idempotent, DEV first. | migration 08 (done) | #6 (staging table) |
| **O2** | Staging models + constants (`lib/fat/models/payslipImport.js`): typedefs, `IMPORT_STATUS`, `IMPORT_LINE_STATUS`, source mapping. Pure JS, no Supabase. | O1 | — |
| **O3** | `ManualEntryAdapter` + the `ParserAdapter` interface (§ 9). | O2 | — |
| **O4** | Matcher service (`lib/fat/services/payslipMatcher.js`): candidate filter (§ 5.1) + signal scoring (§ 5.2) + band assignment (§ 5.3). Pure-ish; reads entitlements. **Amount signal on hours-first rows needs a rate accessor (blocker #8); MVP fallback scores those on the other 0.55 of weight.** | O2 (+ rate accessor for the hours-first amount hint) | partial #5 (thresholds as params) |
| **O5** | Staging services: `createImport`, `addImportLines`, `listImportLines`, `updateLineResolution` (workspace CRUD, owner-scoped). | O1–O2 | — |
| **O6** | **Confirm bridge RPC** `fat.confirm_payslip_import_line` + JS wrapper (§ 6). Calls existing `create_payment_record` / `link_entitlement_payment`. The keystone. | O1, migration 08 | — |
| **O7** | Review UI under `/payments`: import list, per-import line table with candidate/confidence, confirm/ignore/reject actions, link to existing manual-link + queues. | O3–O6 | — |
| **O8** | Test bench: a `scripts/test-payslip-import.mjs` proving O1–O7 end-to-end against DEV (mirrors `test-reconciliation-service.mjs`). **Must assert the owner-coherence invariant `line.owner_id == p_actor_id == payment_record.owner_id` on BOTH the linked and record-only confirm paths (§ 6.1 step 0).** | O1–O7 | — |
| **O9** *(post-MVP)* | `PdfLineAdapter` + file upload + Supabase Storage bucket + `file_hash` duplicate detection. | O3 | #1, #2 |
| **O10** *(post-MVP)* | `ScreenshotOcrAdapter` (server route + OCR/AI extraction), `service_role` batch worker. | O9 | — |
| **O11** *(post-MVP)* | Auto-confirm for the ≥ 0.90 band; finalize confidence thresholds with FRV. | O4, O7 | #5 (final) |

Atomicity note (carried from PAYMENT_RECORDS_LAYER_DESIGN § 7): the confirm
bridge (O6) MUST be a Postgres RPC, not a client-side multi-call, so the
record-insert + link + recompute + audit commit together. Doing it client-side
would violate invariant § 12.5 on any partial failure. The bridge *composes*
existing RPCs; whether it does so as a single wrapping PL/pgSQL function (calling
the other two) or inlines their calls is an O6 implementation choice — the
wrapping-function approach is recommended so each underlying RPC's guards run
unchanged.

---

## 11. Open blockers carried by this design

| # | Blocker | Affects | Owner / resolution |
|---|---------|---------|--------------------|
| 1 | Duplicate-detection rule (`file_hash` exact, or fuzzy pay-period match). **Must also prevent re-confirming already-confirmed lines into duplicate records, not merely mark the older upload `superseded` (§ 4.1).** | O9 file upload | New canonical TODO — next `PAYMENT_RECONCILIATION` revision |
| 2 | File storage location + bucket RLS (Supabase Storage) | O9 | `DATABASE_ARCHITECTURE § TODO` |
| 3 | Confidence thresholds (auto / review / no-match bands) — § 5.3 are Recommendations | O4, O11 | Reconciliation blocker #5 |
| 4 | Pay-cycle inference (claim date → expected FRV pay cycle) for the `pay_cycle` *matching signal*. **Distinct from overdue-surfacing**, which is out-of-scope-by-design (§ 8) and lives in the reconciliation queue layer. | O4 matcher ranking | New canonical TODO (relates to overdue heuristic, reconciliation blocker #8) |
| 5 | PII / retention policy for stored payslip images (how long, who can read, deletion) | O9–O10 | New canonical TODO — privacy review |
| 6 | `manual_entry` import → `payment_records.source` mapping (`manual` recommended, § 6.2) | O6 | Confirm in next reconciliation revision |
| 7 | Multi-allocation confirm UX (combined line → N links in one action) vs MVP "confirm then manual-link" | O7 polish | UI decision, post-MVP |
| 8 | Hours-first amount-signal rate accessor — the 0.45-weight `amount` signal can't value an hours-first SB row (`generated_amount = NULL`) without a rate lookup absent from the entitlement read path ([reconciliationQueues.js:27-29](../lib/fat/services/reconciliationQueues.js)) | O4 matcher accuracy on the majority MVP case | New canonical TODO — accessor over seeded rates (canonical_04/05). MVP fallback: § 5.2 |

Cross-layer dependency (not a blocker but a sequencing fact): the reverse-bridge
(§ 6.5) and MVP exit criterion (6) need **`retractPayment` (Step F of the
payment-records roadmap)**, which is not yet built. OCR MVP can ship without it
(retraction is the first post-MVP follow-up) but criterion (6) cannot be
exercised until Step F lands.

None of the blockers above block the MVP slice (§ 8): #1/#2/#5 are file-upload
concerns absent from manual entry; #3 has working Recommendation defaults; #4 and
#8 degrade matcher *ranking* only (operator still confirms every line); #6/#7 have
working defaults.

---

## 12. Cross-references

- [RECONCILIATION_STATE_ARCHITECTURE_v1.0.md](RECONCILIATION_STATE_ARCHITECTURE_v1.0.md) § 4 (record semantics), § 4.5 (this table reserved), § 9 (helper contracts), § 11 (blocker #6), § 12 (invariants)
- [PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md](PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md) § 4.3 (terminal/tolerance), § 5 (combined/partial), § 7 (atomic RPC pattern)
- [supabase/canonical/08_reconciliation_service_layer.sql](../supabase/canonical/08_reconciliation_service_layer.sql) — the RPCs the bridge composes
- [lib/fat/services/paymentRecords.js](../lib/fat/services/paymentRecords.js), [reconciliation.js](../lib/fat/services/reconciliation.js), [reconciliationQueues.js](../lib/fat/services/reconciliationQueues.js) — the built consumer layer
- [lib/fat/models/reconciliationConstants.js](../lib/fat/models/reconciliationConstants.js) — source / link_kind / action enums the bridge reuses
- Governance: `PAYMENT_RECONCILIATION_v1.0.md § Payslip Verification (Future)`, `§ Future Architecture Guidance`
```
