import type { SupabaseClient } from "@supabase/supabase-js";
import type { MessageRepository } from "../application/ports.js";
import type { Message } from "../domain/message.js";
import { DuplicateMessageError } from "../domain/errors.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";

export interface MessageRow {
  id: string;
  conversation_id: string;
  lead_id: string;
  direction: string;
  channel: string;
  sender: string | null;
  body: string | null;
  provider_message_id: string | null;
  ai_generated: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
}

export function mapRowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    leadId: row.lead_id,
    direction: row.direction as Message["direction"],
    channel: row.channel as Message["channel"],
    sender: row.sender ?? undefined,
    body: row.body ?? undefined,
    providerMessageId: row.provider_message_id ?? undefined,
    aiGenerated: row.ai_generated,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
  };
}

export function mapMessageToInsertRow(input: Omit<Message, "id" | "createdAt">) {
  return {
    conversation_id: input.conversationId,
    lead_id: input.leadId,
    direction: input.direction,
    channel: input.channel,
    sender: input.sender ?? null,
    body: input.body ?? null,
    provider_message_id: input.providerMessageId ?? null,
    ai_generated: input.aiGenerated,
    metadata: input.metadata ?? {},
  };
}

export class SupabaseMessageRepository implements MessageRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: Omit<Message, "id" | "createdAt">): Promise<Message> {
    const { data, error } = await this.client
      .from("messages")
      .insert(mapMessageToInsertRow(input))
      .select()
      .single();
    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) throw new DuplicateMessageError(input.channel, input.providerMessageId ?? "");
      throw new Error(`SUPABASE_MESSAGE_CREATE_FAILED: ${error.message}`);
    }
    return mapRowToMessage(data as MessageRow);
  }

  async findByProviderMessageId(channel: Message["channel"], providerMessageId: string): Promise<Message | null> {
    const { data, error } = await this.client
      .from("messages")
      .select()
      .eq("channel", channel)
      .eq("provider_message_id", providerMessageId)
      .maybeSingle();
    if (error) throw new Error(`SUPABASE_MESSAGE_FIND_FAILED: ${error.message}`);
    return data ? mapRowToMessage(data as MessageRow) : null;
  }

  async listByConversationId(conversationId: string): Promise<Message[]> {
    const { data, error } = await this.client
      .from("messages")
      .select()
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`SUPABASE_MESSAGE_LIST_FAILED: ${error.message}`);
    return (data as MessageRow[]).map(mapRowToMessage);
  }
}
