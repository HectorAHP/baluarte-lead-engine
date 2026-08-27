import type { SupabaseClient } from "@supabase/supabase-js";
import type { QualificationAnswerRepository } from "../application/ports.js";
import type { QualificationAnswer } from "../domain/qualification-answer.js";

export interface QualificationAnswerRow {
  id: string;
  lead_id: string;
  conversation_id: string | null;
  vertical: string;
  field_name: string;
  field_value: unknown;
  source: string;
  created_at: string;
}

export function mapRowToQualificationAnswer(row: QualificationAnswerRow): QualificationAnswer {
  return {
    id: row.id,
    leadId: row.lead_id,
    conversationId: row.conversation_id ?? undefined,
    vertical: row.vertical as QualificationAnswer["vertical"],
    fieldName: row.field_name,
    fieldValue: row.field_value,
    source: row.source as QualificationAnswer["source"],
    createdAt: new Date(row.created_at),
  };
}

export function mapQualificationAnswerToInsertRow(input: Omit<QualificationAnswer, "id" | "createdAt">) {
  return {
    lead_id: input.leadId,
    conversation_id: input.conversationId ?? null,
    vertical: input.vertical,
    field_name: input.fieldName,
    field_value: input.fieldValue,
    source: input.source,
  };
}

/** Append-only: no update() method by design -- a corrected answer is a new row, never an edit. */
export class SupabaseQualificationAnswerRepository implements QualificationAnswerRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: Omit<QualificationAnswer, "id" | "createdAt">): Promise<QualificationAnswer> {
    const { data, error } = await this.client
      .from("qualification_answers")
      .insert(mapQualificationAnswerToInsertRow(input))
      .select()
      .single();
    if (error) throw new Error(`SUPABASE_QUALIFICATION_ANSWER_CREATE_FAILED: ${error.message}`);
    return mapRowToQualificationAnswer(data as QualificationAnswerRow);
  }

  async listByLeadId(leadId: string): Promise<QualificationAnswer[]> {
    const { data, error } = await this.client
      .from("qualification_answers")
      .select()
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`SUPABASE_QUALIFICATION_ANSWER_LIST_FAILED: ${error.message}`);
    return (data as QualificationAnswerRow[]).map(mapRowToQualificationAnswer);
  }
}
