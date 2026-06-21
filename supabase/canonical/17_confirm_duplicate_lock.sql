-- ─── 17. Close the duplicate-confirm race in confirm_payslip_import_line (P1-4) ─
-- The double-confirmation guard (§ 4, migration 12) probes for an already-confirmed
-- line with the same content_fingerprint, then mints a payment_record. Under
-- concurrency this is check-then-act: two confirms of identical content (re-typed /
-- re-uploaded payslip) could each see "no confirmed duplicate" and both mint a
-- record. A plain UNIQUE index cannot backstop it because the operator override
-- (p_allow_duplicate) legitimately creates a second confirmed line with the same
-- fingerprint.
--
-- Fix (smallest safe, override-preserving): take a TRANSACTION-scoped advisory lock
-- keyed on (owner_id, content_fingerprint) before the guard probe. Concurrent
-- confirms of the SAME content for the SAME owner now serialize — the second waits
-- for the first to COMMIT, then its probe sees the now-confirmed line and is blocked
-- (or proceeds iff the operator passed p_allow_duplicate). Confirms of different
-- content / different owners never contend. The lock auto-releases at commit/rollback.
--
-- Body is byte-identical to migration 12 except: (a) the pg_advisory_xact_lock call
-- added as the first statement inside the `v_line_fp is not null` guard block, and
-- (b) this comment block.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function fat.confirm_payslip_import_line(
  p_line_id          uuid,
  p_actor_id         uuid,
  p_entitlement_id   uuid    default null,   -- operator's final choice (may differ from candidate)
  p_link_kind        text    default null,   -- 'auto_match' | 'manual' | null (record only)
  p_allocated_amount numeric default null,   -- defaults to parsed_amount when linking
  p_tolerance        numeric default 0.01,
  p_allow_duplicate  boolean default false   -- operator override of the dup guard (§ 4)
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
  v_line_fp       text;
  -- duplicate guard
  v_dup_line      uuid;
  v_dup_rec       uuid;
  v_dup_import    uuid;
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
  select l.owner_id, l.status, l.import_id, l.parsed_amount, l.parsed_date,
         l.parsed_reference, l.parsed_description, l.raw_text, l.match_breakdown,
         l.payment_record_id, l.link_id, l.content_fingerprint
    into v_line_owner, v_line_status, v_import_id, v_parsed_amount, v_parsed_date,
         v_parsed_ref, v_parsed_desc, v_raw_text, v_match_break,
         v_existing_rec, v_existing_link, v_line_fp
    from fat.payslip_import_lines l
   where l.id = p_line_id;
  if not found then
    raise exception 'confirm_payslip_import_line: line % not found', p_line_id using errcode = 'no_data_found';
  end if;
  if v_line_owner is distinct from p_actor_id then
    raise exception 'confirm_payslip_import_line: actor % is not the line owner %', p_actor_id, v_line_owner;
  end if;

  -- ── Step 1: idempotency / terminal guard (§ 6.1 step 1, § 6.3) ──────────────
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

  -- ── Step 1.5: DOUBLE-CONFIRMATION GUARD (blocker #1b, § 4) ───────────────────
  -- Refuse to mint a SECOND payment_record for content that an already-confirmed
  -- line (a different line — re-typed/re-uploaded payslip) already settled. The
  -- match is on the SQL content fingerprint (owner-scoped), so it spans imports,
  -- which the per-line idempotency guard (step 1) deliberately does not. The
  -- operator can override explicitly (p_allow_duplicate) — detection warns, the
  -- operator decides (governance: manual override always available). NOTE: a
  -- record-only confirm that was later RETRACTED clears payment_record_id (line is
  -- on delete set null, § 6.5) so a re-confirm of corrected content is NOT blocked.
  if v_line_fp is not null then
    -- P1-4: serialize concurrent confirmations of identical content for this owner
    -- so the guard probe below cannot be raced. Transaction-scoped; released on
    -- commit/rollback. Keyed on owner+fingerprint, so unrelated confirms never block.
    perform pg_advisory_xact_lock(hashtextextended(v_line_owner::text || ':' || v_line_fp, 0));

    select l2.id, l2.payment_record_id, l2.import_id
      into v_dup_line, v_dup_rec, v_dup_import
      from fat.payslip_import_lines l2
     where l2.owner_id = v_line_owner
       and l2.id <> p_line_id
       and l2.status = 'confirmed'
       and l2.payment_record_id is not null
       and l2.content_fingerprint = v_line_fp
     order by l2.confirmed_at asc nulls last
     limit 1;
    if found and not p_allow_duplicate then
      raise exception
        'confirm_payslip_import_line: line % duplicates already-confirmed line % (payment record %) — set p_allow_duplicate to override',
        p_line_id, v_dup_line, v_dup_rec
        using errcode = 'unique_violation',
              detail = json_build_object(
                'reason',              'duplicate_confirmed_line',
                'duplicate_line_id',   v_dup_line,
                'duplicate_record_id', v_dup_rec,
                'duplicate_import_id', v_dup_import,
                'fingerprint',         v_line_fp
              )::text;
    end if;
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
  v_gross := coalesce(v_parsed_amount, 0);

  -- ── Step 3 (decided BEFORE the link call): link-eligibility pre-branch ───────
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
      v_do_link := false;
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
      'content_fingerprint', v_line_fp,
      'source',             v_import_source
    )
  );

  -- ── Step 3 (execute): link IFF the pre-branch said so (existing RPC) ────────
  if v_do_link then
    v_alloc := coalesce(p_allocated_amount, v_parsed_amount, 0);
    v_link_result := fat.link_entitlement_payment(
      p_entitlement_id,
      v_record.id,
      v_alloc,
      p_link_kind,
      p_actor_id,
      null,
      false,
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
    'open_lines_remaining', v_open_remaining,
    'duplicate_overridden', (p_allow_duplicate and v_dup_line is not null)
  );
end;
$$;

-- Grants (mirror migration 12: no public/anon).
revoke all on function fat.confirm_payslip_import_line(uuid, uuid, uuid, text, numeric, numeric, boolean) from public, anon;
grant execute on function fat.confirm_payslip_import_line(uuid, uuid, uuid, text, numeric, numeric, boolean) to authenticated, service_role;
