-- Lifecycle timestamps. Wired in application code only where a real event already triggers
-- them today (created_at, first_contact_at, qualified_at, booked_at); first_response_at,
-- booking_started_at, meeting_at, and closed_at get their columns now but stay null until a
-- later phase adds the code path that sets them -- see docs/SPRINT-2.md.
alter table leads add column if not exists first_contact_at timestamptz;
alter table leads add column if not exists first_response_at timestamptz;
alter table leads add column if not exists qualified_at timestamptz;
alter table leads add column if not exists booking_started_at timestamptz;
alter table leads add column if not exists booked_at timestamptz;
alter table leads add column if not exists meeting_at timestamptz;
alter table leads add column if not exists closed_at timestamptz;

-- Dedup priority (LeadRepository.findByDedupKey): meta_lead_id -> whatsapp_user_id ->
-- phone_e164 -> email. The first two already have unique partial indexes (001, 003) since an
-- exact provider identifier is an unambiguous identity match. phone_e164 and email are
-- deliberately NOT made unique here: a shared household phone or a shared inbox email means a
-- match on either is a candidate-person match, not a guaranteed identity match, so a hard
-- uniqueness constraint would incorrectly block legitimate lead creation. Their lookup indexes
-- (leads_phone_e164_idx, leads_email_idx) already exist from migration 001.
create index if not exists leads_qualified_at_idx on leads(qualified_at) where qualified_at is not null;
create index if not exists leads_booked_at_idx on leads(booked_at) where booked_at is not null;
