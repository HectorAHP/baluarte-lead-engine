-- Phase 4A: lifecycle audit foundation. Pure audit/scheduling infrastructure -- no Phase 3C
-- behavior changes, no new user-facing flow, no route yet reads or writes these tables from a
-- feature. See docs/PHASE4-DESIGN.md for the full Phase 4 design this is the foundation of.
--
-- leads.status and appointments.status are plain `text` columns with no CHECK constraint (see
-- migrations 001/003) -- so the two new lead statuses Phase 4 needs (CANCEL_PENDING, CANCELLED)
-- and the appointment statuses that already existed unused in the TypeScript AppointmentStatus
-- union (RESCHEDULED, CANCELLED, NO_SHOW, COMPLETED) require no ALTER TABLE at all. No ALTER
-- TABLE (and no new column, index, or constraint) touches leads or appointments anywhere below --
-- the two consistency triggers further down READ appointments.lead_id to validate a row being
-- inserted here, but never modify either table.

-- Audits every real leads.status transition. Written from the single choke points that already
-- perform every status-changing leads.update() call (LeadService.transitionTo,
-- SlotOfferingService.ensureBookingPending, booking-outcome-dispatch.ts's markLeadBooked/
-- escalateToHuman) via the shared recordLeadStatusTransition helper -- never duplicated per
-- handler. A row here always reflects a completed, persisted transition; a failed or no-op
-- (from_status === to_status) transition never writes one.
create table if not exists lead_status_history (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  from_status text not null,
  to_status text not null,
  -- Closed, code-controlled event vocabulary (e.g. 'QUALIFICATION_SCORED', 'BOOKING_OFFER_ACCEPTED')
  -- -- never a free-text reason, and never the inbound message body.
  event_type text not null,
  -- Operational metadata only (e.g. {"scoreClass":"B"}) -- never clinical/diagnostic content or
  -- raw message text. See tests/lead-status-audit.test.ts for the guard this depends on.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists lead_status_history_lead_id_created_at_idx on lead_status_history(lead_id, created_at);
alter table lead_status_history enable row level security;

-- Same shape, for appointments.status. No caller exists yet in Phase 4A (nothing today updates an
-- appointment's status after creation -- appointments are only ever created directly as BOOKED,
-- see AppointmentService.completeBooking) -- the table and repository exist ready for Phase
-- 4B/4C/4E, which will call the companion recordAppointmentStatusTransition helper from their own
-- single choke points. lead_id is denormalized here (appointments already has it) purely so a
-- query can filter by lead without a join.
create table if not exists appointment_status_history (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  from_status text not null,
  to_status text not null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists appointment_status_history_appointment_id_created_at_idx on appointment_status_history(appointment_id, created_at);
-- No lead_id+created_at index yet -- no real query needs "every history row across a lead's
-- appointments" in Phase 4A; add one if/when Phase 4B+ introduces that query.
alter table appointment_status_history enable row level security;

-- Consistency guard: appointment_id and lead_id are two INDEPENDENT foreign keys above, so
-- nothing before this trigger stops a caller from inserting appointment_id=A with the lead_id of
-- a DIFFERENT lead than A actually belongs to (a real, if currently dormant, risk -- no caller
-- exists yet in Phase 4A, see recordAppointmentStatusTransition's doc comment, but Phase 4B/4C/4E
-- will add the first ones). Enforced here via a trigger rather than a composite foreign key
-- (`references appointments(id, lead_id)`) specifically so this fix never requires altering
-- `appointments` itself (an extra `unique (id, lead_id)` there would be needed for a composite
-- FK) -- this migration's own stated scope is additive-only, touching neither leads nor
-- appointments. Cheapest possible time to close this gap: both tables are still empty and unused.
create or replace function appointment_status_history_lead_id_consistency()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_actual_lead_id uuid;
begin
  select lead_id into v_actual_lead_id from appointments where id = new.appointment_id;
  if v_actual_lead_id is null then
    raise exception 'appointment_status_history: no appointment with id %', new.appointment_id;
  end if;
  if v_actual_lead_id <> new.lead_id then
    raise exception 'appointment_status_history: appointment % belongs to lead %, not %', new.appointment_id, v_actual_lead_id, new.lead_id;
  end if;
  return new;
end;
$$;

-- OF appointment_id, lead_id: appointment_status_history is append-only from application code
-- (its repository has no update() method at all) so UPDATE never fires this in practice -- scoped
-- to those two columns anyway, for the same reason as appointment_message_deliveries below (only
-- matters if a manual SQL UPDATE ever touches this table).
create trigger appointment_status_history_lead_id_consistency_trigger
  before insert or update of appointment_id, lead_id on appointment_status_history
  for each row execute function appointment_status_history_lead_id_consistency();

-- Common delivery-tracking table for every proactive outbound message Phase 4 will ever schedule
-- against an appointment (24h/2h reminders, post-meeting follow-up, a future no-show nudge) --
-- one generalized table by delivery_type instead of one table per message kind. Phase 4A creates
-- this table and its repository only; no scheduler, no sweep, no message is sent yet.
create table if not exists appointment_message_deliveries (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  delivery_type text not null check (delivery_type in ('REMINDER_24H','REMINDER_2H','POST_MEETING_FOLLOWUP','NO_SHOW_NUDGE')),
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','COMPLETED','FAILED')),
  scheduled_for timestamptz not null,
  -- Deterministically derived by the future scheduler as `{delivery_type}:{appointment_id}` (same
  -- idempotency-key convention as booking_attempts/whatsapp-booking's idempotencyKey) -- the
  -- unique constraint below is what actually guarantees "never two equivalent reminders for the
  -- same appointment", not application-level de-duplication.
  idempotency_key text not null,
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  provider_message_id text,
  -- Closed, code-controlled failure classification (e.g. 'MESSAGING_PROVIDER_ERROR') -- never a
  -- raw error message, which could echo provider-side payload content.
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (idempotency_key)
);
create index if not exists appointment_message_deliveries_sweep_idx
  on appointment_message_deliveries(delivery_type, status, scheduled_for);
alter table appointment_message_deliveries enable row level security;

-- Same dual-independent-FK gap as appointment_status_history above, same fix, same rationale --
-- appointment_id and lead_id must always describe the same real appointment/lead pair. No caller
-- exists yet (Phase 4D/4E will add the first scheduler), so this closes the gap before it can
-- ever be exercised incorrectly.
create or replace function appointment_message_deliveries_lead_id_consistency()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_actual_lead_id uuid;
begin
  select lead_id into v_actual_lead_id from appointments where id = new.appointment_id;
  if v_actual_lead_id is null then
    raise exception 'appointment_message_deliveries: no appointment with id %', new.appointment_id;
  end if;
  if v_actual_lead_id <> new.lead_id then
    raise exception 'appointment_message_deliveries: appointment % belongs to lead %, not %', new.appointment_id, v_actual_lead_id, new.lead_id;
  end if;
  return new;
end;
$$;

-- OF appointment_id, lead_id: the future scheduler's own status/attempt_count/completed_at
-- updates (high-frequency once it exists) never touch these two columns, so scoping the trigger
-- to only fire when they DO change avoids an unnecessary extra SELECT on every routine delivery
-- status update.
create trigger appointment_message_deliveries_lead_id_consistency_trigger
  before insert or update of appointment_id, lead_id on appointment_message_deliveries
  for each row execute function appointment_message_deliveries_lead_id_consistency();

-- No RLS policies on any of the three tables above -- same convention as every existing table in
-- this project (leads, appointments, offered_slots, slot_offer_claims, ...): access is exclusively
-- via the service_role key from backend code, which bypasses RLS; RLS is enabled defensively so no
-- anon/authenticated-scoped key could ever read or write these tables even by future accident.
