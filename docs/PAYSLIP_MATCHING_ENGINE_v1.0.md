# Fire Allowance Tracker — Payslip Matching Engine (Step O4): Design & Build

Version: v1.0
Status: BUILT + validated in DEV (manual-entry MVP)
Last Updated: 2026-06-04
Branch: `dev`

Builds on (does not supersede):

- [OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md](OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md) § 5 (confidence model), § 4.2 (line lifecycle), § 11 blocker #8 (rate accessor), blocker #4 (pay-cycle inference)
- [PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md](PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md) § 1.4 / § 4.3 (hours-first vs dollars-first)

This is the **candidate-recommendation** layer (roadmap Step O4). It proposes a
ranked candidate entitlement + a confidence score for each staged payslip line so
the Review UI pre-fills and orders the operator's queue. **It is evidence, not
policy** — it never auto-confirms, never writes canonical reconciliation state,
and never changes a line's lifecycle status. Operator approval stays mandatory.

---

## 0. Headline

The matcher writes **only** the three suggestion columns that
`fat.payslip_import_lines` already carries (migration 10):
`candidate_entitlement_id`, `match_confidence` (numeric(5,4)), `match_breakdown`
(jsonb). No schema change. No new write path into the canonical world. The confirm
bridge (migration 11) remains the single seam where staging becomes canonical, and
it is unchanged.

| New surface | File |
|-------------|------|
| Scoring engine + service | [lib/fat/services/payslipMatcher.js](../lib/fat/services/payslipMatcher.js) |
| Auto-score on import creation | [lib/fat/services/payslipImports.js](../lib/fat/services/payslipImports.js) `createManualEntryImport` (additive, non-fatal) |
| Confidence display | [components/payslip/statusUi.js](../components/payslip/statusUi.js) `ConfidenceBadge` |
| Recommendation in review | [components/payslip/ImportLineRow.js](../components/payslip/ImportLineRow.js) `MatchRecommendation` + pre-fill |
| Re-run matching | [components/payslip/ImportDetail.js](../components/payslip/ImportDetail.js) |
| DEV test (41 assertions) | [scripts/test-payslip-matcher.mjs](../scripts/test-payslip-matcher.mjs) |

---

## 1. Candidate set — hard filters (architecture § 5.1)

A line is scored only against entitlements eligible to receive it. The loader
`listPayslipMatchCandidates(ownerId)`:

- `owner_id = import.owner_id` (owner coherence)
- `payment_method = 'payslip'` (stream coherence — a payslip line can never settle
  a petty-cash entitlement)
- `payment_status = 'pending'` (non-terminal)
- embeds `operational_claims.claim_date` for the date-proximity signal

**MVP scope deviation (deliberate, documented).** Architecture § 5.1 also admits
unrouted (`payment_method IS NULL`) and already-terminal candidates at lower rank.
MVP excludes both:

- *Unrouted* needs `routeEntitlement` (deferred Step G) and is **dead in MVP**
  because SB/MD entitlements arrive pre-routed to payslip.
- *Re-pay / duplicate* matching against `paid` rows lands with auto-confirm (O11).

This keeps the candidate set **identical to the operator-selectable confirm
picker** (`listPendingPayslip`), so every suggestion is actionable.

---

## 2. Signals (architecture § 5.2)

| Signal | Weight | Compares | Applicable when |
|--------|--------|----------|-----------------|
| `amount` | 0.45 | line `parsed_amount` vs entitlement effective $ | line has an amount **and** the entitlement is dollars-first |
| `pay_cycle` | 0.25 | line date (`parsed_date` ∥ import `pay_date`) vs candidate claim date | both dates present |
| `reference` | 0.20 | line text tokens ∩ candidate type-label tokens | line has text |
| `type` | 0.10 | line's inferred type vs candidate type (exact / family / conflict) | a type can be inferred from the line text |

Each signal returns `{ applicable, score ∈ [0,1] }`. `match_breakdown` persists
every signal's score (and `days` / `overlap` / `inferred` detail) so the operator
and a later audit can see **why** a line matched.

- **amount** — exact (within $0.01 tolerance) → 1; otherwise relative closeness
  `max(0, 1 − |Δ| / effective)`.
- **pay_cycle** — proximity decay `max(0, 1 − days / 35)`. Pay-cycle *inference*
  (claim date → exact expected FRV cycle, blocker #4) is unresolved; this absolute
  proximity is the documented MVP stand-in. Ranking degrades gracefully.
- **reference** — token overlap fraction against the canonical type label.
- **type** — keyword inference (`inferLineType`): exact type match → 1, same family
  (e.g. both `excess_travel_*`) → 0.5, a confident *conflicting* type → 0.

---

## 3. Combination — re-normalization over applicable signals

```
confidence = Σ(weight × score | applicable) / Σ(weight | applicable)
```

A signal that isn't applicable neither inflates nor deflates the result — it
simply doesn't vote, and the confidence stays in `[0,1]`.

### 3.1 This resolves blocker #8 (the hours-first amount signal)

**Grounding fact:** *every* payslip-routed entitlement in DEV is hours-first
(`excess_travel_standby`, `excess_travel_md`, `standby_dismi`, `muster_dismis`).
Their `rate_snapshot` stores **hours** (e.g. standby dismissal = 0.5 h), not a
dollar pay rate — so there is **no hours→dollar conversion derivable from canonical
data**. The architecture's blocker #8 "MVP fallback" is therefore not a degraded
path; it is the *only* correct one: the `amount` signal is genuinely inapplicable
to the entire MVP candidate population.

The literal reading of the fallback ("score on 0.55 of the weight") would cap every
hours-first line at 0.55 confidence — below even the review band — making the
matcher inert in practice. **Re-normalization** is the chosen resolution: an
hours-first line is scored over the `{pay_cycle, reference, type}` weights
*re-normalized to 1.0*, so a strong match still reaches the auto band.

> **Validated live:** a manual "EXCESS TRAVEL" line scored **0.987 (auto)** against
> a real `excess_travel_standby` entitlement with `amount.applicable = false`.

### 3.2 The identifying-evidence guard

`amount` / `reference` / `type` **identify** a line as a given entitlement;
`pay_cycle` only **corroborates** timing. Without at least one *positive
identifying* signal, the candidate scores **0** — date proximity can never
manufacture a match on its own. This matters specifically because the amount signal
is absent for the hours-first majority: without the guard, a payroll-noise line
("UNION FEE") falling in the pay window would falsely pre-fill on date alone.

---

## 4. Bands & lifecycle (architecture § 5.3)

`confidenceBand(score)` → `auto` (≥ 0.90) · `review` (≥ 0.50) · `none` (< 0.50).

- The band is **display-only**. The persisted `payslip_import_lines.status` enum
  has **no `matched` value** (the architecture described one; the built schema
  dropped it to keep the lifecycle vocabulary synonym-free). The matcher therefore
  **never transitions a line** — scored lines stay `parsed`.
- `candidate_entitlement_id` is pre-filled only when the top score ≥ the **review**
  threshold; a weak best match leaves the line un-prefilled for a manual link.
- **No auto-confirm in any band.** Even an `auto` line is operator-confirmed; the
  band only orders and pre-fills the queue. The confirm picker pre-selects the
  recommendation (★) but the operator can change or clear it.

---

## 5. Review UI

- Each open line shows a **Suggested** panel: a `ConfidenceBadge`
  (Strong/Likely/No match + %), the proposed entitlement, and the per-signal "why"
  line (only applicable signals are shown — `amount` is omitted for hours-first).
- The confirm picker pre-selects the recommendation and labels it
  `★ … (suggested, NN%)`; choosing "record only" clears the stale suggestion.
- `ImportDetail` exposes **Re-run matching** for open imports (useful after
  entitlements are created/edited).
- New imports are auto-scored inside `createManualEntryImport` (additive +
  non-fatal: a matcher failure never blocks the import landing for manual review).

---

## 6. Invariants honoured

1. **Producer-only.** The matcher writes only the three suggestion columns. It
   creates no `payment_records`, no `entitlement_payment_links`, no
   `reconciliation_audit`, and touches no `claim_entitlements.payment_status`.
   (Verified: scoring an import leaves the entitlement `pending` and link-free.)
2. **No lifecycle mutation / no synonyms.** Scored lines remain `parsed`; the band
   is derived, never persisted as a status.
3. **Operator approval mandatory.** Nothing is auto-confirmed; the band only
   pre-fills and orders.
4. **Evidence, not policy** (architecture § 2.3). A match is a suggestion the
   operator accepts, changes, or clears. Routing is still never inferred.

---

## 7. Validation

`node scripts/test-payslip-matcher.mjs` — **41/41 passing** against DEV:

- pure unit: every signal scorer, the re-normalization (hours-first reaches the
  bands; not capped at 0.55), the identifying-evidence guard, band classification,
  ranking order.
- DB: candidate hard filters (payslip+pending only, petty-cash excluded, claim date
  embedded), `createManualEntryImport` auto-scores, the matcher writes no canonical
  state and no lifecycle transition, `scoreImportLines` is idempotent.
- regression: `node scripts/test-payslip-import.mjs` still **55/55**.
- live UI: a manual import created through `/payments/imports` rendered the
  recommendation (Strong match 99% → Excess Travel (Standby), signals Type 100% ·
  Date 97% · Reference 100%) with Confirm/Reject/Supersede; test data removed.

---

## 8. Deferred (unchanged from architecture § 8, roadmap O11)

- **Auto-confirm** for the ≥ 0.90 band (final thresholds with FRV — blocker #3).
- **Hours-first amount signal** beyond the re-normalization stand-in (needs a real
  hourly-rate accessor that does not exist in canonical data today — blocker #8).
- **Pay-cycle inference** (claim date → exact FRV cycle — blocker #4); currently a
  proximity decay.
- **Unrouted / re-pay candidates** (needs Step G `routeEntitlement` / O11).
- Real parsers (PDF/screenshot/AI) — the matcher is adapter-agnostic and unchanged
  by them (it scores the canonical line shape).
