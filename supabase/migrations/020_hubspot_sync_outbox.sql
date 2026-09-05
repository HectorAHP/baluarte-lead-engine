-- Fase 7C -- transactional outbox for HubSpot delivery. Purely additive: no existing table or
-- migration is touched. See docs/PHASE7C-DESIGN... (Fase 7C report) and
-- src/domain/hubspot-sync-outbox.ts for the full design rationale.
--
-- Decouples "the lead was captured" (leads/fiscal_lead_scores, unaffected by this migration) from
-- "HubSpot has been notified" (this table) -- POST /api/leads writes a row here synchronously (a
-- cheap Supabase insert) but never awaits the actual HubSpot HTTP call; HubSpotOutboxProcessorService
-- (run via POST /internal/hubspot-sync/run) delivers it asynchronously with retry/backoff.
create table if not exists hubspot_sync_outbox (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  -- Same submissionId the calculator/frontend already generates (impuestos.html's
  -- getSubmissionId(), sessionStorage-scoped) -- never re-derived, always the exact value the
  -- request itself carried.
  submission_id text not null,
  -- Denormalized from payload's own email/phone, for admin-tooling readability only (e.g. a
  -- reconciliation report) -- the processor itself reads `payload`, never these two columns.
  contact_email text,
  contact_phone text,
  -- Frozen snapshot of exactly what HubSpotCRMProvider.upsertContact needs (email, phone,
  -- firstName, lastName, city, state, properties) -- computed once, synchronously, at write time.
  -- Every retry sends this exact payload, never a recomputed one.
  payload jsonb not null,
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','SUCCEEDED','FAILED_RETRYABLE','FAILED_PERMANENT')),
  attempt_count integer not null default 0,
  -- Eligible for the next claim once now() >= next_attempt_at. Defaults to now() -- a fresh
  -- PENDING row is immediately eligible for the very next worker run (Fase 7C spec §9: "attempt
  -- 1: inmediato").
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  -- Closed, code-controlled failure classification (see domain/hubspot-sync-retry.ts) -- never
  -- HubSpot's raw response body, same "never parse PII/tokens out of an error body" rule as every
  -- other HubSpotProviderError handling in this project.
  last_error_code text,
  -- Set once the upsert succeeds -- see hubspot-sync-outbox.ts's own doc comment on why this is a
  -- cache for observability/reconciliation, never authoritative for identity resolution.
  hubspot_contact_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  -- The idempotency anchor (Fase 7C spec §11): a retried POST /api/leads for the SAME
  -- (lead, submissionId) pair never creates a second outbox row -- the INSERT simply loses the
  -- unique-conflict race and the caller (WebLeadCaptureService) treats that exactly like
  -- tryCreate's existing (provider, event_id) / (lead_id, delivery_type) convention elsewhere in
  -- this schema: a conflict means "already scheduled", never an error.
  unique (lead_id, submission_id)
);

-- The processor's own claim query filters on (status, next_attempt_at) -- this is the one index
-- that query actually needs; nothing else in this table is queried by any other column combination.
create index if not exists hubspot_sync_outbox_claim_idx
  on hubspot_sync_outbox(status, next_attempt_at);

alter table hubspot_sync_outbox enable row level security;

-- Fase 7C spec §12 -- concurrency-safe batch claim. A plain "SELECT then UPDATE" from application
-- code has a race window between the two statements that two concurrent workers could both win
-- (each reads the same PENDING row before either writes PROCESSING to it) -- exactly the
-- "duplicate worker run" failure mode item 9 of this table's own test list warns about. `FOR
-- UPDATE SKIP LOCKED` inside a single atomic UPDATE...WHERE-IN-subquery is the standard Postgres
-- pattern for this: two simultaneous calls can never claim the same row, because the second
-- transaction's subquery skips whatever the first has already locked, rather than blocking on it
-- (blocking would be correct too, just slower and unnecessary here -- there is no reason a second
-- worker should ever wait to find out a row is already taken).
create or replace function claim_hubspot_sync_outbox_batch(p_limit integer, p_now timestamptz)
returns setof hubspot_sync_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    update hubspot_sync_outbox
    set status = 'PROCESSING', updated_at = now()
    where id in (
      select id from hubspot_sync_outbox
      where status in ('PENDING', 'FAILED_RETRYABLE') and next_attempt_at <= p_now
      order by next_attempt_at asc
      limit p_limit
      for update skip locked
    )
    returning *;
end;
$$;

-- Same lockdown rationale as reset_test_lead (migration 012): SECURITY DEFINER lets this run with
-- the owner's (BYPASSRLS) privileges, so without these REVOKEs, anon/authenticated could invoke it
-- and claim/mutate rows despite RLS otherwise blocking them entirely from this table.
revoke all on function claim_hubspot_sync_outbox_batch(integer, timestamptz) from public;
revoke all on function claim_hubspot_sync_outbox_batch(integer, timestamptz) from anon;
revoke all on function claim_hubspot_sync_outbox_batch(integer, timestamptz) from authenticated;
grant execute on function claim_hubspot_sync_outbox_batch(integer, timestamptz) to service_role;

-- No RLS policies (same convention as every table in this project): access is exclusively via the
-- service_role key from backend code, which bypasses RLS; RLS is enabled defensively so no
-- anon/authenticated-scoped key could ever read or write this table even by future accident.

-- Rollback: `drop function if exists claim_hubspot_sync_outbox_batch(integer, timestamptz); drop
-- table if exists hubspot_sync_outbox;` -- safe at any time; no other table references this one.
