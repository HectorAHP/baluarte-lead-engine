// Fase 6A: fiscal_v1 -- pure, deterministic, testable commercial scoring for leads captured
// through the fiscal calculator (source = WEB_FISCAL_CALCULATOR).
//
// This score is NOT fiscal probability, deductibility, refund size, financial benefit, or credit
// capacity. It is only an initial commercial-priority signal, explainable via reason codes.
//
// Fields that deliberately do NOT affect this score: age, sex, city, state, tax regime, GMM,
// fiscal result, calculated fiscal benefit, deductions, UTMs, campaign, fbclid, marketing
// consent, privacy consent, email, phone. consentContact is a contact-authorization flag, not a
// quality signal -- see canProactivelyContactLead() in contact-eligibility.ts.
import {
  FISCAL_SCORE_VERSION,
  type AnnualContributionBand,
  type FiscalScoreInput,
  type FiscalScoreReason,
  type FiscalScoreResult,
  type MonthlyIncomeBand,
} from "./fiscal-lead-score.js";

function scoreMonthlyIncome(monthlyIncome: number | undefined): {
  points: number;
  reason: FiscalScoreReason;
  band: MonthlyIncomeBand;
} {
  if (typeof monthlyIncome !== "number" || !Number.isFinite(monthlyIncome) || monthlyIncome <= 0) {
    return { points: 0, reason: { code: "MONTHLY_INCOME_MISSING", points: 0 }, band: "NONE" };
  }
  if (monthlyIncome >= 150000) {
    return { points: 40, reason: { code: "MONTHLY_INCOME_150K_PLUS", points: 40 }, band: "150K_PLUS" };
  }
  if (monthlyIncome >= 100000) {
    return { points: 35, reason: { code: "MONTHLY_INCOME_100K_149K", points: 35 }, band: "100K_149K" };
  }
  if (monthlyIncome >= 75000) {
    return { points: 30, reason: { code: "MONTHLY_INCOME_75K_99K", points: 30 }, band: "75K_99K" };
  }
  if (monthlyIncome >= 50000) {
    return { points: 24, reason: { code: "MONTHLY_INCOME_50K_74K", points: 24 }, band: "50K_74K" };
  }
  if (monthlyIncome >= 35000) {
    return { points: 18, reason: { code: "MONTHLY_INCOME_35K_49K", points: 18 }, band: "35K_49K" };
  }
  if (monthlyIncome >= 25000) {
    return { points: 12, reason: { code: "MONTHLY_INCOME_25K_34K", points: 12 }, band: "25K_34K" };
  }
  return { points: 6, reason: { code: "MONTHLY_INCOME_UNDER_25K", points: 6 }, band: "UNDER_25K" };
}

function scoreAnnualContribution(annualContribution: number | undefined): {
  points: number;
  reason: FiscalScoreReason;
  band: AnnualContributionBand;
} {
  if (
    typeof annualContribution !== "number" ||
    !Number.isFinite(annualContribution) ||
    annualContribution <= 0
  ) {
    return { points: 0, reason: { code: "ANNUAL_CONTRIBUTION_NONE", points: 0 }, band: "NONE" };
  }
  if (annualContribution >= 180000) {
    return {
      points: 35,
      reason: { code: "ANNUAL_CONTRIBUTION_180K_PLUS", points: 35 },
      band: "180K_PLUS",
    };
  }
  if (annualContribution >= 120000) {
    return {
      points: 30,
      reason: { code: "ANNUAL_CONTRIBUTION_120K_179K", points: 30 },
      band: "120K_179K",
    };
  }
  if (annualContribution >= 60000) {
    return {
      points: 24,
      reason: { code: "ANNUAL_CONTRIBUTION_60K_119K", points: 24 },
      band: "60K_119K",
    };
  }
  if (annualContribution >= 36000) {
    return {
      points: 18,
      reason: { code: "ANNUAL_CONTRIBUTION_36K_59K", points: 18 },
      band: "36K_59K",
    };
  }
  if (annualContribution >= 18000) {
    return {
      points: 12,
      reason: { code: "ANNUAL_CONTRIBUTION_18K_35K", points: 12 },
      band: "18K_35K",
    };
  }
  return {
    points: 6,
    reason: { code: "ANNUAL_CONTRIBUTION_UNDER_18K", points: 6 },
    band: "UNDER_18K",
  };
}

function scoreFilesAnnualReturn(filesAnnualReturn: boolean | undefined): {
  points: number;
  reason: FiscalScoreReason;
} {
  if (filesAnnualReturn === true) {
    return { points: 15, reason: { code: "FILES_ANNUAL_RETURN", points: 15 } };
  }
  return { points: 0, reason: { code: "DOES_NOT_FILE_ANNUAL_RETURN", points: 0 } };
}

function scoreHasPpr(hasPpr: boolean | undefined): { points: number; reason: FiscalScoreReason } {
  if (hasPpr === false) {
    return { points: 10, reason: { code: "NO_EXISTING_PPR", points: 10 } };
  }
  if (hasPpr === true) {
    return { points: 5, reason: { code: "HAS_EXISTING_PPR", points: 5 } };
  }
  return { points: 0, reason: { code: "PPR_STATUS_UNKNOWN", points: 0 } };
}

function classify(score: number): FiscalScoreResult["scoreClass"] {
  if (score >= 70) return "HOT";
  if (score >= 45) return "WARM";
  return "NURTURE";
}

export function scoreFiscalCalculatorLead(input: FiscalScoreInput): FiscalScoreResult {
  const income = scoreMonthlyIncome(input.monthlyIncome);
  const contribution = scoreAnnualContribution(input.annualContribution);
  const filesReturn = scoreFilesAnnualReturn(input.filesAnnualReturn);
  const ppr = scoreHasPpr(input.hasPpr);

  const score = income.points + contribution.points + filesReturn.points + ppr.points;

  return {
    score,
    scoreClass: classify(score),
    version: FISCAL_SCORE_VERSION,
    reasons: [income.reason, contribution.reason, filesReturn.reason, ppr.reason],
    monthlyIncomeBand: income.band,
    annualContributionBand: contribution.band,
  };
}
