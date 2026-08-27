import type { SupabaseClient } from "@supabase/supabase-js";
import type { OfferedSlotRepository } from "../application/ports.js";
import type { OfferedSlot } from "../domain/offered-slot.js";

export interface OfferedSlotRow {
  id: string;
  conversation_id: string;
  lead_id: string;
  slot_start: string;
  slot_end: string;
  position: number;
  expires_at: string;
  selected: boolean;
  created_at: string;
}

export function mapRowToOfferedSlot(row: OfferedSlotRow): OfferedSlot {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    leadId: row.lead_id,
    slotStart: new Date(row.slot_start),
    slotEnd: new Date(row.slot_end),
    position: row.position,
    expiresAt: new Date(row.expires_at),
    selected: row.selected,
    createdAt: new Date(row.created_at),
  };
}

export function mapOfferedSlotToInsertRow(input: Omit<OfferedSlot, "id" | "createdAt">) {
  return {
    conversation_id: input.conversationId,
    lead_id: input.leadId,
    slot_start: input.slotStart.toISOString(),
    slot_end: input.slotEnd.toISOString(),
    position: input.position,
    expires_at: input.expiresAt.toISOString(),
    selected: input.selected,
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

  async listActiveByConversationId(conversationId: string, now: Date): Promise<OfferedSlot[]> {
    const { data, error } = await this.client
      .from("offered_slots")
      .select()
      .eq("conversation_id", conversationId)
      .eq("selected", false)
      .gt("expires_at", now.toISOString())
      .order("position", { ascending: true });
    if (error) throw new Error(`SUPABASE_OFFERED_SLOT_LIST_FAILED: ${error.message}`);
    return (data as OfferedSlotRow[]).map(mapRowToOfferedSlot);
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
