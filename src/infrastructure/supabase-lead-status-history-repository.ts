import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadStatusHistoryRepository } from "../application/ports.js";
import type { LeadStatusHistoryEntry } from "../domain/lead-status-history.js";
import type { LeadStatus } from "../domain/lead.js";

export interface LeadStatusHistoryRow {
  id: string;
  lead_id: string;
  from_status: string;
  to_status: string;
  event_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export function mapRowToLeadStatusHistoryEntry(row: LeadStatusHistoryRow): LeadStatusHistoryEntry {
  return {
    id: row.id,
    leadId: row.lead_id,
    fromStatus: row.from_status as LeadStatus,
    toStatus: row.to_status as LeadStatus,
    eventType: row.event_type,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
  };
}

export class SupabaseLeadStatusHistoryRepository implements LeadStatusHistoryRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: Omit<LeadStatusHistoryEntry, "id" | "createdAt">): Promise<LeadStatusHistoryEntry> {
    const { data, error } = await this.client
      .from("lead_status_history")
      .insert({
        lead_id: input.leadId,
        from_status: input.fromStatus,
        to_status: input.toStatus,
        event_type: input.eventType,
        metadata: input.metadata,
      })
      .select()
      .single();
    if (error) throw new Error(`SUPABASE_LEAD_STATUS_HISTORY_CREATE_FAILED: ${error.message}`);
    return mapRowToLeadStatusHistoryEntry(data as LeadStatusHistoryRow);
  }

  async listByLeadId(leadId: string): Promise<LeadStatusHistoryEntry[]> {
    const { data, error } = await this.client
      .from("lead_status_history")
      .select()
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`SUPABASE_LEAD_STATUS_HISTORY_LIST_FAILED: ${error.message}`);
    return (data as LeadStatusHistoryRow[]).map(mapRowToLeadStatusHistoryEntry);
  }
}
