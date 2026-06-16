-- ─── 18. Make retract_payment leave a re-confirmable payslip line (P1-2) ──────
-- payslip_import_lines.payment_record_id / .link_id are ON DELETE SET NULL FKs.
-- When retract_payment hard-deletes a payment_record, the cascade clears those two
-- pointers but leaves the LINE at status='confirmed'. That state is unrecoverable:
-- confirm_payslip_import_line refuses anything not in (parsed, needs_review), so the
-- corrected content can never be re-confirmed — and the parent import stays
-- 'confirmed' while no longer backed by a record. (The duplicate guard's
-- payment_record_id-is-not-null filter already excludes such a line from BLOCKING
-- others; this fix completes the design by actually re-opening the line.)
--
-- Fix: in retract_payment, snapshot the payslip lines that referenced the record
-- BEFORE the delete, then after the cascade revert each to 'needs_review' (clearing
-- confirmed_at; payment_record_id/link_id were already nulled by the cascade) and
-- re-open any parent import that had gone 'confirmed'. This is additive and
-- payslip-specific: a non-payslip record (e.g. a directly-created petty-cash record)
-- has no referencing lines, so the new block is a no-op. The entitlement audit trail
-- (one unlink_payment row per formerly-linked entitlement) is unchanged.
--
-- Body is byte-identical to migration 09 except: (a) the v_line_ids declaration,
-- (b) the snapshot SELECT before the delete, (c) the re-open block after the loop,
-- and (d) this comment block.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function fat.retract_payment(
  p_payment_record_id uuid,
  p_actor_id          uuid,
  p_reason            text    default null,
  p_tolerance         numeric default 0.01
) returns jsonb
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  v_exists     boolean;
  v_ent_ids    uuid[];
  v_ent_id     uuid;
  v_changed    boolean;
  v_prior      text;
  v_new        text;
  v_recomputed integer := 0;
  v_audits     integer := 0;
  v_line_ids   uuid[];
  v_lines_reopened integer := 0;
begin
  -- Confirm the record is present (and visible under RLS) before mutating.
  select true into v_exists from fat.payment_records r where r.id = p_payment_record_id;
  if not found then
    raise exception 'retract_payment: payment_record % not found', p_payment_record_id using errcode = 'no_data_found';
  end if;

  -- Snapshot the DISTINCT formerly-linked entitlements BEFORE the cascade (§ 4.3).
  -- DISTINCT collapses an entitlement that holds several links to this record
  -- (e.g. an auto_match + a discrepancy_note) to a single recompute + audit row.
  select array_agg(distinct l.entitlement_id)
    into v_ent_ids
    from fat.entitlement_payment_links l
   where l.payment_record_id = p_payment_record_id;

  -- Snapshot the payslip staging lines this record settled, BEFORE the cascade nulls
  -- their payment_record_id (P1-2). The lines themselves are not deleted (FK is SET
  -- NULL), so their ids remain valid for the re-open below.
  select array_agg(l.id)
    into v_line_ids
    from fat.payslip_import_lines l
   where l.payment_record_id = p_payment_record_id;

  -- Hard-delete the record; the on-delete-cascade FK removes every link row.
  delete from fat.payment_records where id = p_payment_record_id;

  if v_ent_ids is not null then
    foreach v_ent_id in array v_ent_ids loop
      -- Recompute reads the REMAINING (post-cascade) links; its prior_status is the
      -- pre-cascade stored status, new_status the recomputed one. It writes the
      -- status only when it actually changed (§ 9.6).
      select changed, prior_status, new_status
        into v_changed, v_prior, v_new
        from fat._reconc_recompute(v_ent_id, p_tolerance);
      v_recomputed := v_recomputed + 1;

      -- One unlink_payment row per formerly-linked entitlement, regardless of
      -- whether status changed — the audit records the evidence loss (§ 4.3).
      -- automated = false: retraction is an operator-initiated action, matching
      -- the single-link unlink path (08 § 6).
      perform fat._reconc_write_audit(
        v_ent_id, p_actor_id, 'unlink_payment', v_prior, v_new, p_reason, false);
      v_audits := v_audits + 1;
    end loop;
  end if;

  -- ── P1-2: re-open the payslip lines this record had settled ─────────────────
  -- The cascade above already cleared payment_record_id + link_id (SET NULL) but
  -- left status='confirmed'. Revert each such line to 'needs_review' so the operator
  -- can re-confirm corrected content, and re-open any parent import that had gone
  -- 'confirmed' (it now holds an open line again).
  if v_line_ids is not null then
    update fat.payslip_import_lines
       set status = 'needs_review', confirmed_at = null
     where id = any(v_line_ids)
       and status = 'confirmed';
    get diagnostics v_lines_reopened = row_count;

    update fat.payslip_imports i
       set status = 'needs_review'
     where i.status = 'confirmed'
       and i.id in (
         select distinct l.import_id
           from fat.payslip_import_lines l
          where l.id = any(v_line_ids)
       );
  end if;

  return jsonb_build_object(
    'payment_record_id',       p_payment_record_id,
    'entitlements_recomputed', v_recomputed,
    'audit_rows_written',      v_audits,
    'lines_reopened',          v_lines_reopened
  );
end;
$$;

revoke all on function fat.retract_payment(uuid, uuid, text, numeric) from public, anon;
grant execute on function fat.retract_payment(uuid, uuid, text, numeric) to authenticated, service_role;
