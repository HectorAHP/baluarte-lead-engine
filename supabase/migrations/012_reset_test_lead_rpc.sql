-- Phase 3C administrative tooling: resets a SINGLE test lead+conversation back to a
-- pre-qualification state, atomically. This is a TEST-DATA tool -- never intended to run against
-- a real lead. The only sanctioned caller is scripts/reset-test-lead.ts, which always shows a
-- dry-run preview first and only invokes this function when the operator passes --confirm.
--
-- Why an RPC instead of a sequence of DELETE/UPDATE calls from the script: supabase-js/PostgREST
-- has no multi-statement transaction primitive -- every call is its own independent HTTP
-- request/statement. A script issuing these deletes/updates as separate calls could be left
-- half-applied if it died or errored partway through. Wrapping the whole reset in one PL/pgSQL
-- function body makes it a single Postgres transaction: either everything below commits, or (on
-- any error, including the ownership check failing) none of it does -- Postgres implicitly rolls
-- back a function body on an unhandled exception.
--
-- SECURITY DEFINER: the function runs with the privileges of its owner (the migration-applying
-- role, which in Supabase has BYPASSRLS), so it can read/write the RLS-enabled-but-policy-less
-- tables below the same way this project's own service-role-authenticated application traffic
-- already does today -- this is NOT a new bypass of anything currently enforced. What SECURITY
-- DEFINER actually changes is that, without the REVOKE statements below, ANY role able to call
-- this function (e.g. anon/authenticated, which do NOT otherwise bypass RLS) would have this
-- admin-only reset run with the owner's elevated privileges regardless of their own RLS
-- restrictions -- exactly why EXECUTE is revoked from every role except service_role.
--
-- Explicitly scoped: every statement below is filtered by p_lead_id and/or p_conversation_id --
-- there is no global/unfiltered DELETE anywhere in this function. Aborts loudly (RAISE EXCEPTION,
-- which rolls back the whole transaction) if the given conversation does not belong to the given
-- lead, rather than silently resetting the wrong rows.
--
-- messages is deliberately NEVER touched (no DELETE, no UPDATE) -- conversation history is kept.
-- leads/conversations rows are never deleted, only their fields reset -- see the UPDATEs below.
create or replace function reset_test_lead(p_lead_id uuid, p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation_lead_id uuid;
  v_deleted_lead_scores int;
  v_deleted_qualification_answers int;
  v_deleted_offered_slots int;
  v_deleted_appointments int;
  v_deleted_booking_attempts int;
  v_deleted_slot_offer_claims int;
begin
  if not exists (select 1 from leads where id = p_lead_id) then
    raise exception 'reset_test_lead: no lead with id %', p_lead_id;
  end if;

  select lead_id into v_conversation_lead_id from conversations where id = p_conversation_id;
  if v_conversation_lead_id is null then
    raise exception 'reset_test_lead: no conversation with id %', p_conversation_id;
  end if;
  if v_conversation_lead_id <> p_lead_id then
    raise exception 'reset_test_lead: conversation % belongs to lead %, not %',
      p_conversation_id, v_conversation_lead_id, p_lead_id;
  end if;

  with deleted as (delete from lead_scores where lead_id = p_lead_id returning 1)
    select count(*) into v_deleted_lead_scores from deleted;

  with deleted as (delete from qualification_answers where lead_id = p_lead_id returning 1)
    select count(*) into v_deleted_qualification_answers from deleted;

  with deleted as (
    delete from offered_slots where lead_id = p_lead_id and conversation_id = p_conversation_id returning 1
  )
    select count(*) into v_deleted_offered_slots from deleted;

  with deleted as (delete from appointments where lead_id = p_lead_id returning 1)
    select count(*) into v_deleted_appointments from deleted;

  with deleted as (delete from booking_attempts where lead_id = p_lead_id returning 1)
    select count(*) into v_deleted_booking_attempts from deleted;

  with deleted as (delete from slot_offer_claims where conversation_id = p_conversation_id returning 1)
    select count(*) into v_deleted_slot_offer_claims from deleted;

  -- first_contact_at / first_response_at are deliberately absent from this SET clause -- they
  -- are preserved exactly as-is, real historical fact about this lead.
  update leads set
    status = 'CONTACTED',
    product_interest = null,
    product_vertical = 'UNKNOWN',
    score = 0,
    score_class = null,
    qualified_at = null,
    booking_started_at = null,
    booked_at = null,
    meeting_at = null,
    closed_at = null,
    updated_at = now()
  where id = p_lead_id;

  update conversations set
    status = 'ACTIVE',
    updated_at = now()
  where id = p_conversation_id;

  return jsonb_build_object(
    'leadId', p_lead_id,
    'conversationId', p_conversation_id,
    'deleted', jsonb_build_object(
      'leadScores', v_deleted_lead_scores,
      'qualificationAnswers', v_deleted_qualification_answers,
      'offeredSlots', v_deleted_offered_slots,
      'appointments', v_deleted_appointments,
      'bookingAttempts', v_deleted_booking_attempts,
      'slotOfferClaims', v_deleted_slot_offer_claims
    )
  );
end;
$$;

-- Lock down execution: revoke the default PUBLIC grant explicitly, then re-grant only to
-- service_role. anon/authenticated never had a legitimate reason to touch this, and without
-- these REVOKEs the SECURITY DEFINER elevation above would let them reset ANY lead's data.
revoke all on function reset_test_lead(uuid, uuid) from public;
revoke all on function reset_test_lead(uuid, uuid) from anon;
revoke all on function reset_test_lead(uuid, uuid) from authenticated;
grant execute on function reset_test_lead(uuid, uuid) to service_role;
