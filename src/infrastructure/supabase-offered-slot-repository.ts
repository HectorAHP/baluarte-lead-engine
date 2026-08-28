import type { SupabaseClient } from "@supabase/supabase-js";
import type { OfferedSlotRepository } from "../application/ports.js";
import type { OfferedSlot } from "../domain/offered-slot.js";

export interface OfferedSlotRow {
  id: string;
  conversation_id: string;
  lead_id: string;
  round_id: string;
  slot_start: string;
  slot_end: string;
  position: number;
  expires_at: string;
  selected: boolean;
  created_at: string;
  reschedule_context_id: string | null;
}

export function mapRowToOfferedSlot(row: OfferedSlotRow): OfferedSlot {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    leadId: row.lead_id,
    roundId: row.round_id,
    slotStart: new Date(row.slot_start),
    slotEnd: new Date(row.slot_end),
    position: row.position,
    expiresAt: new Date(row.expires_at),
    selected: row.selected,
    createdAt: new Date(row.created_at),
    rescheduleContextId: row.reschedule_context_id ?? undefined,
  };
}

export function mapOfferedSlotToInsertRow(input: Omit<OfferedSlot, "id" | "createdAt">) {
  return {
    conversation_id: input.conversationId,
    lead_id: input.leadId,
    round_id: input.roundId,
    slot_start: input.slotStart.toISOString(),
    slot_end: input.slotEnd.toISOString(),
    position: input.position,
    expires_at: input.expiresAt.toISOString(),
    selected: input.selected,
    reschedule_context_id: input.rescheduleContextId ?? null,
  };
}

export function mapOfferedSlotPatchToRow(patch: Partial<OfferedSlot>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.selected !== undefined) row.selected = patch.selected;
  if (patch.expiresAt !== undefined) row.expires_at = patch.expiresAt.toISOString();
  return row;
}

export class SupabaseOfferedSlotRepository implements OfferedSlotRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: Omit<OfferedSlot, "id" | "createdAt">): Promise<OfferedSlot> {
    const { data, error } = await this.client
      .from("offered_slots")
      .insert(mapOfferedSlotToInsertRow(input))
      .select()
      .single();
    if (error) throw new Error(`SUPABASE_OFFERED_SLOT_CREATE_FAILED: ${error.message}`);
    return mapRowToOfferedSlot(data as OfferedSlotRow);
  }

  /**
   * One multi-row INSERT statement -- never a loop of individual create() calls. Postgres runs a
   * single statement as one implicit transaction: if any row violates a constraint (e.g. the
   * migration 010 `unique (round_id, position)`), the entire statement rolls back and zero rows
   * are persisted, matching InMemoryOfferedSlotRepository's simulated semantics.
   */
  async createMany(inputs: Array<Omit<OfferedSlot, "id" | "createdAt">>): Promise<OfferedSlot[]> {
    const { data, error } = await this.client
      .from("offered_slots")
      .insert(inputs.map(mapOfferedSlotToInsertRow))
      .select();
    if (error) throw new Error(`SUPABASE_OFFERED_SLOT_CREATE_MANY_FAILED: ${error.message}`);
    return (data as OfferedSlotRow[]).map(mapRowToOfferedSlot);
  }

  async listActiveByConversationId(conversationId: string, now: Date, rescheduleContextId?: string): Promise<OfferedSlot[]> {
    let query = this.client
      .from("offered_slots")
      .select()
      .eq("conversation_id", conversationId)
      .eq("selected", false)
      .gt("expires_at", now.toISOString());
    // Scoped by booking context (Phase 4C hardening -- this was the actual root cause of a
    // reschedule silently reusing the original booking round's leftover slots: this filter was
    // missing entirely). Same convention as listRoundIdsByConversationId below.
    query = rescheduleContextId === undefined ? query.is("reschedule_context_id", null) : query.eq("reschedule_context_id", rescheduleContextId);
    const { data, error } = await query.order("position", { ascending: true });
    if (error) throw new Error(`SUPABASE_OFFERED_SLOT_LIST_FAILED: ${error.message}`);
    return (data as OfferedSlotRow[]).map(mapRowToOfferedSlot);
  }

  /**
   * PostgREST has no clean way to express `COUNT(DISTINCT round_id)` through the supabase-js
   * query builder without a custom RPC function -- `.select(..., {count:'exact'})` counts
   * matching ROWS, not distinct values of a column. So this fetches round_id for every row
   * belonging to the conversation and dedupes here, in application code. Correct (if it fetches
   * a few more values than strictly needed) beats a plausible-looking but wrong pseudo-aggregate.
   */
  async listRoundIdsByConversationId(conversationId: string, rescheduleContextId?: string): Promise<string[]> {
    let query = this.client.from("offered_slots").select("round_id").eq("conversation_id", conversationId);
    // Scoped by booking context (Phase 4C): undefined counts only booking-mode rounds
    // (reschedule_context_id IS NULL); a value counts only rounds tagged with that exact
    // reschedule context. Never a mix of both -- see ports.ts's doc comment.
    query = rescheduleContextId === undefined ? query.is("reschedule_context_id", null) : query.eq("reschedule_context_id", rescheduleContextId);
    const { data, error } = await query;
    if (error) throw new Error(`SUPABASE_OFFERED_SLOT_LIST_ROUNDS_FAILED: ${error.message}`);
    return [...new Set((data as Array<{ round_id: string }>).map((row) => row.round_id))];
  }

  async update(id: string, patch: Partial<OfferedSlot>): Promise<OfferedSlot> {
    const { data, error } = await this.client
      .from("offered_slots")
      .update(mapOfferedSlotPatchToRow(patch))
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(`SUPABASE_OFFERED_SLOT_UPDATE_FAILED: ${error.message}`);
    return mapRowToOfferedSlot(data as OfferedSlotRow);
  }
}
