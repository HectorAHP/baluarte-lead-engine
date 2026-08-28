-- Pre-launch hardening: reset_test_lead (migration 012) never surfaced Phase 4B/4C residue in its
-- report. It already DELETEs every appointment for the lead regardless of status ("delete from
-- appointments where lead_id = p_lead_id" -- unchanged below), which already cascades away
-- appointment_reschedules / appointment_cancellations / appointment_status_history /
-- appointment_message_deliveries rows via their existing `on delete cascade` FKs (see migrations
-- 013/014/015) -- there was never a referential-integrity problem here. The gap was purely
-- reporting: an operator running the dry run (which is TypeScript-side, reads directly, never
-- calls this RPC) or reading this RPC's own returned jsonb had no way to see that a lead carried,
-- e.g., an old RESCHEDULED appointment alongside a new BOOKED one, or a completed
-- appointment_reschedules row, before/after a reset.
--
-- This migration only ADDS read-only COUNT queries (executed before any DELETE, so they reflect
-- pre-reset state) and extends the returned jsonb with their results. It changes no DELETE/UPDATE
-- statement, no table schema, and no grant -- `create or replace function` preserves the existing
-- function's ACL (the REVOKE/GRANT block below is reissued anyway, defensively, to remove any
-- doubt for a future reader).
--
-- All four Phase 4 tables already carry their own denormalized lead_id column (see migrations
-- 013/014/015's own comments on why), so each count below is a direct `where lead_id = p_lead_id`
-- query -- no join through appointments needed, and the FK-consistency triggers in 014/015
-- guarantee any such row's lead_id always matches its appointment's lead_id, so these counts are
-- never able to miss or double-count a row relative to what the appointments DELETE will cascade
-- away.
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
  v_appointments_booked int;
  v_appointments_rescheduled int;
  v_appointments_cancelled int;
  v_appointments_other int;
  v_appointment_reschedules_count int;
  v_appointment_cancellations_count int;
  v_appointment_status_history_count int;
  v_appointment_message_deliveries_count int;
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

  -- Read-only: every appointment for this lead, broken down by status, BEFORE anything is
  -- deleted. Previously invisible: the only prior reporting (the TypeScript dry-run's
  -- findActiveByLeadId) surfaces at most the single currently-BOOKED row.
  select
    count(*) filter (where status = 'BOOKED'),
    count(*) filter (where status = 'RESCHEDULED'),
    count(*) filter (where status = 'CANCELLED'),
    count(*) filter (where status not in ('BOOKED', 'RESCHEDULED', 'CANCELLED'))
    into v_appointments_booked, v_appointments_rescheduled, v_appointments_cancelled, v_appointments_other
    from appointments where lead_id = p_lead_id;

  -- Read-only: Phase 4B/4C operation-tracking tables, counted directly by their own lead_id
  -- column. Actual cleanup of these rows still happens exclusively via cascade off the
  -- `delete from appointments` below -- these SELECTs never delete anything themselves.
  select count(*) into v_appointment_reschedules_count from appointment_reschedules where lead_id = p_lead_id;
  select count(*) into v_appointment_cancellations_count from appointment_cancellations where lead_id = p_lead_id;
  select count(*) into v_appointment_status_history_count from appointment_status_history where lead_id = p_lead_id;
  select count(*) into v_appointment_message_deliveries_count from appointment_message_deliveries where lead_id = p_lead_id;

  with deleted as (delete from lead_scores where lead_id = p_lead_id returning 1)
    select count(*) into v_deleted_lead_scores from deleted;

  with deleted as (delete from qualification_answers where lead_id = p_lead_id returning 1)
    select count(*) into v_deleted_qualification_answers from deleted;

  with deleted as (
    delete from offered_slots where lead_id = p_lead_id and conversation_id = p_conversation_id returning 1
  )
    select count(*) into v_deleted_offered_slots from deleted;

  -- Unchanged from migration 012: deletes EVERY appointment for this lead, any status. Cascades
  -- (see migrations 013/014/015's `on delete cascade` FKs) remove
  -- appointment_reschedules/appointment_cancellations/appointment_status_history/
  -- appointment_message_deliveries rows tied to those appointments, in the same transaction.
  with deleted as (delete from appointments where lead_id = p_lead_id returning 1)
    select count(*) into v_deleted_appointments from deleted;

  with deleted as (delete from booking_attempts where lead_id = p_lead_id returning 1)
    select count(*) into v_deleted_booking_attempts from deleted;

  with deleted as (delete from slot_offer_claims where conversation_id = p_conversation_id returning 1)
    select count(*) into v_deleted_slot_offer_claims from deleted;

  -- lead_status_history is deliberately never deleted here (unchanged from migration 012): it is
  -- keyed to the LEAD's persistent identity (which this function never deletes, only resets
  -- fields on), nothing in the application ever reads it back to make a decision, and old rows
  -- from a prior test cycle mixed in with new ones are cosmetic audit noise, not a functional or
  -- integrity risk -- the same "preserve real historical fact" principle already applied to
  -- first_contact_at/first_response_at below.
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
    'appointmentsBeforeReset', jsonb_build_object(
      'total', v_appointments_booked + v_appointments_rescheduled + v_appointments_cancelled + v_appointments_other,
      'booked', v_appointments_booked,
      'rescheduled', v_appointments_rescheduled,
      'cancelled', v_appointments_cancelled,
      'other', v_appointments_other
    ),
    'phase4OperationsBeforeReset', jsonb_build_object(
      'appointmentReschedules', v_appointment_reschedules_count,
      'appointmentCancellations', v_appointment_cancellations_count,
      'appointmentStatusHistory', v_appointment_status_history_count,
      'appointmentMessageDeliveries', v_appointment_message_deliveries_count
    ),
    'deleted', jsonb_build_object(
      'leadScores', v_deleted_lead_scores,
      'qualificationAnswers', v_deleted_qualification_answers,
      'offeredSlots', v_deleted_offered_slots,
      'appointments', v_deleted_appointments,
      'bookingAttempts', v_deleted_booking_attempts,
      'slotOfferClaims', v_deleted_slot_offer_claims,
      'appointmentReschedulesCascaded', v_appointment_reschedules_count,
      'appointmentCancellationsCascaded', v_appointment_cancellations_count,
      'appointmentStatusHistoryCascaded', v_appointment_status_history_count,
      'appointmentMessageDeliveriesCascaded', v_appointment_message_deliveries_count
    )
  );
end;
$$;

-- create or replace function preserves the existing grants, but these are reissued anyway to
-- remove any doubt for a future reader (matches migration 012's own pattern exactly).
revoke all on function reset_test_lead(uuid, uuid) from public;
revoke all on function reset_test_lead(uuid, uuid) from anon;
revoke all on function reset_test_lead(uuid, uuid) from authenticated;
grant execute on function reset_test_lead(uuid, uuid) to service_role;
