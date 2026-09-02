import type { SupabaseClient } from "@supabase/supabase-js";
import type { FiscalLeadScoreRepository } from "../application/ports.js";
import type {
  AnnualContributionBand,
  FiscalLeadScore,
  FiscalScoreClass,
  FiscalScoreReason,
  MonthlyIncomeBand,
} from "../domain/fiscal-lead-score.js";

export interface FiscalLeadScoreRow {
  id: string;
  lead_id: string;
  submission_id: string;
  score: number;
  score_class: string;
  version: string;
  reasons: FiscalScoreReason[];
  monthly_income_band: string;
  annual_contribution_band: string;
  has_ppr: boolean | null;
  files_annual_return: boolean | null;
  created_at: string;
}

export function mapRowToFiscalLeadScore(row: FiscalLeadScoreRow): FiscalLeadScore {
  return {
    id: row.id,
    leadId: row.lead_id,
    submissionId: row.submission_id,
    score: row.score,
    scoreClass: row.score_class as FiscalScoreClass,
    version: row.version,
    reasons: row.reasons ?? [],
    monthlyIncomeBand: row.monthly_income_band as MonthlyIncomeBand,
    annualContributionBand: row.annual_contribution_band as AnnualContributionBand,
    hasPpr: row.has_ppr ?? undefined,
    filesAnnualReturn: row.files_annual_return ?? undefined,
    createdAt: new Date(row.created_at),
  };
}

function mapFiscalLeadScoreToInsertRow(input: Omit<FiscalLeadScore, "id" | "createdAt">) {
  return {
    lead_id: input.leadId,
    submission_id: input.submissionId,
    score: input.score,
    score_class: input.scoreClass,
    version: input.version,
    reasons: input.reasons,
    monthly_income_band: input.monthlyIncomeBand,
    annual_contribution_band: input.annualContributionBand,
    has_ppr: input.hasPpr ?? null,
    files_annual_return: input.filesAnnualReturn ?? null,
  };
}

/** Fase 6A -- append-only fiscal calculator scoring history. See migration
 * 017_fiscal_lead_scores.sql's header comment for why this is a dedicated table, never
 * lead_scores/leads.score_class. */
export class SupabaseFiscalLeadScoreRepository implements FiscalLeadScoreRepository {
  constructor(private readonly client: SupabaseClient) {}

  async tryCreate(input: Omit<FiscalLeadScore, "id" | "createdAt">): Promise<FiscalLeadScore | null> {
    const { data, error } = await this.client
      .from("fiscal_lead_scores")
      .insert(mapFiscalLeadScoreToInsertRow(input))
      .select()
      .single();
    if (error) {
      if (error.code === "23505") return null; // already scored this submission -- same convention as SupabaseProcessedEventRepository.tryCreate
      throw new Error(`SUPABASE_FISCAL_LEAD_SCORE_CREATE_FAILED: ${error.message}`);
    }
    return mapRowToFiscalLeadScore(data as FiscalLeadScoreRow);
  }

  async listByLeadId(leadId: string): Promise<FiscalLeadScore[]> {
    const { data, error } = await this.client
      .from("fiscal_lead_scores")
      .select()
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`SUPABASE_FISCAL_LEAD_SCORE_LIST_FAILED: ${error.message}`);
    return (data as FiscalLeadScoreRow[]).map(mapRowToFiscalLeadScore);
  }
}
