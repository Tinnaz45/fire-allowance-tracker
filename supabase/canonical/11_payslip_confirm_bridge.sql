-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0) — MIGRATION 11
-- OCR Payslip Import — confirm bridge (Step O6 / the keystone)
--
-- The SINGLE seam where a staging line becomes canonical. One atomic RPC per line
-- (OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 6.1). It COMPOSES the migration-08
-- RPCs verbatim — fat.create_payment_record (always) and fat.link_entitlement_payment
-- (only when the operator chose a routed, stream-coherent entitlement) — so the
-- OCR layer adds ZERO new reconciliation semantics: it chooses which RPC to call
-- and what arguments to pass. The record-insert + link + recompute + audit commit
-- in ONE transaction (atomicity, invariant § 12.5 / § 7.4).
--
-- This is a PRODUCER-only write path (principle § 2.1): it never touches
-- claim_entitlements / entitlement_payment_links / reconciliation_audit directly —
-- the composed RPCs own those writes.
--
-- SECURITY INVOKER, search_path = (fat, pg_temp), exactly like migration 08/09, so
-- owner-only RLS guards the create_payment_record insert on the authenticated path
-- and the service_role batch path bypasses RLS as designed.
--
-- Idempotent (CREATE OR REPLACE). ADDITIVE ONLY — no table/column/constraint
-- change. DEV only.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── fat.confirm_payslip_import_line (§ 6.1) ──────────────────────────────────
-- p_entitlement_id / p_link_kind null  ⇒ record-only confirm (unallocated queue,
--                                        § 6.4 — the deliberate dead-end).
-- p_entitlement_id + p_link_kind set   ⇒ also link, IFF the entitlement is routed
--                                        to 'payslip' (stream-coherent). The link
--                                        decision is PRE-BRANCHED (not a caught
--                                        exception) so "create the record, leave it
--                                        unlinked" is achieved by NOT attempting the
--                                        link — never by swallowing link's
--                                        RAISE EXCEPTION (which would roll the record
--                                        back too, § 6.1 atomicity note).

create or replace function fat.confirm_payslip_import_line(
  p_line_id          uuid,
  p_actor_id         uuid,
  p_entitlement_id   uuid    default null,   -- operator's final choice (may differ from candidate)
  p_link_kind        text    default null,   -- 'auto_match' | 'manual' | null (record only)
  p_allocated_amount numeric default null,   -- defaults to parsed_amount when linking
  p_tolerance        numeric default 0.01
) returns jsonb
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  -- staging line
  v_line_owner    uuid;
  v_line_status   text;
  v_import_id     uuid;
  v_parsed_amount numeric;
  v_parsed_date   date;
  v_parsed_ref    text;
  v_parsed_desc   text;
  v_raw_text      text;
  v_match_break   jsonb;
  v_existing_rec  uuid;
  v_existing_link uuid;
  -- import
  v_import_source text;
  v_import_paydate date;
  v_rec_source    text;
  -- record date
  v_record_date   date;
  v_gross         numeric;
  -- chosen entitlement
  v_ent_method    text;
  v_do_link       boolean := false;
  v_alloc         numeric;
  -- outputs
  v_record        fat.payment_records;
  v_link_result   jsonb;
  v_link_id       uuid;
  v_open_remaining integer;
  v_import_status text;
begin
  -- ── Step 0: owner coherence (§ 6.1 step 0 — load-bearing) ───────────────────
  -- create_payment_record performs NO owner==actor check; for the record-only
  -- path the link RPC is never called, so THIS assertion is the sole owner guard.
  -- A service_role batch worker MUST pass p_actor_id = the authenticated batch
  -- owner (never a client-supplied owner_id on the line).
  select l.owner_id, l.status, l.import_id, l.parsed_amount, l.parsed_date,
         l.parsed_reference, l.parsed_description, l.raw_text, l.match_breakdown,
         l.payment_record_id, l.link_id
    into v_line_owner, v_line_status, v_import_id, v_parsed_amount, v_parsed_date,
         v_parsed_ref, v_parsed_desc, v_raw_text, v_match_break,
         v_existing_rec, v_existing_link
    from fat.payslip_import_lines l
   where l.id = p_line_id;
  if not found then
    raise exception 'confirm_payslip_import_line: line % not found', p_line_id using errcode = 'no_data_found';
  end if;
  if v_line_owner is distinct from p_actor_id then
    raise exception 'confirm_payslip_import_line: actor % is not the line owner %', p_actor_id, v_line_owner;
  end if;

  -- ── Step 1: idempotency / terminal guard (§ 6.1 step 1, § 6.3) ──────────────
  -- A confirmed line is idempotent — re-confirming returns the existing result
  -- (no second record). A rejected/superseded/failed line is not confirmable.
  if v_line_status = 'confirmed' and v_existing_rec is not null then
    select e.status into v_import_status from fat.payslip_imports e where e.id = v_import_id;
    return jsonb_build_object(
      'line_id',           p_line_id,
      'idempotent',        true,
      'payment_record_id', v_existing_rec,
      'link_id',           v_existing_link,
      'line_status',       'confirmed',
      'import_status',     v_import_status
    );
  end if;
  if v_line_status not in ('parsed','needs_review') then
    raise exception 'confirm_payslip_import_line: line % is %, only parsed/needs_review are confirmable', p_line_id, v_line_status using errcode = 'check_violation';
  end if;

  -- ── Source mapping + record date (§ 6.2) ────────────────────────────────────
  select e.source, e.pay_date into v_import_source, v_import_paydate
    from fat.payslip_imports e where e.id = v_import_id;
  v_rec_source := case v_import_source
                    when 'manual_entry'       then 'manual'
                    when 'payslip_screenshot' then 'payslip_screenshot'
                    when 'payslip_pdf'        then 'payslip_pdf'
                    else 'manual'
                  end;

  v_record_date := coalesce(v_parsed_date, v_import_paydate);
  if v_record_date is null then
    raise exception 'confirm_payslip_import_line: line % has no parsed_date and import has no pay_date', p_line_id using errcode = 'not_null_violation';
  end if;
  v_gross := coalesce(v_parsed_amount, 0);  -- hours-first lines may carry no dollar amount (§ 5.2)

  -- ── Step 3 (decided BEFORE the link call): link-eligibility pre-branch ───────
  -- Link only when the operator chose an entitlement AND a kind. The entitlement
  -- must be routed to 'payslip' (the record's stream). Unrouted ⇒ record-only
  -- dead-end (§ 6.4). Routed to the WRONG stream ⇒ operator error: refuse up front
  -- (abort before inserting anything) rather than silently drop the choice.
  if p_entitlement_id is not null and p_link_kind is not null then
    if p_link_kind not in ('auto_match','manual') then
      raise exception 'confirm_payslip_import_line: invalid link_kind % (auto_match|manual|null)', p_link_kind using errcode = 'check_violation';
    end if;
    select ce.payment_method into v_ent_method
      from fat.claim_entitlements ce where ce.id = p_entitlement_id;
    if not found then
      raise exception 'confirm_payslip_import_line: entitlement % not found', p_entitlement_id using errcode = 'no_data_found';
    end if;
    if v_ent_method = 'payslip' then
      v_do_link := true;
    elsif v_ent_method is null then
      v_do_link := false;  -- unrouted: deliberate record-only (§ 6.4); route+link later via /payments
    else
      raise exception 'confirm_payslip_import_line: entitlement % is routed to % — a payslip line cannot settle it', p_entitlement_id, v_ent_method using errcode = 'check_violation';
    end if;
  end if;

  -- ── Step 2: create the payment record (existing RPC, § 6.1 step 2) ──────────
  v_record := fat.create_payment_record(
    v_line_owner,
    'payslip',
    v_record_date,
    v_gross,
    v_rec_source,
    v_parsed_ref,
    jsonb_build_object(
      'import_id',          v_import_id,
      'line_id',            p_line_id,
      'raw_text',           v_raw_text,
      'parsed_reference',   v_parsed_ref,
      'parsed_description', v_parsed_desc,
      'parsed_amount',      v_parsed_amount,
      'parsed_date',        v_parsed_date,
      'match_breakdown',    v_match_break,
      'source',             v_import_source
    )
  );

  -- ── Step 3 (execute): link IFF the pre-branch said so (existing RPC) ────────
  -- link_entitlement_payment re-enforces owner + stream coherence, the allocation
  -- cap, recompute, and the audit row — the OCR layer adds nothing to that logic.
  -- A genuine link error the pre-branch can't predict (e.g. allocation over-cap)
  -- DOES abort the whole confirm — correct: the record shouldn't exist unlinked.
  if v_do_link then
    v_alloc := coalesce(p_allocated_amount, v_parsed_amount, 0);
    v_link_result := fat.link_entitlement_payment(
      p_entitlement_id,
      v_record.id,
      v_alloc,
      p_link_kind,
      p_actor_id,
      null,        -- note
      false,       -- automated (operator-confirmed)
      p_tolerance
    );
    v_link_id := (v_link_result ->> 'link_id')::uuid;
  end if;

  -- ── Step 4: stamp the line (§ 6.1 step 4) ───────────────────────────────────
  update fat.payslip_import_lines
     set status            = 'confirmed',
         payment_record_id = v_record.id,
         link_id           = v_link_id,
         confirmed_at      = now()
   where id = p_line_id;

  -- ── Step 5: recompute import status (§ 6.1 step 5 / § 4.1) ───────────────────
  -- The import reaches 'confirmed' only when no line is still open
  -- (parsed/needs_review/failed). Otherwise it rests at needs_review.
  select count(*) into v_open_remaining
    from fat.payslip_import_lines l
   where l.import_id = v_import_id
     and l.status in ('parsed','needs_review','failed');

  if v_open_remaining = 0 then
    update fat.payslip_imports
       set status = 'confirmed', confirmed_at = now()
     where id = v_import_id
    returning status into v_import_status;
  else
    update fat.payslip_imports
       set status = 'needs_review'
     where id = v_import_id
       and status not in ('confirmed','needs_review')
    returning status into v_import_status;
    if v_import_status is null then
      select status into v_import_status from fat.payslip_imports where id = v_import_id;
    end if;
  end if;

  return jsonb_build_object(
    'line_id',           p_line_id,
    'idempotent',        false,
    'payment_record_id', v_record.id,
    'link_id',           v_link_id,
    'linked',            v_do_link,
    'link_result',       v_link_result,
    'line_status',       'confirmed',
    'import_status',     v_import_status,
    'open_lines_remaining', v_open_remaining
  );
end;
$$;


-- ─── Grants (mirror migration 08/09: no public/anon) ──────────────────────────

revoke all on function fat.confirm_payslip_import_line(uuid, uuid, uuid, text, numeric, numeric) from public, anon;
grant execute on function fat.confirm_payslip_import_line(uuid, uuid, uuid, text, numeric, numeric) to authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- END migration 11
-- ═══════════════════════════════════════════════════════════════════════════════
