// Fase 6A: fiscal lead scoring domain types.
//
// Deliberately separate from ScoreClass ("A"|"B"|"C", src/domain/lead-score-record.ts), which
// belongs to the WhatsApp conversational qualifier and drives LeadStatus transitions via
// targetStatusForScore(). This score is NOT fiscal probability, deductibility, refund size,
// financial benefit, or credit capacity -- it represents only the initial commercial priority of a
// lead captured through the fiscal calculator (source = WEB_FISCAL_CALCULATOR).

export const FISCAL_SCORE_VERSION = "fiscal_v1" as const;

export type FiscalScoreClass = "HOT" | "WARM" | "NURTURE";

export interface FiscalScoreReason {
  code: string;
  points: number;
}

/** Coarse-grained bands -- never exact amounts -- safe to reuse in a WhatsApp context bridge. */
export type MonthlyIncomeBand =
  | "NONE"
  | "UNDER_25K"
  | "25K_34K"
  | "35K_49K"
  | "50K_74K"
  | "75K_99K"
  | "100K_149K"
  | "150K_PLUS";

export type AnnualContributionBand =
  | "NONE"
  | "UNDER_18K"
  | "18K_35K"
  | "36K_59K"
  | "60K_119K"
  | "120K_179K"
  | "180K_PLUS";

/** Input to scoreFiscalCalculatorLead(). Only fields that are allowed to affect fiscal_v1. */
export interface FiscalScoreInput {
  monthlyIncome?: number;
  annualContribution?: number;
  filesAnnualReturn?: boolean;
  hasPpr?: boolean;
}

export interface FiscalScoreResult {
  score: number;
  scoreClass: FiscalScoreClass;
  version: typeof FISCAL_SCORE_VERSION;
  reasons: FiscalScoreReason[];
  monthlyIncomeBand: MonthlyIncomeBand;
  annualContributionBand: AnnualContributionBand;
}

/** A persisted row -- one per calculator submission (append-only history). */
export interface FiscalLeadScore {
  id: string;
  leadId: string;
  submissionId: string;
  score: number;
  scoreClass: FiscalScoreClass;
  version: string;
  reasons: FiscalScoreReason[];
  monthlyIncomeBand: MonthlyIncomeBand;
  annualContributionBand: AnnualContributionBand;
  hasPpr?: boolean;
  filesAnnualReturn?: boolean;
  createdAt: Date;
}
