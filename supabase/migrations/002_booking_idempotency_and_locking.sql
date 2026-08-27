-- Booking idempotency: dedupe retried POST /api/appointments requests by Idempotency-Key.
create table if not exists booking_attempts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  idempotency_key text not null,
  request_fingerprint text not null,
  status text not null default 'PENDING',
  appointment_id uuid references appointments(id) on delete set null,
  provider_event_id text,
  meeting_url text,
  created_at timestamptz not null default now(),
  unique (idempotency_key)
);
create index if not exists booking_attempts_lead_id_idx on booking_attempts(lead_id);
alter table booking_attempts enable row level security;

-- Double-booking protection: a Postgres exclusion constraint guarantees, at the database level,
-- that two active appointments can never occupy overlapping time ranges -- even if two concurrent
-- requests both pass the application-level freeBusy check. The losing INSERT raises SQLSTATE
-- 23P01 (exclusion_violation), which SupabaseAppointmentRepository.create() translates into
-- SlotUnavailableError. Single-advisor assumption: the constraint is global (no advisor/calendar
-- column), matching the current single-calendar architecture.
alter table appointments add column if not exists time_range tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored;
alter table appointments add constraint appointments_no_overlap exclude using gist (time_range with &&) where (status <> 'CANCELLED');
