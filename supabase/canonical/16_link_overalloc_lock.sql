-- ─── 16. Close the over-allocation race in link_entitlement_payment (P1-3) ────
-- The allocation cap (§ 5.4) reads SUM(allocated_amount) over the record's links,
-- then INSERTs a new link. Under concurrency this is check-then-act: two links
-- against the SAME payment_record could each pass the cap check and jointly
-- over-allocate past gross_amount (the uq_epl_entitlement_record_kind unique index
-- does NOT prevent this — it only blocks a duplicate (entitlement,record,kind)).
--
-- Fix (smallest safe): take a row-level lock on the payment_records row (SELECT …
-- FOR UPDATE) before reading the existing sum. Concurrent links to the same record
-- now serialize — the second waits for the first to COMMIT, then re-reads the sum
-- INCLUDING the first's link and correctly rejects an over-allocation. Links to
-- DIFFERENT records never contend. No signature/return change; behaviour is
-- identical for sequential callers (the MVP's single-operator path).
--
-- Body is byte-identical to migration 08 except: (a) the payment_records SELECT
-- now ends in `for update`, (b) this comment block.
-- ─────────────────────────────────────────────────────────────────────────────

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

  -- Lock the payment_records row FIRST (P1-3): serializes concurrent links to the
  -- same record so the allocation-cap check below cannot be raced. Also fetches the
  -- record fields. A row that does not exist returns no row → handled below.
  select r.owner_id, r.stream, r.gross_amount
    into v_rec_owner, v_rec_stream, v_gross
    from fat.payment_records r where r.id = p_payment_record_id
    for update;
  if not found then
    raise exception 'link: payment_record % not found', p_payment_record_id using errcode = 'no_data_found';
  end if;

  -- Owner coherence (§ 5.6 invariant 1; cross-owner links forbidden today).
  if v_ent_owner is distinct from v_rec_owner then
    raise exception 'link: owner mismatch (entitlement % vs record %)', v_ent_owner, v_rec_owner;
  end if;

  -- Allocation cap (§ 5.4): SUM(allocated_amount) over ALL links of this record ≤ gross.
  -- Read under the row lock above, so a concurrent link is already serialized here.
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

revoke all on function fat.link_entitlement_payment(uuid, uuid, numeric, text, uuid, text, boolean, numeric) from public, anon;
grant execute on function fat.link_entitlement_payment(uuid, uuid, numeric, text, uuid, text, boolean, numeric) to authenticated, service_role;
