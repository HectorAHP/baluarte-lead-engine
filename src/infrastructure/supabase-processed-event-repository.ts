import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProcessedEventRepository } from "../application/ports.js";
import type { ProcessedEvent } from "../domain/processed-event.js";

export interface ProcessedEventRow {
  id: string;
  provider: string;
  event_id: string;
  created_at: string;
}

export function mapRowToProcessedEvent(row: ProcessedEventRow): ProcessedEvent {
  return { id: row.id, provider: row.provider, eventId: row.event_id, createdAt: new Date(row.created_at) };
}

export class SupabaseProcessedEventRepository implements ProcessedEventRepository {
  constructor(private readonly client: SupabaseClient) {}

  async tryCreate(input: { provider: string; eventId: string }): Promise<ProcessedEvent | null> {
    const { data, error } = await this.client
      .from("processed_events")
      .insert({ provider: input.provider, event_id: input.eventId })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") return null; // already processed -- same convention as SlotOfferClaimRepository.tryCreate
      throw new Error(`SUPABASE_PROCESSED_EVENT_CREATE_FAILED: ${error.message}`);
    }
    return mapRowToProcessedEvent(data as ProcessedEventRow);
  }
}
