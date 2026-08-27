-- Phase 3C concurrency hardening: protects SlotOfferingService's "create a new round" critical
-- section (check active offer -> check round count -> Calendar -> createMany -> transition)
-- against two concurrent callers both creating a round for the same conversation. Lives in
-- Postgres (not a process-local lock) so the exclusion holds across multiple app instances --
-- confirmed a real, reproducible race in the in-memory implementation before this was added.
--
-- One row per conversation_id (the PK doubles as the uniqueness guarantee -- a second concurrent
-- INSERT for the same conversation fails with 23505, exactly like booking_attempts.idempotency_key).
--
-- No `status` column: with owner_token part of the reclaim CAS predicate, the only two states
-- are "row exists (claimed by owner_token)" and "no row (free)" -- there is no transition where a
-- separate status value would ever need to change independently of owner_token/existence, so it
-- was deliberately left out rather than copied from booking_attempts' different state model.
--
-- No DEFAULT on owner_token/intended_round_id, same reasoning as offered_slots.round_id
-- (migration 010): the application must always supply both explicitly, so a bug can never
-- silently insert a claim nobody can reconcile.
create table if not exists slot_offer_claims (
  conversation_id uuid primary key references conversations(id) on delete cascade,
  owner_token uuid not null,
  intended_round_id uuid not null,
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table slot_offer_claims enable row level security;
-- No policies: access is via the service-role key (RLS bypassed), matching every other table in
-- this project (offered_slots, booking_attempts, appointments, ...) -- no public policy exists
-- for any of them either.
