-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0) — MIGRATION 13
-- OCR Payslip Import — screenshot upload Storage bucket + owner-scoped RLS (Step O10-pre)
--
-- The first REAL ingestion source: payslip screenshots. This migration provisions
-- ONLY the storage substrate — a private bucket + owner-scoped RLS on
-- storage.objects (OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 3.3 "file bytes live in
-- Storage via file_ref, NOT Postgres"; blocker #2 "file storage + bucket RLS").
--
-- It does NOT implement OCR, AI, or PDF parsing (constraints). An uploaded screenshot
-- becomes a fat.payslip_imports row at status 'uploaded' with file_ref pointing here,
-- file_hash = the image sha256, and ZERO lines — it rests "file stored, not yet
-- parsed" (§ 4.1) until a future ScreenshotOcrAdapter (O10) re-parses the SAME stored
-- object. The fat.payslip_imports table is UNCHANGED — file_ref / file_hash already
-- exist (migration 10) and the source CHECK already permits 'payslip_screenshot'.
--
-- ADDITIVE ONLY — a new bucket + policies; no table/column change. Idempotent (upsert
-- the bucket; guarded DO blocks for policies — Postgres has no CREATE POLICY IF NOT
-- EXISTS). RLS is already enabled on storage.objects by Supabase (do NOT ALTER it).
-- Safe to replay. DEV only — PROD untouched.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── 1. Private bucket (§ 3.3 / blocker #2) ───────────────────────────────────
-- public=false: payslip images are PII, never publicly addressable — the Review UI
-- reads them via short-lived signed URLs (blocker #5 / retention is still deferred).
-- 15 MB ceiling covers a high-res phone screenshot; allowed_mime restricts to the
-- four requested formats (JPG + JPEG share image/jpeg).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payslip-screenshots',
  'payslip-screenshots',
  false,
  15728640,                                   -- 15 MiB
  array['image/png','image/jpeg','image/webp']
)
on conflict (id) do update
  set public            = excluded.public,
      file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ─── 2. Owner-scoped RLS on storage.objects (mirrors fat.* users_manage_own) ──
-- The object PATH is '<owner_id>/<sha256hex>.<ext>', so the first folder segment IS
-- the owner. Every policy pins bucket_id AND (storage.foldername(name))[1] =
-- auth.uid()::text — a user can only ever touch their own prefix. service_role
-- bypasses RLS (the future server-side parse/cleanup worker). Four verbs:
--   select — issue signed URLs / download / upsert precheck
--   insert — upload
--   update — upsert overwrite of identical bytes (idempotent re-upload)
--   delete — retract/reject cleanup
-- DROP-then-CREATE (not IF NOT EXISTS) so replay is BOTH safe AND convergent: if a
-- policy expression is ever corrected in this file, replaying re-applies it rather
-- than silently keeping the old (possibly weaker) definition — these are security
-- policies, so drift must not be possible (review finding). Matches the bucket's
-- on-conflict-do-update convergence above.

drop policy if exists payslip_screenshots_select_own on storage.objects;
create policy payslip_screenshots_select_own on storage.objects for select to authenticated
  using (bucket_id = 'payslip-screenshots'
         and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists payslip_screenshots_insert_own on storage.objects;
create policy payslip_screenshots_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'payslip-screenshots'
              and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists payslip_screenshots_update_own on storage.objects;
create policy payslip_screenshots_update_own on storage.objects for update to authenticated
  using (bucket_id = 'payslip-screenshots'
         and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'payslip-screenshots'
              and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists payslip_screenshots_delete_own on storage.objects;
create policy payslip_screenshots_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'payslip-screenshots'
         and (storage.foldername(name))[1] = (select auth.uid())::text);


-- ═══════════════════════════════════════════════════════════════════════════════
-- END migration 13
-- ═══════════════════════════════════════════════════════════════════════════════
