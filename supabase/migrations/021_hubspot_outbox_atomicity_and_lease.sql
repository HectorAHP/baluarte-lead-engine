-- Fase 7C.1 -- closes two real gaps found in the Fase 7C review of migration 020. Does NOT modify
-- 020 itself (its table/RPC keep their original definitions on disk as history) -- this migration
-- only adds new objects and REPLACES the one RPC whose signature needed to change.

-- --------------------------------------------------------------------------------------------
-- GAP 1: fiscal_lead_scores and hubspot_sync_outbox were written via TWO INDEPENDENT Supabase
-- calls (application/web-lead-capture.ts), each its own implicit PostgREST transaction. The Fase
-- 7C report called this a "transactional outbox" -- that was IMPRECISE. A crash or network failure
-- between the two calls could (and, per the reconciliation scanner's own design, sometimes does)
-- leave a fiscal_lead_scores row with NO corresponding hubspot_sync_outbox row --
-- MISSING_OUTBOX_PARTIAL_DATA_ONLY in HubSpotOutboxReconciliationService's own vocabulary.
--
-- This function makes the two writes ATOMIC (one Postgres transaction, not two HTTP round-trips)
-- for every NEW submission going forward. It does NOT extend to the lead create/update itself --
-- see the Fase 7C.1 report for why that boundary was deliberately kept where it is (the lead
-- write already has its own robust idempotency via processed_events + email/phone dedupe, and its
-- failure mode is a clean, retryable request failure, never a silent gap).
--
-- p_outbox_payload = NULL means "do not schedule outbox delivery at all" (the inline-sync,
-- HUBSPOT_OUTBOX_ENABLED=false path never calls this function in the first place, but the NULL
-- case is handled defensively regardless).
create or replace function create_fiscal_score_with_outbox(
  p_lead_id uuid,
  p_submission_id text,
  p_score integer,
  p_score_class text,
  p_version text,
  p_reasons jsonb,
  p_monthly_income_band text,
  p_annual_contribution_band text,
  p_has_ppr boolean,
  p_files_annual_return boolean,
  p_outbox_payload jsonb,
  p_contact_email text,
  p_contact_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fiscal_score_id uuid;
  v_outbox_id uuid;
begin
  insert into fiscal_lead_scores (
    lead_id, submission_id, score, score_class, version, reasons,
    monthly_income_band, annual_contribution_band, has_ppr, files_annual_return
  ) values (
    p_lead_id, p_submission_id, p_score, p_score_class, p_version, p_reasons,
    p_monthly_income_band, p_annual_contribution_band, p_has_ppr, p_files_annual_return
  )
  on conflict (lead_id, submission_id) do nothing
  returning id into v_fiscal_score_id;

  -- Only ever scheduled when THIS call actually won the fiscal-score insert (a genuine new
  -- submission, never an idempotent replay of an already-scored one) -- mirrors
  -- WebLeadCaptureService.scoreFiscalCalculatorSubmission's pre-existing `if (persisted)` guard,
  -- just inside the same transaction now instead of a second, separate call.
  if v_fiscal_score_id is not null and p_outbox_payload is not null then
    insert into hubspot_sync_outbox (lead_id, submission_id, contact_email, contact_phone, payload)
    values (p_lead_id, p_submission_id, p_contact_email, p_contact_phone, p_outbox_payload)
    on conflict (lead_id, submission_id) do nothing
    returning id into v_outbox_id;
  end if;

  return jsonb_build_object(
    'fiscalScoreCreated', v_fiscal_score_id is not null,
    'fiscalScoreId', v_fiscal_score_id,
    'outboxCreated', v_outbox_id is not null,
    'outboxId', v_outbox_id
  );
end;
$$;

-- Same lockdown rationale as every SECURITY DEFINER function in this project (migrations 012, 020).
revoke all on function create_fiscal_score_with_outbox(uuid, text, integer, text, text, jsonb, text, text, boolean, boolean, jsonb, text, text) from public;
revoke all on function create_fiscal_score_with_outbox(uuid, text, integer, text, text, jsonb, text, text, boolean, boolean, jsonb, text, text) from anon;
revoke all on function create_fiscal_score_with_outbox(uuid, text, integer, text, text, jsonb, text, text, boolean, boolean, jsonb, text, text) from authenticated;
grant execute on function create_fiscal_score_with_outbox(uuid, text, integer, text, text, jsonb, text, text, boolean, boolean, jsonb, text, text) to service_role;

-- --------------------------------------------------------------------------------------------
-- GAP 2: a claimed PROCESSING row with no lease/staleness concept could be stuck forever if the
-- worker process crashes (or is killed, or the Render instance restarts) between claiming a batch
-- and finishing it -- migration 020's claim function only ever selected PENDING/FAILED_RETRYABLE,
-- so a PROCESSING row was invisible to every future claim, permanently.
--
-- Fix: the claim function now ALSO reclaims a PROCESSING row whose `updated_at` (bumped to the
-- claim moment by the UPDATE itself -- see migration 020) is older than `p_stale_before`. The
-- caller (HubSpotOutboxProcessorService) passes `now - 10 minutes` -- generous headroom above the
-- real HubSpot call's own 8-second internal timeout (infrastructure/hubspot-crm-provider.ts's
-- HUBSPOT_REQUEST_TIMEOUT_MS), so a row that's still genuinely being worked on by a live process
-- is never falsely reclaimed out from under it.
--
-- Signature changed (added p_stale_before) -- the old 2-argument version is dropped explicitly
-- rather than left as a second overload, so there is never ambiguity about which one a caller
-- means.
--
-- Fase 7C.1 §20 audit finding: migration 020's own hubspot_sync_outbox_claim_idx (status,
-- next_attempt_at) does not help the NEW `status = 'PROCESSING' and updated_at <= p_stale_before`
-- branch below -- a separate, partial index covers exactly that branch cheaply (this table is
-- expected to stay small/transient, but there is no reason not to index the query correctly).
create index if not exists hubspot_sync_outbox_stale_processing_idx
  on hubspot_sync_outbox(updated_at)
  where status = 'PROCESSING';

drop function if exists claim_hubspot_sync_outbox_batch(integer, timestamptz);

create function claim_hubspot_sync_outbox_batch(p_limit integer, p_now timestamptz, p_stale_before timestamptz)
returns setof hubspot_sync_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    update hubspot_sync_outbox
    set status = 'PROCESSING', updated_at = p_now
    where id in (
      select id from hubspot_sync_outbox
      where (
        (status in ('PENDING', 'FAILED_RETRYABLE') and next_attempt_at <= p_now)
        or (status = 'PROCESSING' and updated_at <= p_stale_before)
      )
      order by next_attempt_at asc
      limit p_limit
      for update skip locked
    )
    returning *;
end;
$$;

revoke all on function claim_hubspot_sync_outbox_batch(integer, timestamptz, timestamptz) from public;
revoke all on function claim_hubspot_sync_outbox_batch(integer, timestamptz, timestamptz) from anon;
revoke all on function claim_hubspot_sync_outbox_batch(integer, timestamptz, timestamptz) from authenticated;
grant execute on function claim_hubspot_sync_outbox_batch(integer, timestamptz, timestamptz) to service_role;

-- Rollback: `drop function if exists create_fiscal_score_with_outbox(...); drop index if exists
-- hubspot_sync_outbox_stale_processing_idx; drop function if exists
-- claim_hubspot_sync_outbox_batch(integer, timestamptz, timestamptz);` -- then, if reverting all
-- the way back to migration 020's original claim function,
-- `create function claim_hubspot_sync_outbox_batch(p_limit integer, p_now timestamptz) ...` exactly
-- as defined there. Neither rollback touches any data row in either table.
