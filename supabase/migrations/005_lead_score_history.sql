-- Append-only score history. leads.score / leads.score_class remain the denormalized "current
-- state" columns for cheap reads (lists, dashboards); this table is the audit trail across
-- however many times a lead gets (re-)scored during a conversation.
create table if not exists lead_scores (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  vertical text not null,
  total integer not null,
  score_class text not null,
  breakdown jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists lead_scores_lead_id_idx on lead_scores(lead_id);
alter table lead_scores enable row level security;
