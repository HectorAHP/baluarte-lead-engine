-- Phase 4C: appointment reschedule. Adds ONE new, purpose-specific table tracking a reschedule
-- operation end-to-end (see src/domain/appointment-reschedule.ts for the full rationale of why
-- this is not a reuse of appointment_cancellations or booking_attempts).
--
-- appointments.rescheduled_from and appointments.status='RESCHEDULED' already existed since
-- migration 001 (see that file's `appointments` table definition) -- both were unused until now.
-- No ALTER TABLE on appointments, leads, or any existing table anywhere in this file.
create table if not exists appointment_reschedules (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  old_appointment_id uuid not null references appointments(id) on delete cascade,
  -- Null until Phase A (Calendar event created + new appointment persisted) completes -- its
  -- presence IS the phase boundary, see the domain type's doc comment. Deliberately nullable, not
  -- a separate boolean/enum column.
  new_appointment_id uuid references appointments(id) on delete cascade,
  -- Persisted the MOMENT the remote Calendar event id is known -- immediately after
  -- calendar.createEvent() succeeds, BEFORE new_appointment_id is ever set (see
  -- AppointmentRescheduleService.reschedule's doc comment, hardening item 6). A crash between
  -- "Calendar event created" and "appointment persisted" still leaves this column as a durable
  -- reference to the event -- never silently orphaned. Reconciliation query for a future job:
  -- `select * from appointment_reschedules where new_calendar_event_id is not null and
  -- new_appointment_id is null`.
  new_calendar_event_id text,
  -- Phase A ownership state -- mirrors booking_attempts.status exactly (PENDING/FAILED/
  -- COMPLETED), so a transient Calendar failure during Phase A is reclaimable via the same
  -- PENDING->FAILED->PENDING (stale) / FAILED->PENDING (immediate) compare-and-set
  -- AppointmentService.claimExistingAttempt already established, instead of permanently locking
  -- out a retry of the same still-valid slot selection (hardening item 12). Independent of
  -- `status` below, which is ONLY ever about Phase B (old-Calendar cleanup).
  phase_a_status text not null default 'PENDING' check (phase_a_status in ('PENDING','FAILED','COMPLETED')),
  -- Deterministic: `whatsapp-reschedule:{leadId}:{oldAppointmentId}:{offeredSlotId}`. The UNIQUE
  -- constraint below is the actual duplicate-prevention/ownership mechanism, not application-level
  -- de-duplication -- same convention as booking_attempts.idempotency_key /
  -- appointment_cancellations.idempotency_key.
  idempotency_key text not null,
  -- Snapshotted at reschedule time, not re-read from appointments on every cleanup retry -- same
  -- rationale as appointment_cancellations.calendar_event_id. Null means the old appointment never
  -- had a Calendar event.
  old_calendar_event_id text,
  -- Phase B (old-Calendar-event cleanup) tracking -- same shape/meaning as
  -- appointment_cancellations.status, scoped to this reschedule's old event instead of a
  -- cancelled one.
  status text not null default 'PENDING' check (status in ('PENDING','COMPLETED')),
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  -- Closed, code-controlled failure classification (e.g. 'CALENDAR_PROVIDER_ERROR') -- never a
  -- raw provider error message. Shared by both phases (whichever failed most recently wins).
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (idempotency_key),
  -- A reschedule always produces a DIFFERENT appointment -- old_appointment_id and
  -- new_appointment_id must never be the same row.
  check (new_appointment_id is null or new_appointment_id <> old_appointment_id)
);
-- Partial index for a future reconciliation job to efficiently find rows still needing an
-- old-Calendar cleanup retry, without scanning already-COMPLETED rows. Same pattern as migration
-- 014's appointment_cancellations_pending_idx.
create index if not exists appointment_reschedules_pending_idx
  on appointment_reschedules(status) where status = 'PENDING';
-- Same rationale, for Phase A: a future reconciliation job (or the orphan-Calendar-event query in
-- new_calendar_event_id's own comment) can find abandoned/failed Phase A attempts without
-- scanning COMPLETED rows.
create index if not exists appointment_reschedules_phase_a_pending_idx
  on appointment_reschedules(phase_a_status) where phase_a_status in ('PENDING','FAILED');
-- Lookup index for the Phase A ownership check (tryCreate-or-find by idempotency_key is already
-- covered by the UNIQUE constraint's implicit index above); this one supports finding a lead's
-- reschedule rows for read-only administrative/reconciliation tooling.
create index if not exists appointment_reschedules_lead_id_idx on appointment_reschedules(lead_id);
alter table appointment_reschedules enable row level security;

-- Phase 4C hardening item 11: MAX_OFFER_ROUNDS must be scoped per booking-context, not
-- cumulatively per conversation forever -- otherwise a lead who exhausted their 3 rounds during
-- the ORIGINAL booking could be incorrectly blocked (MAX_ROUNDS_REACHED -> HUMAN_HANDOFF) the
-- first time they ever try to reschedule, and vice versa. Aditive, nullable, zero behavior change
-- for existing rows/code paths: every Phase 3C booking round leaves this NULL (unchanged), and
-- SlotOfferingService.listRoundIdsByConversationId only ever counts NULL-context rows for
-- booking mode. A reschedule round is tagged with the OLD appointment's id -- a stable,
-- already-persistent identifier for "this reschedule episode", never a created_at/timestamp
-- heuristic (see src/domain/offered-slot.ts's rescheduleContextId doc comment for the full
-- rationale). No ALTER on any column already in migration 010's offered_slots definition.
alter table offered_slots add column if not exists reschedule_context_id uuid references appointments(id) on delete cascade;
create index if not exists offered_slots_conversation_context_idx on offered_slots(conversation_id, reschedule_context_id);

-- Same dual-independent-FK consistency guard as migrations 013/014 (see those for the full
-- rationale): lead_id, old_appointment_id, and new_appointment_id are three independent foreign
-- keys, so nothing before this trigger stops a caller from inserting/updating an inconsistent
-- combination. Read-only (only SELECTs from appointments), never alters it. new_appointment_id is
-- checked only when it is not null (it starts null -- see the column comment above).
create or replace function appointment_reschedules_lead_id_consistency()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_old_lead_id uuid;
  v_new_lead_id uuid;
begin
  select lead_id into v_old_lead_id from appointments where id = new.old_appointment_id;
  if v_old_lead_id is null then
    raise exception 'appointment_reschedules: no appointment with id % (old_appointment_id)', new.old_appointment_id;
  end if;
  if v_old_lead_id <> new.lead_id then
    raise exception 'appointment_reschedules: old_appointment_id % belongs to lead %, not %', new.old_appointment_id, v_old_lead_id, new.lead_id;
  end if;

  if new.new_appointment_id is not null then
    select lead_id into v_new_lead_id from appointments where id = new.new_appointment_id;
    if v_new_lead_id is null then
      raise exception 'appointment_reschedules: no appointment with id % (new_appointment_id)', new.new_appointment_id;
    end if;
    if v_new_lead_id <> new.lead_id then
      raise exception 'appointment_reschedules: new_appointment_id % belongs to lead %, not %', new.new_appointment_id, v_new_lead_id, new.lead_id;
    end if;
  end if;

  return new;
end;
$$;

-- OF lead_id, old_appointment_id, new_appointment_id: the cleanup-retry status/attempt_count/
-- completed_at updates never touch these three columns, so scoping the trigger to only fire when
-- they DO change avoids an unnecessary extra SELECT on every routine cleanup-status update (same
-- reasoning as migration 014's trigger scoping).
create trigger appointment_reschedules_lead_id_consistency_trigger
  before insert or update of lead_id, old_appointment_id, new_appointment_id on appointment_reschedules
  for each row execute function appointment_reschedules_lead_id_consistency();

-- No RLS policies -- same convention as every table in this project: access exclusively via
-- service_role (bypasses RLS), never anon/authenticated.
