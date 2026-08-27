-- What the chat-based booking flow (Phase 7) offered the lead, so a natural-language reply
-- like "el segundo" or "el de las 10" can be resolved against a known, persisted set of slots
-- instead of re-deriving intent from nothing. Not consumed by any code yet in Phase 1.
create table if not exists offered_slots (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  position smallint not null,
  expires_at timestamptz not null,
  selected boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists offered_slots_conversation_id_idx on offered_slots(conversation_id);
alter table offered_slots enable row level security;
