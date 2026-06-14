-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRE ALLOWANCE TRACKER — CANONICAL FOUNDATION (v1.0) — MIGRATION 09
-- Reconciliation layer completion — retractPayment + routeEntitlement RPCs
--
-- Closes the two remaining cross-layer dependencies the OCR Payslip Import
-- architecture identified (OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md § 6.4 routing,
-- § 6.5 reverse bridge; PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md § 7 Steps F + G):
--
--   • fat.retract_payment   — § 9.4 retractPayment. Hard-delete a payment_records
--                             row (cascade its links), then recompute + audit each
--                             formerly-linked entitlement (one unlink_payment row
--                             per DISTINCT entitlement). The reverse of
--                             create_payment_record (§ 9.3).
--   • fat.route_entitlement — § 9.1 routeEntitlement. The ONLY path from
--                             payment_method NULL → a stream. Sets the stream's
--                             initial status and appends one set_payment_method
--                             audit row. Refuses already-routed entitlements
--                             (re-routing is a separate, explicit action § 9.4).
--
-- Both compose the migration-08 internals (_reconc_recompute, _reconc_write_audit)
-- verbatim — NO new reconciliation semantics, NO audit actions beyond the closed
-- § 7.2 enum (set_payment_method, unlink_payment already exist). The atomic-mutation
-- rule (§ 7.4, invariant § 12.5) holds: each helper's mutation(s) + audit row(s)
-- commit in a single Postgres function transaction.
--
-- Functions are SECURITY INVOKER with search_path pinned to (fat, pg_temp), exactly
-- like migration 08, so owner-only RLS (01_canonical_foundation.sql § 10) guards the
-- authenticated path and the service_role batch path bypasses RLS as designed.
--
-- Idempotent (CREATE OR REPLACE). ADDITIVE ONLY — no table/column/constraint change.
-- DEV only.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── 1. RPC: route an unrouted entitlement (§ 9.1 routeEntitlement) ───────────
-- payment_method NULL → 'payslip' | 'petty_cash'. This is the ONLY path from NULL
-- to a stream (§ 3.3); routing is never inferred (§ 3.5). Sets the stream's initial
-- status ('pending' / 'outstanding') and appends one set_payment_method audit row
-- with prior_status = null. Refuses an already-routed entitlement so re-routing
-- (§ 3.4) stays an explicit, separate operator action.

create or replace function fat.route_entitlement(
  p_entitlement_id uuid,
  p_stream         text,
  p_actor_id       uuid,
  p_reason         text default null
) returns jsonb
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  v_owner    uuid;
  v_method   text;
  v_initial  text;
  v_audit_id uuid;
begin
  if p_stream not in ('payslip','petty_cash') then
    raise exception 'route_entitlement: invalid stream %', p_stream using errcode = 'check_violation';
  end if;

  select e.owner_id, e.payment_method
    into v_owner, v_method
    from fat.claim_entitlements e
   where e.id = p_entitlement_id;
  if not found then
    raise exception 'route_entitlement: entitlement % not found', p_entitlement_id using errcode = 'no_data_found';
  end if;

  -- Only NULL → stream here (§ 3.3). An already-routed entitlement must use an
  -- explicit re-route action (§ 3.4) — refuse so routing changes never happen by
  -- accident through the wrong helper.
  if v_method is not null then
    raise exception 'route_entitlement: entitlement % already routed to % (use a re-route action)', p_entitlement_id, v_method using errcode = 'check_violation';
  end if;

  v_initial := case p_stream when 'payslip' then 'pending' when 'petty_cash' then 'outstanding' end;

  update fat.claim_entitlements
     set payment_method = p_stream,
         payment_status = v_initial
   where id = p_entitlement_id;

  v_audit_id := fat._reconc_write_audit(
    p_entitlement_id, p_actor_id, 'set_payment_method', null, v_initial, p_reason, false);

  return jsonb_build_object(
    'entitlement_id', p_entitlement_id,
    'action',         'set_payment_method',
    'status_changed', true,
    'prior_status',   null,
    'new_status',     v_initial,
    'payment_method', p_stream,
    'audit_id',       v_audit_id
  );
end;
$$;


-- ─── 2. RPC: retract a payment record (§ 9.4 retractPayment) ──────────────────
-- A record ingested in error (OCR misread, duplicate batch, wrong owner) is
-- hard-deleted (§ 4.3); the FK cascade removes every link row (§ 5.2). For each
-- DISTINCT formerly-linked entitlement the recomputer re-derives status from the
-- REMAINING links (partial coverage from other records may still hold it terminal —
-- the matcher does NOT auto-regress, § 4.3) and one unlink_payment audit row is
-- appended so each entitlement's per-row history reflects the loss of evidence.
-- An unallocated record (no links) is deleted with no recompute and no audit row.

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

  return jsonb_build_object(
    'payment_record_id',       p_payment_record_id,
    'entitlements_recomputed', v_recomputed,
    'audit_rows_written',      v_audits
  );
end;
$$;


-- ─── 3. Grants (mirror migration 08: no public/anon) ──────────────────────────

revoke all on function fat.route_entitlement(uuid, text, uuid, text)        from public, anon;
revoke all on function fat.retract_payment(uuid, uuid, text, numeric)       from public, anon;

grant execute on function fat.route_entitlement(uuid, text, uuid, text)     to authenticated, service_role;
grant execute on function fat.retract_payment(uuid, uuid, text, numeric)    to authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- END migration 09
-- ═══════════════════════════════════════════════════════════════════════════════
