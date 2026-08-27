-- Append-only audit trail of qualification answers. No update()/delete() in the repository by
-- design: a corrected answer is a new row (source distinguishes AI_EXTRACTED vs MANUAL), never
-- an edit of a previous one. field_name is application-validated against an explicit whitelist
-- per vertical (src/domain/qualification-fields.ts) before this table is ever written to --
-- that control lives in code (QualificationService), not in this schema, since a schema-level
-- CHECK constraint would need editing on every playbook change and duplicates the source of truth.
create table if not exists qualification_answers (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  vertical text not null,
  field_name text not null,
  field_value jsonb not null,
  source text not null,
  created_at timestamptz not null default now()
);
create index if not exists qualification_answers_lead_id_idx on qualification_answers(lead_id);
create index if not exists qualification_answers_lead_field_idx on qualification_answers(lead_id, vertical, field_name);
alter table qualification_answers enable row level security;
