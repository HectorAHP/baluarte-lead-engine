-- Phase 3C round-counting foundation: offered_slots needs a way to identify which rows were
-- offered together as one round, so MAX_OFFER_ROUNDS can be enforced deterministically (see
-- SlotOfferingService). Grouping by created_at/expires_at proximity was explicitly rejected as a
-- fragile timestamp heuristic -- round_id is the real, application-supplied identifier instead.
--
-- Confirmed empty in real Supabase (select count(*) from offered_slots -> 0) on 2026-08-26, so:
--   - no backfill is needed or performed here;
--   - this migration is safe to run without a data-migration step;
--   - round_id is added NOT NULL with NO DEFAULT. A DEFAULT of gen_random_uuid() was
--     deliberately rejected: if any future code path ever inserted offered_slots rows one at a
--     time again (bypassing SlotOfferingService.createRound/createMany), a default would
--     silently stamp a DISTINCT random UUID on each row, defeating the entire purpose of this
--     column. NOT NULL with no default instead makes the database refuse any insert that
--     doesn't explicitly supply a round_id -- the application (SlotOfferingService.createRound)
--     generates exactly one UUID per round and passes it explicitly to every slot in that round
--     via createMany().
alter table offered_slots add column round_id uuid not null;

-- Guarantees at most one slot per position within a round -- catches accidental duplicate
-- persistence (e.g. a retried createMany call after a request that actually succeeded
-- server-side but whose response was lost) and structurally caps a round at one row per
-- position. round_id is a globally unique UUID (not scoped per conversation), so (round_id,
-- position) alone is a sufficient key -- no need to also repeat conversation_id here.
alter table offered_slots add constraint offered_slots_round_id_position_key unique (round_id, position);
