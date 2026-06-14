-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0) — MIGRATION 08
-- Payment Records MVP — reconciliation service layer (Postgres RPCs)
--
-- Implements the atomic mutation primitives the Phase 3 reconciliation surface
-- needs. Supabase JS has no client-side multi-statement transaction, so every
-- helper that mutates claim_entitlements / entitlement_payment_links AND appends
-- a reconciliation_audit row MUST run as a single Postgres function so the
-- mutation and the audit commit together (invariant § 12.5 — atomic transitions).
-- This mirrors the existing fat.increment_claim_sequence pattern.
--
-- Spec: PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md (§ 3 hardening, § 4.3 tolerance,
-- § 7 Steps B–F), RECONCILIATION_STATE_ARCHITECTURE_v1.0.md § 5.5 (terminal
-- predicate), § 7 (audit contract), § 9 (helper contracts), § 12 (invariants).
--
-- Functions are SECURITY INVOKER so owner-only RLS on the canonical tables
-- (01_canonical_foundation.sql § 10) applies to the authenticated path; the
-- service_role batch path bypasses RLS as designed. search_path is pinned to
-- (fat, pg_temp) on every function.
--
-- Idempotent: CREATE OR REPLACE for functions; guarded DO blocks for the
-- additive constraints (Postgres has no ADD CONSTRAINT IF NOT EXISTS). Safe to
-- replay. ADDITIVE ONLY — no table redesign, no column changes.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── 1. Additive hardening (defence-in-depth; helpers already enforce these) ──
-- gross_amount >= 0, allocated_amount >= 0, and one status-eligible link per
-- (entitlement, record, kind). discrepancy_note is intentionally excluded from
-- the unique index (an operator may record several). Constraints added NOT VALID
-- then validated (the payment tables are empty in DEV, so validation is instant).

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_records_gross_amount_nonneg') then
    alter table fat.payment_records
      add constraint payment_records_gross_amount_nonneg check (gross_amount >= 0) not valid;
    alter table fat.payment_records validate constraint payment_records_gross_amount_nonneg;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'epl_allocated_amount_nonneg') then
    alter table fat.entitlement_payment_links
      add constraint epl_allocated_amount_nonneg check (allocated_amount >= 0) not valid;
    alter table fat.entitlement_payment_links validate constraint epl_allocated_amount_nonneg;
  end if;
end$$;

create unique index if not exists uq_epl_entitlement_record_kind
  on fat.entitlement_payment_links (entitlement_id, payment_record_id, link_kind)
  where link_kind in ('auto_match','manual');


-- ─── 2. Internal status recomputer (mutation only — caller owns the audit) ────
-- The single source of truth for terminal-state determination (§ 5.5). Reads the
-- entitlement + its status-eligible links, applies the per-unit predicate, and
-- writes claim_entitlements.payment_status if it changed. Returns the transition
-- so the calling RPC can append exactly one audit row with the right action
-- (§ 9.6 — the recomputer never double-writes audit).
--
-- The JS mirror is lib/fat/models/reconciliationHelpers.js → recomputeStoredStatus;
-- the two MUST stay decision-equivalent.

create or replace function fat._reconc_recompute(
  p_entitlement_id uuid,
  p_tolerance      numeric default 0.01
) returns table (changed boolean, prior_status text, new_status text)
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  v_unit           text;
  v_method         text;
  v_prior          text;
  v_eff_amount     numeric;
  v_eligible_count integer;
  v_eligible_sum   numeric;
  v_is_terminal    boolean;
  v_target         text;
begin
  select e.unit, e.payment_method, e.payment_status,
         coalesce(e.edited_amount, e.generated_amount)
    into v_unit, v_method, v_prior, v_eff_amount
    from fat.claim_entitlements e
   where e.id = p_entitlement_id;
  if not found then
    raise exception 'recompute: entitlement % not found', p_entitlement_id using errcode = 'no_data_found';
  end if;

  -- Status-eligible aggregates: auto_match / manual only (§ 5.3).
  select count(*), coalesce(sum(l.allocated_amount), 0)
    into v_eligible_count, v_eligible_sum
    from fat.entitlement_payment_links l
   where l.entitlement_id = p_entitlement_id
     and l.link_kind in ('auto_match','manual');

  if v_method is null then
    -- Unrouted ⇒ no status (§ 2.3).
    v_target := null;
  else
    -- Terminal predicate branches on unit (§ 4.3 / § 5.5).
    if v_unit = 'hours' then
      v_is_terminal := v_eligible_count >= 1;
    elsif v_unit = 'dollars' then
      v_is_terminal := v_eff_amount is not null and v_eligible_sum >= (v_eff_amount - p_tolerance);
    else
      v_is_terminal := false;  -- km / unknown: never terminal (transitional)
    end if;

    if v_is_terminal then
      v_target := case v_method when 'payslip' then 'paid' when 'petty_cash' then 'claimed' end;
    else
      v_target := case v_method when 'payslip' then 'pending' when 'petty_cash' then 'outstanding' end;
    end if;
  end if;

  if v_target is distinct from v_prior then
    update fat.claim_entitlements set payment_status = v_target where id = p_entitlement_id;
    return query select true, v_prior, v_target;
  else
    return query select false, v_prior, v_prior;
  end if;
end;
$$;


-- ─── 3. Audit writer (append-only; § 7) ───────────────────────────────────────
create or replace function fat._reconc_write_audit(
  p_entitlement_id uuid,
  p_actor_id       uuid,
  p_action         text,
  p_prior          text,
  p_new            text,
  p_reason         text,
  p_automated      boolean
) returns uuid
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare v_id uuid;
begin
  insert into fat.reconciliation_audit
    (entitlement_id, actor_id, action, prior_status, new_status, reason, automated)
  values
    (p_entitlement_id, p_actor_id, p_action, p_prior, p_new, p_reason, coalesce(p_automated, false))
  returning id into v_id;
  return v_id;
end;
$$;


-- ─── 4. RPC: create payment record (§ 9.3) ────────────────────────────────────
-- Insert-only. Validates gross_amount >= 0 and the stream / source enums. Does
-- NOT create any links — an unmatched line is harmless (it sits in the
-- unallocated queue, § 8.4). No audit row (§ 7.3 — record INSERT is not audited).

create or replace function fat.create_payment_record(
  p_owner_id     uuid,
  p_stream       text,
  p_record_date  date,
  p_gross_amount numeric,
  p_source       text,
  p_reference    text  default null,
  p_raw_payload  jsonb default null
) returns fat.payment_records
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare v_row fat.payment_records;
begin
  if p_gross_amount is null or p_gross_amount < 0 then
    raise exception 'create_payment_record: gross_amount must be >= 0 (got %)', p_gross_amount using errcode = 'check_violation';
  end if;
  if p_stream not in ('payslip','petty_cash') then
    raise exception 'create_payment_record: invalid stream %', p_stream using errcode = 'check_violation';
  end if;
  if p_source not in ('manual','payslip_screenshot','payslip_pdf','petty_cash_export') then
    raise exception 'create_payment_record: invalid source %', p_source using errcode = 'check_violation';
  end if;

  insert into fat.payment_records (owner_id, stream, record_date, reference, gross_amount, raw_payload, source)
  values (p_owner_id, p_stream, p_record_date, p_reference, p_gross_amount, p_raw_payload, p_source)
  returning * into v_row;
  return v_row;
end;
$$;


-- ─── 5. RPC: link entitlement ↔ payment (§ 9.5 linkPayment) ───────────────────
-- One transaction: validate (owner / stream / allocation), insert the link,
-- recompute status (status-eligible kinds), append exactly one audit row.
-- discrepancy_note links are not status-eligible → no recompute, note_discrepancy
-- audit row, status unchanged.

create or replace function fat.link_entitlement_payment(
  p_entitlement_id    uuid,
  p_payment_record_id uuid,
  p_allocated_amount  numeric,
  p_link_kind         text,
  p_actor_id          uuid,
  p_note              text    default null,
  p_automated         boolean default false,
  p_tolerance         numeric default 0.01
) returns jsonb
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  v_ent_owner    uuid;
  v_ent_method   text;
  v_ent_status   text;
  v_rec_owner    uuid;
  v_rec_stream   text;
  v_gross        numeric;
  v_existing_sum numeric;
  v_link_id      uuid;
  v_changed      boolean;
  v_prior        text;
  v_new          text;
  v_action       text;
  v_audit_id     uuid;
begin
  if p_link_kind not in ('auto_match','manual','discrepancy_note') then
    raise exception 'link: invalid link_kind %', p_link_kind using errcode = 'check_violation';
  end if;
  if p_allocated_amount is null or p_allocated_amount < 0 then
    raise exception 'link: allocated_amount must be >= 0 (got %)', p_allocated_amount using errcode = 'check_violation';
  end if;

  select e.owner_id, e.payment_method, e.payment_status
    into v_ent_owner, v_ent_method, v_ent_status
    from fat.claim_entitlements e where e.id = p_entitlement_id;
  if not found then
    raise exception 'link: entitlement % not found', p_entitlement_id using errcode = 'no_data_found';
  end if;

  select r.owner_id, r.stream, r.gross_amount
    into v_rec_owner, v_rec_stream, v_gross
    from fat.payment_records r where r.id = p_payment_record_id;
  if not found then
    raise exception 'link: payment_record % not found', p_payment_record_id using errcode = 'no_data_found';
  end if;

  -- Owner coherence (§ 5.6 invariant 1; cross-owner links forbidden today).
  if v_ent_owner is distinct from v_rec_owner then
    raise exception 'link: owner mismatch (entitlement % vs record %)', v_ent_owner, v_rec_owner;
  end if;

  -- Allocation cap (§ 5.4): SUM(allocated_amount) over ALL links of this record ≤ gross.
  select coalesce(sum(l.allocated_amount), 0) into v_existing_sum
    from fat.entitlement_payment_links l where l.payment_record_id = p_payment_record_id;
  if v_existing_sum + p_allocated_amount > v_gross then
    raise exception 'link: allocation % + existing % exceeds record gross %', p_allocated_amount, v_existing_sum, v_gross using errcode = 'check_violation';
  end if;

  if p_link_kind in ('auto_match','manual') then
    -- Stream coherence (§ 5.6 invariant 2); refuse unrouted (§ 3.5).
    if v_ent_method is null then
      raise exception 'link: entitlement % is unrouted — route it before linking a payment', p_entitlement_id;
    end if;
    if v_ent_method is distinct from v_rec_stream then
      raise exception 'link: stream mismatch (entitlement % vs record %)', v_ent_method, v_rec_stream;
    end if;
  end if;

  insert into fat.entitlement_payment_links
    (entitlement_id, payment_record_id, allocated_amount, link_kind, note)
  values
    (p_entitlement_id, p_payment_record_id, p_allocated_amount, p_link_kind, p_note)
  returning id into v_link_id;

  if p_link_kind in ('auto_match','manual') then
    select changed, prior_status, new_status into v_changed, v_prior, v_new
      from fat._reconc_recompute(p_entitlement_id, p_tolerance);
    v_action := 'link_payment';
    v_audit_id := fat._reconc_write_audit(p_entitlement_id, p_actor_id, v_action, v_prior, v_new, p_note, coalesce(p_automated, false));
  else
    -- discrepancy_note: evidence-but-not-counted; status unchanged (§ 5.3, § 6).
    v_changed := false; v_prior := v_ent_status; v_new := v_ent_status;
    v_action := 'note_discrepancy';
    v_audit_id := fat._reconc_write_audit(p_entitlement_id, p_actor_id, v_action, v_prior, v_new, p_note, false);
  end if;

  return jsonb_build_object(
    'link_id',        v_link_id,
    'entitlement_id', p_entitlement_id,
    'action',         v_action,
    'status_changed', v_changed,
    'prior_status',   v_prior,
    'new_status',     v_new,
    'audit_id',       v_audit_id
  );
end;
$$;


-- ─── 6. RPC: unlink entitlement ↔ payment (§ 9.5 unlinkPayment) ───────────────
-- Hard-delete the link, recompute (status-eligible kinds), append one audit row.

create or replace function fat.unlink_entitlement_payment(
  p_link_id   uuid,
  p_actor_id  uuid,
  p_reason    text    default null,
  p_tolerance numeric default 0.01
) returns jsonb
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  v_entitlement_id uuid;
  v_link_kind      text;
  v_status         text;
  v_changed        boolean;
  v_prior          text;
  v_new            text;
  v_action         text;
  v_audit_id       uuid;
begin
  select l.entitlement_id, l.link_kind into v_entitlement_id, v_link_kind
    from fat.entitlement_payment_links l where l.id = p_link_id;
  if not found then
    raise exception 'unlink: link % not found', p_link_id using errcode = 'no_data_found';
  end if;

  select e.payment_status into v_status from fat.claim_entitlements e where e.id = v_entitlement_id;

  delete from fat.entitlement_payment_links where id = p_link_id;

  if v_link_kind in ('auto_match','manual') then
    select changed, prior_status, new_status into v_changed, v_prior, v_new
      from fat._reconc_recompute(v_entitlement_id, p_tolerance);
    v_action := 'unlink_payment';
  else
    v_changed := false; v_prior := v_status; v_new := v_status;
    v_action := 'note_discrepancy';
  end if;

  v_audit_id := fat._reconc_write_audit(v_entitlement_id, p_actor_id, v_action, v_prior, v_new, p_reason, false);

  return jsonb_build_object(
    'link_id',        p_link_id,
    'entitlement_id', v_entitlement_id,
    'action',         v_action,
    'status_changed', v_changed,
    'prior_status',   v_prior,
    'new_status',     v_new,
    'audit_id',       v_audit_id
  );
end;
$$;


-- ─── 7. RPC: recompute status (§ 9.6) ─────────────────────────────────────────
-- Standalone recompute for the override-edit / manual paths and as a general
-- reconciliation primitive. Writes one audit row only when the status changes;
-- the action is mapped from the trigger (§ 9.6).

create or replace function fat.recompute_entitlement_status(
  p_entitlement_id uuid,
  p_actor_id       uuid,
  p_trigger        text    default 'manual',
  p_reason         text    default null,
  p_tolerance      numeric default 0.01
) returns jsonb
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  v_changed  boolean;
  v_prior    text;
  v_new      text;
  v_action   text;
  v_audit_id uuid;
begin
  select changed, prior_status, new_status into v_changed, v_prior, v_new
    from fat._reconc_recompute(p_entitlement_id, p_tolerance);

  if v_changed then
    if p_trigger = 'link_added' then
      v_action := 'link_payment';
    elsif p_trigger = 'link_removed' then
      v_action := 'unlink_payment';
    elsif v_new = 'paid' then
      v_action := 'mark_paid';
    elsif v_new = 'claimed' then
      v_action := 'mark_claimed';
    else
      v_action := 'regress_status';
    end if;

    v_audit_id := fat._reconc_write_audit(
      p_entitlement_id, p_actor_id, v_action, v_prior, v_new, p_reason,
      case when p_trigger in ('link_added','link_removed') then true else false end);
  end if;

  return jsonb_build_object(
    'entitlement_id', p_entitlement_id,
    'status_changed', coalesce(v_changed, false),
    'prior_status',   v_prior,
    'new_status',     v_new,
    'action',         v_action,
    'audit_id',       v_audit_id
  );
end;
$$;


-- ─── 8. Grants (mirror increment_claim_sequence: no public/anon) ──────────────

revoke all on function fat._reconc_recompute(uuid, numeric)                          from public, anon;
revoke all on function fat._reconc_write_audit(uuid, uuid, text, text, text, text, boolean) from public, anon;
revoke all on function fat.create_payment_record(uuid, text, date, numeric, text, text, jsonb) from public, anon;
revoke all on function fat.link_entitlement_payment(uuid, uuid, numeric, text, uuid, text, boolean, numeric) from public, anon;
revoke all on function fat.unlink_entitlement_payment(uuid, uuid, text, numeric)     from public, anon;
revoke all on function fat.recompute_entitlement_status(uuid, uuid, text, text, numeric) from public, anon;

grant execute on function fat._reconc_recompute(uuid, numeric)                          to authenticated, service_role;
grant execute on function fat._reconc_write_audit(uuid, uuid, text, text, text, text, boolean) to authenticated, service_role;
grant execute on function fat.create_payment_record(uuid, text, date, numeric, text, text, jsonb) to authenticated, service_role;
grant execute on function fat.link_entitlement_payment(uuid, uuid, numeric, text, uuid, text, boolean, numeric) to authenticated, service_role;
grant execute on function fat.unlink_entitlement_payment(uuid, uuid, text, numeric)     to authenticated, service_role;
grant execute on function fat.recompute_entitlement_status(uuid, uuid, text, text, numeric) to authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- END migration 08
-- ═══════════════════════════════════════════════════════════════════════════════
