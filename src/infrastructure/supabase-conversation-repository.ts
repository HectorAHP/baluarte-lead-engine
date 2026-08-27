import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConversationRepository } from "../application/ports.js";
import type { Conversation } from "../domain/conversation.js";

export interface ConversationRow {
  id: string;
  lead_id: string;
  channel: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export function mapRowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    leadId: row.lead_id,
    channel: row.channel as Conversation["channel"],
    status: row.status as Conversation["status"],
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function mapConversationToInsertRow(input: Omit<Conversation, "id" | "createdAt" | "updatedAt">) {
  return {
    lead_id: input.leadId,
    channel: input.channel,
    status: input.status,
  };
}

export function mapConversationPatchToRow(patch: Partial<Conversation>): Record<string, unknown> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.channel !== undefined) row.channel = patch.channel;
  return row;
}

export class SupabaseConversationRepository implements ConversationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: Omit<Conversation, "id" | "createdAt" | "updatedAt">): Promise<Conversation> {
    const { data, error } = await this.client
      .from("conversations")
      .insert(mapConversationToInsertRow(input))
      .select()
      .single();
    if (error) throw new Error(`SUPABASE_CONVERSATION_CREATE_FAILED: ${error.message}`);
    return mapRowToConversation(data as ConversationRow);
  }

  async findById(id: string): Promise<Conversation | null> {
    const { data, error } = await this.client.from("conversations").select().eq("id", id).maybeSingle();
    if (error) throw new Error(`SUPABASE_CONVERSATION_FIND_FAILED: ${error.message}`);
    return data ? mapRowToConversation(data as ConversationRow) : null;
  }

  async findActiveByLeadId(leadId: string): Promise<Conversation | null> {
    const { data, error } = await this.client
      .from("conversations")
      .select()
      .eq("lead_id", leadId)
      .eq("status", "ACTIVE")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`SUPABASE_CONVERSATION_FIND_ACTIVE_FAILED: ${error.message}`);
    return data ? mapRowToConversation(data as ConversationRow) : null;
  }

  async update(id: string, patch: Partial<Conversation>): Promise<Conversation> {
    const { data, error } = await this.client
      .from("conversations")
      .update(mapConversationPatchToRow(patch))
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(`SUPABASE_CONVERSATION_UPDATE_FAILED: ${error.message}`);
    return mapRowToConversation(data as ConversationRow);
  }
}
