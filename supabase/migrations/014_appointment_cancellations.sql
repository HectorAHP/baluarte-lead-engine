-- Phase 4B: appointment cancellation. Adds compare-and-set ownership to appointments.status
-- (AppointmentRepository.claimTransition, a plain conditional `UPDATE ... WHERE status = ...`,
-- needs no new column or migration -- appointments.status is already an unconstrained text
-- column, see migration 001/003/013) plus one small, purpose-specific lifecycle table tracking
-- whether Google Calendar cleanup for a cancellation has completed.
--
-- Deliberately NOT a reuse of booking_attempts (models "create a booking" -- request_fingerprint,
-- provider_event_id, meeting_url all describe creating an event, none of which apply to deleting
-- one) nor of appointment_message_deliveries (models proactive outbound MESSAGES, not a
-- Calendar-API side effect). See docs/PHASE4-DESIGN.md and the Phase 4B report for the fuller
-- comparison.
--
-- No ALTER TABLE on appointments or leads anywhere in this file.
create table if not exists appointment_cancellations (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  -- Deterministic: `whatsapp-cancel:{leadId}:{appointmentId}`. The UNIQUE constraint below is the
  -- actual duplicate-prevention mechanism, not application-level de-duplication -- same
  -- convention as booking_attempts.idempotency_key / appointment_message_deliveries.idempotency_key.
  idempotency_key text not null,
  -- Snapshotted at cancellation time, not re-read from appointments on every cleanup retry, so a
  -- later reconciliation attempt is self-contained even if appointments.calendar_event_id is ever
  -- cleared/changed by a future phase (e.g. reschedule). Null means the appointment never had a
  -- Calendar event -- cleanup is then trivially already done.
  calendar_event_id text,
  status text not null default 'PENDING' check (status in ('PENDING','COMPLETED')),
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  -- Closed, code-controlled failure classification (e.g. 'CALENDAR_PROVIDER_ERROR') -- never a
  -- raw provider error message.
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (idempotency_key)
);
-- Partial index for a future reconciliation job to efficiently find rows still needing a Calendar
-- cleanup retry, without scanning already-COMPLETED rows.
create index if not exists appointment_cancellations_pending_idx
  on appointment_cancellations(status) where status = 'PENDING';
alter table appointment_cancellations enable row level security;

-- Same dual-independent-FK consistency guard as migration 013's appointment_status_history /
-- appointment_message_deliveries (see that migration for the full rationale): appointment_id and
-- lead_id are two independent foreign keys, so nothing before this trigger stops a caller from
-- inserting an inconsistent pair. Read-only (only SELECTs from appointments), never alters it.
create or replace function appointment_cancellations_lead_id_consistency()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_actual_lead_id uuid;
begin
  select lead_id into v_actual_lead_id from appointments where id = new.appointment_id;
  if v_actual_lead_id is null then
    raise exception 'appointment_cancellations: no appointment with id %', new.appointment_id;
  end if;
  if v_actual_lead_id <> new.lead_id then
    raise exception 'appointment_cancellations: appointment % belongs to lead %, not %', new.appointment_id, v_actual_lead_id, new.lead_id;
  end if;
  return new;
end;
$$;

-- OF appointment_id, lead_id: the cleanup-retry status/attempt_count/completed_at updates never
-- touch these two columns, so scoping the trigger to only fire when they DO change avoids an
-- unnecessary extra SELECT on every routine cleanup-status update.
create trigger appointment_cancellations_lead_id_consistency_trigger
  before insert or update of appointment_id, lead_id on appointment_cancellations
  for each row execute function appointment_cancellations_lead_id_consistency();

-- No RLS policies -- same convention as every table in this project: access exclusively via
-- service_role (bypasses RLS), never anon/authenticated.
