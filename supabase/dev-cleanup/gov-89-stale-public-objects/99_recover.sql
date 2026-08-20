-- ═══════════════════════════════════════════════════════════════════════════════
-- GOV-89 — REMOVE STALE FIRE ALLOWANCE PUBLIC-SCHEMA OBJECTS (DEV)
-- Step 99: RECOVERY / ROLLBACK
--
-- Reverses 01_drop_stale_public_objects.sql by rebuilding all five relations —
-- columns, defaults, nullability, checks, primary keys, unique constraints,
-- indexes, RLS and policies — and replaying the exact rows that were live in
-- DEV (kctctvpobbizhkiqkgqw) at the moment of the drop.
--
-- WHY THE RECOVERY DATA LIVES IN THIS FILE RATHER THAN IN A BACKUP TABLE
-- GOV-89 forbids altering fat.*, mica.*, auth.*, public.profiles or any
-- unrelated public object. Creating a backup table would mean writing new
-- objects into a protected schema. The captured content is four rows in total,
-- so the repository itself is the recovery medium: this file is complete and
-- self-contained, needs no surviving database state, and can be replayed into
-- an empty public schema.
--
-- CAPTURED STATE (verified immediately before the drop)
--   public.allowance_breakdowns   0 rows
--   public.audit_logs             1 row
--   public.calculation_snapshots  1 row
--   public.engine_versions        1 row
--   public.shifts                 1 row
--
-- BUILD ORDER is the exact inverse of the drop order: parents before children.
--
-- ENUM TYPES: 01 deliberately left public.allowance_line_type,
-- public.audit_action, public.ingestion_source and public.shift_status in place,
-- so recovery normally reuses them. The guarded CREATE TYPE blocks below exist
-- only for the case where a later, separate Issue has removed them.
--
-- GRANTS: the five tables carried nothing but Supabase's standard public-schema
-- default privileges (anon / authenticated / service_role / postgres). Recreating
-- them in `public` re-applies those defaults automatically, so no explicit GRANT
-- is replayed here. RLS is what actually constrained access, and it is restored
-- in full below.
--
-- DEV ONLY. Do not run against PRODUCTION.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── Guard: refuse to recover over a live drop set ───────────────────────────
DO $guard$
DECLARE v_present text;
BEGIN
  SELECT string_agg(format('public.%I', c.relname), ', ' ORDER BY c.relname) INTO v_present
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts');
  IF v_present IS NOT NULL THEN
    RAISE EXCEPTION 'GOV-89 recovery abort: these relations already exist: %. Drop them first or you will not get a clean restore.', v_present;
  END IF;
END
$guard$;


-- ─── 0. Enum types (only created if a later Issue removed them) ──────────────
DO $t$ BEGIN
  CREATE TYPE public.allowance_line_type AS ENUM
    ('ordinary','saturday','sunday','public_holiday','overtime_1_5x','overtime_2x',
     'on_call','non_rostered_on_call','call_out','ph_call_out','call_back',
     'fbt_draft','fbt_submitted');
EXCEPTION WHEN duplicate_object THEN NULL; END $t$;

DO $t$ BEGIN
  CREATE TYPE public.audit_action AS ENUM
    ('shift_created','shift_updated','shift_archived','snapshot_created',
     'breakdown_written','export_generated','import_completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $t$;

DO $t$ BEGIN
  CREATE TYPE public.ingestion_source AS ENUM
    ('manual','ocr_upload','etcs_parse','ai_draft','batch_import','system');
EXCEPTION WHEN duplicate_object THEN NULL; END $t$;

DO $t$ BEGIN
  CREATE TYPE public.shift_status AS ENUM ('draft','confirmed','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $t$;


-- ─── 1. public.engine_versions (no dependencies) ─────────────────────────────
CREATE TABLE public.engine_versions (
  version        text        NOT NULL,
  description    text        NOT NULL,
  eba_reference  text,
  effective_from date        NOT NULL,
  effective_to   date,
  released_at    timestamptz NOT NULL DEFAULT now(),
  is_current     boolean     NOT NULL DEFAULT false,
  CONSTRAINT engine_versions_pkey PRIMARY KEY (version)
);
CREATE UNIQUE INDEX engine_versions_one_current_idx
  ON public.engine_versions USING btree (is_current) WHERE (is_current = true);

ALTER TABLE public.engine_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY engine_versions_authenticated_select ON public.engine_versions FOR SELECT USING (true);
CREATE POLICY engine_versions_authenticated_insert ON public.engine_versions FOR INSERT WITH CHECK (true);


-- ─── 2. public.shifts (-> auth.users) ────────────────────────────────────────
CREATE TABLE public.shifts (
  id                       uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id                  uuid,
  status                   public.shift_status      NOT NULL DEFAULT 'draft'::public.shift_status,
  ingestion_source         public.ingestion_source  NOT NULL DEFAULT 'manual'::public.ingestion_source,
  start_time               timestamptz NOT NULL,
  planned_finish           timestamptz NOT NULL,
  actual_finish            timestamptz NOT NULL,
  salary_class_code        text        NOT NULL,
  base_hourly_rate_cents   integer     NOT NULL,
  casual_loaded_rate_cents integer     NOT NULL,
  public_holiday_dates     text[]      NOT NULL DEFAULT '{}'::text[],
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shifts_pkey PRIMARY KEY (id),
  CONSTRAINT shifts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT shifts_base_hourly_rate_cents_check   CHECK ((base_hourly_rate_cents >= 0)),
  CONSTRAINT shifts_casual_loaded_rate_cents_check CHECK ((casual_loaded_rate_cents >= 0)),
  CONSTRAINT shifts_planned_finish_after_start     CHECK ((planned_finish >= start_time)),
  CONSTRAINT shifts_actual_finish_after_start      CHECK ((actual_finish  >= start_time))
);
CREATE INDEX shifts_start_time_idx         ON public.shifts USING btree (start_time DESC);
CREATE INDEX shifts_status_idx             ON public.shifts USING btree (status);
CREATE INDEX shifts_user_id_idx            ON public.shifts USING btree (user_id);
CREATE INDEX shifts_user_id_start_time_idx ON public.shifts USING btree (user_id, start_time DESC);

ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY shifts_authenticated_select_own ON public.shifts FOR SELECT USING ((auth.uid() = user_id));
CREATE POLICY shifts_authenticated_insert_own ON public.shifts FOR INSERT WITH CHECK ((auth.uid() = user_id));
CREATE POLICY shifts_authenticated_update_own ON public.shifts FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


-- ─── 3. public.calculation_snapshots (-> shifts, engine_versions, auth.users) ─
CREATE TABLE public.calculation_snapshots (
  id                         uuid        NOT NULL DEFAULT gen_random_uuid(),
  shift_id                   uuid        NOT NULL,
  user_id                    uuid,
  engine_version             text        NOT NULL,
  calculated_at              timestamptz NOT NULL DEFAULT now(),
  raw_input_snapshot         jsonb       NOT NULL,
  calculated_output_snapshot jsonb       NOT NULL,
  ingestion_source           public.ingestion_source NOT NULL DEFAULT 'manual'::public.ingestion_source,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calculation_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT calculation_snapshots_shift_id_fkey       FOREIGN KEY (shift_id)       REFERENCES public.shifts(id) ON DELETE RESTRICT,
  CONSTRAINT calculation_snapshots_engine_version_fkey FOREIGN KEY (engine_version) REFERENCES public.engine_versions(version),
  CONSTRAINT calculation_snapshots_user_id_fkey        FOREIGN KEY (user_id)        REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX calculation_snapshots_calculated_at_idx            ON public.calculation_snapshots USING btree (calculated_at DESC);
CREATE INDEX calculation_snapshots_engine_version_idx           ON public.calculation_snapshots USING btree (engine_version);
CREATE INDEX calculation_snapshots_shift_id_idx                 ON public.calculation_snapshots USING btree (shift_id);
CREATE INDEX calculation_snapshots_shift_id_calculated_at_idx   ON public.calculation_snapshots USING btree (shift_id, calculated_at DESC);
CREATE INDEX calculation_snapshots_user_id_idx                  ON public.calculation_snapshots USING btree (user_id);
CREATE INDEX calculation_snapshots_user_id_calculated_at_idx    ON public.calculation_snapshots USING btree (user_id, calculated_at DESC);

ALTER TABLE public.calculation_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY calculation_snapshots_authenticated_select_own ON public.calculation_snapshots FOR SELECT USING ((auth.uid() = user_id));
CREATE POLICY calculation_snapshots_authenticated_insert_own ON public.calculation_snapshots FOR INSERT WITH CHECK ((auth.uid() = user_id));


-- ─── 4. public.audit_logs (-> auth.users) ────────────────────────────────────
CREATE TABLE public.audit_logs (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id          uuid,
  action           public.audit_action     NOT NULL,
  entity_type      text        NOT NULL,
  entity_id        text        NOT NULL,
  ingestion_source public.ingestion_source NOT NULL DEFAULT 'system'::public.ingestion_source,
  payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_pkey PRIMARY KEY (id),
  CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX audit_logs_action_idx                            ON public.audit_logs USING btree (action);
CREATE INDEX audit_logs_created_at_idx                        ON public.audit_logs USING btree (created_at DESC);
CREATE INDEX audit_logs_entity_type_entity_id_idx             ON public.audit_logs USING btree (entity_type, entity_id);
CREATE INDEX audit_logs_entity_type_entity_id_created_at_idx  ON public.audit_logs USING btree (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_user_id_idx                           ON public.audit_logs USING btree (user_id);
CREATE INDEX audit_logs_user_id_created_at_idx                ON public.audit_logs USING btree (user_id, created_at DESC);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_authenticated_select_own ON public.audit_logs FOR SELECT USING ((auth.uid() = user_id));
CREATE POLICY audit_logs_authenticated_insert     ON public.audit_logs FOR INSERT WITH CHECK (true);


-- ─── 5. public.allowance_breakdowns (-> snapshots, shifts, auth.users) ───────
CREATE TABLE public.allowance_breakdowns (
  id            uuid          NOT NULL DEFAULT gen_random_uuid(),
  snapshot_id   uuid          NOT NULL,
  shift_id      uuid          NOT NULL,
  user_id       uuid,
  line_type     public.allowance_line_type NOT NULL,
  label         text          NOT NULL,
  rounded_hours numeric(10,4) NOT NULL,
  multiplier    numeric(6,4)  NOT NULL,
  rate_cents    integer       NOT NULL,
  amount_cents  integer       NOT NULL,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT allowance_breakdowns_pkey PRIMARY KEY (id),
  CONSTRAINT allowance_breakdowns_snapshot_line_type_key UNIQUE (snapshot_id, line_type),
  CONSTRAINT allowance_breakdowns_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.calculation_snapshots(id) ON DELETE RESTRICT,
  CONSTRAINT allowance_breakdowns_shift_id_fkey    FOREIGN KEY (shift_id)    REFERENCES public.shifts(id) ON DELETE RESTRICT,
  CONSTRAINT allowance_breakdowns_user_id_fkey     FOREIGN KEY (user_id)     REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT allowance_breakdowns_rounded_hours_check CHECK ((rounded_hours >= (0)::numeric)),
  CONSTRAINT allowance_breakdowns_multiplier_check    CHECK ((multiplier    >= (0)::numeric)),
  CONSTRAINT allowance_breakdowns_rate_cents_check    CHECK ((rate_cents    >= 0)),
  CONSTRAINT allowance_breakdowns_amount_cents_check  CHECK ((amount_cents  >= 0))
);
CREATE INDEX allowance_breakdowns_line_type_idx           ON public.allowance_breakdowns USING btree (line_type);
CREATE INDEX allowance_breakdowns_shift_id_idx            ON public.allowance_breakdowns USING btree (shift_id);
CREATE INDEX allowance_breakdowns_snapshot_id_idx         ON public.allowance_breakdowns USING btree (snapshot_id);
CREATE INDEX allowance_breakdowns_snapshot_line_type_idx  ON public.allowance_breakdowns USING btree (snapshot_id, line_type);
CREATE INDEX allowance_breakdowns_user_id_idx             ON public.allowance_breakdowns USING btree (user_id);

ALTER TABLE public.allowance_breakdowns ENABLE ROW LEVEL SECURITY;
CREATE POLICY allowance_breakdowns_authenticated_select_own ON public.allowance_breakdowns FOR SELECT USING ((auth.uid() = user_id));
CREATE POLICY allowance_breakdowns_authenticated_insert_own ON public.allowance_breakdowns FOR INSERT WITH CHECK ((auth.uid() = user_id));


-- ─── 6. Data replay — the exact rows captured before the drop ────────────────
-- The owning auth user is resolved defensively: every user_id column is
-- ON DELETE SET NULL, so if that account no longer exists in auth.users the
-- restore stores NULL rather than failing the FK. `_gov89_owner` is a TEMP
-- table and disappears with the session — nothing is left behind in any schema.
CREATE TEMP TABLE _gov89_owner AS
SELECT (SELECT id FROM auth.users WHERE id = '7c90ba30-2b55-4d45-8d97-d631bc0ca1e6'::uuid) AS uid;

INSERT INTO public.engine_versions
  (version, description, eba_reference, effective_from, effective_to, released_at, is_current)
VALUES
  ('1.0.0',
   'Initial engine: NSW Ambulance EAPA Grade 9, EBA 2024. Ordinary, Saturday, Sunday, PH, OT (1.5x/2x), call-out, on-call, FBT.',
   'NSW Ambulance EAPA Grade 9, EBA 2024',
   '2024-01-01'::date,
   NULL,
   '2026-05-12T12:29:22.604082+00:00'::timestamptz,
   true);

INSERT INTO public.shifts
  (id, user_id, status, ingestion_source, start_time, planned_finish, actual_finish,
   salary_class_code, base_hourly_rate_cents, casual_loaded_rate_cents,
   public_holiday_dates, notes, created_at, updated_at)
SELECT
  '670e5eab-eb3e-45cb-98c9-3d346b8976da'::uuid, o.uid,
  'confirmed'::public.shift_status, 'manual'::public.ingestion_source,
  '2026-05-12T14:56:38.781016+00:00'::timestamptz,
  '2026-05-12T22:56:38.781016+00:00'::timestamptz,
  '2026-05-12T22:56:38.781016+00:00'::timestamptz,
  'EAPA9', 4742, 4742, '{}'::text[], NULL,
  '2026-05-12T22:56:38.781016+00:00'::timestamptz,
  '2026-05-12T22:56:38.781016+00:00'::timestamptz
FROM _gov89_owner o;

INSERT INTO public.calculation_snapshots
  (id, shift_id, user_id, engine_version, calculated_at,
   raw_input_snapshot, calculated_output_snapshot, ingestion_source, created_at)
SELECT
  'a9ec5059-77b6-4c52-87be-dcc5ae645451'::uuid,
  '670e5eab-eb3e-45cb-98c9-3d346b8976da'::uuid, o.uid,
  '1.0.0', '2026-05-12T22:57:08.456894+00:00'::timestamptz,
  '{"shifts":[{"id":"test","startTime":"2026-05-12T06:00:00Z","actualFinish":"2026-05-12T14:00:00Z","plannedFinish":"2026-05-12T14:00:00Z"}],"callHours":[],"periodEnd":"2026-05-12","fbtEntries":[],"periodStart":"2026-05-12","salaryClassCode":"EAPA9","publicHolidayDates":[]}'::jsonb,
  '{"grandTotal":379.36,"fbtLineItems":[],"timeSegments":[],"callHourTotal":0,"fbtDraftTotal":0,"ordinaryTotal":379.36,"baseHourlyRate":47.42,"salaryClassCode":"EAPA9","casualLoadedRate":47.42,"callHourLineItems":[],"fbtSubmittedTotal":0,"ordinaryLineItems":[{"label":"Ordinary Hours (timer)","amount":379.36,"dayType":"weekday","multiplier":1,"isExtension":false,"roundedHours":8,"baseRatePerHour":47.42}],"validationMessages":[]}'::jsonb,
  'manual'::public.ingestion_source,
  '2026-05-12T22:57:08.456894+00:00'::timestamptz
FROM _gov89_owner o;

INSERT INTO public.audit_logs
  (id, user_id, action, entity_type, entity_id, ingestion_source, payload, created_at)
SELECT
  '0f18cbc6-d98d-46eb-9f8c-5f17f52c073d'::uuid, o.uid,
  'shift_created'::public.audit_action, 'shifts',
  '670e5eab-eb3e-45cb-98c9-3d346b8976da',
  'manual'::public.ingestion_source,
  '{"note":"append-only test","source":"m7_t3_sql_validation"}'::jsonb,
  '2026-05-12T22:57:40.796734+00:00'::timestamptz
FROM _gov89_owner o;

-- public.allowance_breakdowns was empty at capture time — nothing to replay.

DROP TABLE IF EXISTS _gov89_owner;


-- ─── 7. Verify the restore ───────────────────────────────────────────────────
DO $verify$
DECLARE v_missing text; v_n integer;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO v_missing
  FROM unnest(ARRAY['allowance_breakdowns','audit_logs','calculation_snapshots','engine_versions','shifts']) t
  WHERE to_regclass('public.' || t) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'GOV-89 recovery abort: relation(s) not restored: %', v_missing;
  END IF;

  SELECT count(*) INTO v_n FROM public.engine_versions;
  IF v_n <> 1 THEN RAISE EXCEPTION 'GOV-89 recovery abort: engine_versions has % rows, expected 1.', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.shifts;
  IF v_n <> 1 THEN RAISE EXCEPTION 'GOV-89 recovery abort: shifts has % rows, expected 1.', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.calculation_snapshots;
  IF v_n <> 1 THEN RAISE EXCEPTION 'GOV-89 recovery abort: calculation_snapshots has % rows, expected 1.', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.audit_logs;
  IF v_n <> 1 THEN RAISE EXCEPTION 'GOV-89 recovery abort: audit_logs has % rows, expected 1.', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.allowance_breakdowns;
  IF v_n <> 0 THEN RAISE EXCEPTION 'GOV-89 recovery abort: allowance_breakdowns has % rows, expected 0.', v_n; END IF;

  RAISE NOTICE 'GOV-89 recovery: all 5 relations restored with their captured rows.';
END
$verify$;

COMMIT;
