import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadScoreRepository } from "../application/ports.js";
import type { LeadScoreRecord } from "../domain/lead-score-record.js";

export interface LeadScoreRow {
  id: string;
  lead_id: string;
  vertical: string;
  total: number;
  score_class: string;
  breakdown: Record<string, number | string>;
  rules_version: string;
  created_at: string;
}

export function mapRowToLeadScoreRecord(row: LeadScoreRow): LeadScoreRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    vertical: row.vertical as LeadScoreRecord["vertical"],
    total: row.total,
    scoreClass: row.score_class as LeadScoreRecord["scoreClass"],
    breakdown: row.breakdown ?? {},
    rulesVersion: row.rules_version,
    createdAt: new Date(row.created_at),
  };
}

export function mapLeadScoreRecordToInsertRow(input: Omit<LeadScoreRecord, "id" | "createdAt">) {
  return {
    lead_id: input.leadId,
    vertical: input.vertical,
    total: input.total,
    score_class: input.scoreClass,
    breakdown: input.breakdown,
    rules_version: input.rulesVersion,
  };
}

/** Append-only history. leads.score/leads.score_class remain the source of truth for "current". */
export class SupabaseLeadScoreRepository implements LeadScoreRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: Omit<LeadScoreRecord, "id" | "createdAt">): Promise<LeadScoreRecord> {
    const { data, error } = await this.client
      .from("lead_scores")
      .insert(mapLeadScoreRecordToInsertRow(input))
      .select()
      .single();
    if (error) throw new Error(`SUPABASE_LEAD_SCORE_CREATE_FAILED: ${error.message}`);
    return mapRowToLeadScoreRecord(data as LeadScoreRow);
  }

  async listByLeadId(leadId: string): Promise<LeadScoreRecord[]> {
    const { data, error } = await this.client
      .from("lead_scores")
      .select()
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`SUPABASE_LEAD_SCORE_LIST_FAILED: ${error.message}`);
    return (data as LeadScoreRow[]).map(mapRowToLeadScoreRecord);
  }
}
