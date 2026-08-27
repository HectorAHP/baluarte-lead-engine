/**
 * Phase 3 conversational-qualifier scoring model. Deliberately separate from scoring.ts
 * (scorePatrimonial/scoreGmm), which is a different, earlier formula still used by the manual
 * `/api/leads/:id/score` endpoint and its own tests -- this module does not replace it.
 *
 * Every result is explicit and auditable: total, a per-category breakdown, a rulesVersion string,
 * and a calculatedAt timestamp. Persisting this (Phase 3B) is a separate decision from
 * calculating it; this module has no repository dependency.
 */
export type ScoreClass = "A" | "B" | "C";
export type Urgency = "THIS_MONTH" | "ONE_TO_THREE_MONTHS" | "COMPARING";
export type MonthlyCapacity = "LT_2000" | "2000_4999" | "5000_9999" | "10000_19999" | "20000_PLUS";
export type ClarityLevel = "CLEAR" | "PARTIAL" | "AMBIGUOUS";
export type EngagementLevel = "ALL_ANSWERED" | "MOST_ANSWERED" | "LOW";
export type ReadinessLevel = "ACCEPTS_MEETING" | "WANTS_INFO_FIRST" | "DECLINES";
export type LocationCompleteness = "COMPLETE" | "PARTIAL" | "NONE";

// Separate version strings per vertical (rather than one shared constant) so either formula can
// evolve independently later without ambiguity about which one changed.
export const PATRIMONIAL_QUALIFICATION_RULES_VERSION = "PATRIMONIAL_QUALIFICATION_V1";
export const GMM_QUALIFICATION_RULES_VERSION = "GMM_QUALIFICATION_V1";

export interface QualificationScoreResult {
  total: number;
  scoreClass: ScoreClass;
  breakdown: Record<string, number>;
  rulesVersion: string;
  calculatedAt: Date;
}

function classify(total: number): ScoreClass {
  return total >= 75 ? "A" : total >= 50 ? "B" : "C";
}

const URGENCY_POINTS: Record<Urgency, number> = { THIS_MONTH: 30, ONE_TO_THREE_MONTHS: 20, COMPARING: 8 };
const CAPACITY_POINTS: Record<MonthlyCapacity, number> = { LT_2000: 7, "2000_4999": 15, "5000_9999": 22, "10000_19999": 26, "20000_PLUS": 30 };
const CLARITY_POINTS_20: Record<ClarityLevel, number> = { CLEAR: 20, PARTIAL: 12, AMBIGUOUS: 5 };
const ENGAGEMENT_POINTS: Record<EngagementLevel, number> = { ALL_ANSWERED: 10, MOST_ANSWERED: 7, LOW: 3 };
const READINESS_POINTS: Record<ReadinessLevel, number> = { ACCEPTS_MEETING: 10, WANTS_INFO_FIRST: 6, DECLINES: 0 };

/**
 * Shared by SAVINGS and RETIREMENT_PPR (both PATRIMONIAL vertical): they ask different
 * questions but score on the identical five-category rubric from the Phase 3 spec.
 */
export interface PatrimonialQualificationScoreInput {
  urgency: Urgency;
  monthlyCapacity: MonthlyCapacity;
  objectiveClarity: ClarityLevel;
  engagement: EngagementLevel;
  readiness: ReadinessLevel;
}

export function scorePatrimonialQualification(input: PatrimonialQualificationScoreInput, now: Date = new Date()): QualificationScoreResult {
  const breakdown = {
    urgency: URGENCY_POINTS[input.urgency],
    monthlyCapacity: CAPACITY_POINTS[input.monthlyCapacity],
    productFitClarity: CLARITY_POINTS_20[input.objectiveClarity],
    engagement: ENGAGEMENT_POINTS[input.engagement],
    readiness: READINESS_POINTS[input.readiness],
  };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { total, scoreClass: classify(total), breakdown, rulesVersion: PATRIMONIAL_QUALIFICATION_RULES_VERSION, calculatedAt: now };
}

/**
 * GMM has no artificial "monthly capacity" question (the spec explicitly forbids asking one
 * just to feed scoring), so the 30-point economic-fit slot is replaced by two GMM-specific
 * signals that still total 30: locationCompleteness (10) + insuranceGapSignal (20, since a lead
 * with no current policy is a more urgent opportunity than one comparing a renewal). The
 * remaining categories mirror the shared rubric. No medical information is used anywhere here.
 */
export interface GmmQualificationScoreInput {
  urgency: Urgency;
  needClarity: ClarityLevel;
  locationCompleteness: LocationCompleteness;
  hasCurrentInsurance: boolean | "UNKNOWN";
  engagement: EngagementLevel;
  readiness: ReadinessLevel;
}

const LOCATION_COMPLETENESS_POINTS: Record<LocationCompleteness, number> = { COMPLETE: 10, PARTIAL: 5, NONE: 0 };

function insuranceGapPoints(hasCurrentInsurance: boolean | "UNKNOWN"): number {
  if (hasCurrentInsurance === "UNKNOWN") return 6;
  return hasCurrentInsurance ? 12 : 20;
}

export function scoreGmmQualification(input: GmmQualificationScoreInput, now: Date = new Date()): QualificationScoreResult {
  const breakdown = {
    urgency: URGENCY_POINTS[input.urgency],
    needClarity: CLARITY_POINTS_20[input.needClarity],
    locationCompleteness: LOCATION_COMPLETENESS_POINTS[input.locationCompleteness],
    insuranceGapSignal: insuranceGapPoints(input.hasCurrentInsurance),
    engagement: ENGAGEMENT_POINTS[input.engagement],
    readiness: READINESS_POINTS[input.readiness],
  };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { total, scoreClass: classify(total), breakdown, rulesVersion: GMM_QUALIFICATION_RULES_VERSION, calculatedAt: now };
}
