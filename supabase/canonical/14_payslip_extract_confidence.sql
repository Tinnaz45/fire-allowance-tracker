-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0) — MIGRATION 14
-- OCR Payslip Import — extraction confidence framework (Step X6 / O10-framework)
--
-- Adds the EXTRACTION-confidence surface to staged lines. This is the OCR analogue
-- of, but strictly SEPARATE from, match confidence:
--
--   · match_confidence / match_breakdown (migration 10) answer
--       "WHICH entitlement does this line settle?"  (the matcher, payslipMatcher.js)
--   · extract_confidence / extract_meta (THIS migration) answer
--       "did OCR read this line CORRECTLY?"          (the OCR adapter)
--
-- The two MUST never bleed into each other: the matcher reads only the parsed_*
-- fields and never selects extract_confidence (OCR_EXTRACTION_MVP_v1.0.md § 8 —
-- "the matcher must never see extraction confidence as input"). Keeping extraction
-- confidence in its own columns makes that separation structural, not conventional.
--
--   extract_confidence : numeric(5,4) in [0,1] — the adapter's self-reported
--                        per-line confidence, floored by deterministic sanity
--                        checks (amount parses, date parses, required fields set).
--                        Bands (OCR_EXTRACTION_MVP § 8.2, mirrored in
--                        lib/fat/models/payslipImport.js EXTRACT_CONFIDENCE):
--                          ≥ 0.85 high · 0.50–0.85 medium · < 0.50 low.
--                        Display + attention-routing ONLY — it NEVER auto-confirms
--                        and NEVER feeds the match score (constraint: human review
--                        stays mandatory on every line).
--   extract_meta       : jsonb — the per-field confidences, the verbatim model
--                        text, the adapter identity, and any auxiliary fields the
--                        parser surfaced (e.g. a stub's payment_stream hint) that
--                        have no canonical column. Disposable workspace data
--                        (§ 3.3) — audit/UI only, never canonical state.
--
-- ADDITIVE ONLY — two nullable columns, no change to any existing column, no data
-- backfill. Idempotent (ADD COLUMN IF NOT EXISTS). Safe to replay. DEV only —
-- PROD untouched.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── 1. Extraction-confidence columns (§ 8.1) ─────────────────────────────────

alter table fat.payslip_import_lines
  add column if not exists extract_confidence numeric(5,4),
  add column if not exists extract_meta       jsonb;

comment on column fat.payslip_import_lines.extract_confidence is
  'OCR extraction confidence in [0,1] — "did OCR read this line correctly?". '
  'SEPARATE from match_confidence; never feeds the matcher (OCR_EXTRACTION_MVP_v1.0.md § 8). '
  'Display + attention-routing only; never auto-confirms.';
comment on column fat.payslip_import_lines.extract_meta is
  'OCR extraction metadata: per-field confidences, verbatim model text, adapter '
  'identity, and auxiliary parser fields without a canonical column (e.g. a '
  'payment_stream hint). Disposable workspace data (§ 3.3).';


-- ═══════════════════════════════════════════════════════════════════════════════
-- END migration 14
-- ═══════════════════════════════════════════════════════════════════════════════
