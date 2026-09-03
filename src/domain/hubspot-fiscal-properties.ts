import type { FiscalCalculatorNoteInput } from "./fiscal-calculator-lead-note.js";
import type { FiscalScoreClass } from "./fiscal-lead-score.js";

/**
 * Fase 6F -- pure mapping from a fiscal calculator submission (the SAME structured payload
 * already used by formatFiscalCalculatorNote for leads.notes -- reused here, not redefined, per
 * this task's "buscar si ya existe un campo equivalente antes de crear uno nuevo" instruction) to
 * a flat HubSpot Contact `properties` object.
 *
 * Deliberately pure and HTTP-free: no fetch, no HubSpotCRMProvider import, no Lead/domain
 * entities beyond the types above. This is the ONE place that decides exactly which fiscal
 * figures leave Lead Engine and land in HubSpot, so its output is easy to assert on in isolation
 * -- same rationale as formatFiscalCalculatorNote's own doc comment.
 *
 * Identification fields (firstname/lastname/email/phone) and native HubSpot fields (city/state)
 * are DELIBERATELY NOT built here -- those map onto HubSpot's own default/standard contact
 * properties (already exist in every portal, reused rather than shadowed with a bc_fiscal_*
 * duplicate -- see the Fase 6F report, item 5) and are assembled by the caller
 * (HubSpotFiscalSyncService) directly from the Lead entity, which already carries them.
 */

/** Stable internal-name prefix for every custom property this integration owns. Never reuse this
 * prefix for anything unrelated to the fiscal calculator snapshot. */
export const HUBSPOT_FISCAL_PROPERTY_PREFIX = "bc_fiscal_";

/**
 * calcular()'s real output (see impuestos.html) is an estimated MIN-MAX RANGE, never a single
 * point value -- there is no existing "the one exact number" to put in a single bc_fiscal_estimate
 * property without fabricating a reduction the calculator itself doesn't produce (that would
 * violate item 16's "usar el resultado exacto que ya produce la calculadora, NO recalcular").
 * Exposed as two properties instead: bc_fiscal_estimate_min / bc_fiscal_estimate_max, both taken
 * verbatim from calculation.estimatedTaxBenefitMin/Max.
 */
export interface HubSpotFiscalScoreInput {
  score: number;
  scoreClass: FiscalScoreClass;
  version: string;
}

export interface HubSpotFiscalAttributionInput {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  landing_page?: string;
  referrer?: string;
}

export interface HubSpotFiscalPropertiesInput {
  /** Same shape formatFiscalCalculatorNote takes, minus submissionId/submittedAt (passed
   * separately below, since they're also used outside the "note" concept here). */
  fiscalCalculator: Omit<FiscalCalculatorNoteInput, "submissionId" | "submittedAt">;
  submissionId: string;
  calculatedAt: Date;
  /** No existing version tag was found anywhere in the calculator engine (impuestos.html's
   * calcular()/tasaEstimada() carry no version constant) -- see the Fase 6F report, item 16.
   * Falls back to a Lead-Engine-defined literal (PPR_CALCULATOR_DEFAULT_VERSION, below) when the
   * frontend doesn't send one explicitly, so this property is never empty; if impuestos.html is
   * ever updated to send its own, that value passes through unchanged. */
  calculationVersion: string;
  fiscalScore: HubSpotFiscalScoreInput;
  attribution?: HubSpotFiscalAttributionInput;
  source?: string;
  privacyAccepted: boolean;
  privacyAcceptedAt: Date;
  consentContact: boolean;
}

/** Backend-defined literal used only when the caller doesn't supply its own calculationVersion --
 * see HubSpotFiscalPropertiesInput.calculationVersion's doc comment for why this exists. */
export const PPR_CALCULATOR_DEFAULT_VERSION = "ppr_calc_2026_v1";

function sumDeductions(d: { medicalExpenses: number; tuition: number; mortgageInterest: number; other: number }): number {
  return d.medicalExpenses + d.tuition + d.mortgageInterest + d.other;
}

/** Every HubSpot property this function CAN produce (used by tests/documentation to assert the
 * mapping table stays complete). Identification (firstname/lastname/email/phone) and native
 * city/state are intentionally absent -- see the module doc comment. */
export const HUBSPOT_FISCAL_PROPERTY_NAMES = [
  "bc_fiscal_age",
  "bc_fiscal_tax_regime",
  "bc_fiscal_files_annual_return",
  "bc_fiscal_monthly_income",
  "bc_fiscal_annual_income",
  "bc_fiscal_annual_ppr_contribution",
  "bc_fiscal_personal_deductions",
  "bc_fiscal_has_ppr",
  "bc_fiscal_has_gmm",
  "bc_fiscal_estimate_min",
  "bc_fiscal_estimate_max",
  "bc_fiscal_submission_id",
  "bc_fiscal_calculated_at",
  "bc_fiscal_calculation_version",
  "bc_fiscal_score",
  "bc_fiscal_score_class",
  "bc_fiscal_score_version",
  "bc_fiscal_source",
  "bc_fiscal_privacy_accepted",
  "bc_fiscal_privacy_accepted_at",
  "bc_fiscal_consent_contact",
  "bc_fiscal_utm_source",
  "bc_fiscal_utm_medium",
  "bc_fiscal_utm_campaign",
  "bc_fiscal_utm_content",
  "bc_fiscal_utm_term",
  "bc_fiscal_fbclid",
  "bc_fiscal_landing_page",
  "bc_fiscal_referrer",
] as const;

/**
 * Builds the flat `properties` object for a HubSpot Contact upsert from one fiscal calculator
 * submission. Never throws -- every field is either present in `input` (schema-guaranteed by
 * app.ts's fiscalCalculatorSchema) or optional and simply omitted when absent, never fabricated.
 *
 * FORBIDDEN by design (see the Fase 6F report's analytics-firewall / privacy sections): this
 * function's OUTPUT is exactly what leaves this process for HubSpot -- it never receives, and
 * therefore can never leak, a HubSpot API token, a raw HTTP response, or anything beyond the
 * fiscal snapshot fields listed in HUBSPOT_FISCAL_PROPERTY_NAMES above.
 */
export function buildHubSpotFiscalProperties(input: HubSpotFiscalPropertiesInput): Record<string, string | number | boolean> {
  const fc = input.fiscalCalculator;
  const properties: Record<string, string | number | boolean> = {
    bc_fiscal_files_annual_return: fc.filesAnnualReturn ?? false,
    bc_fiscal_monthly_income: fc.monthlyIncome,
    bc_fiscal_annual_income: fc.calculation.annualIncome,
    bc_fiscal_annual_ppr_contribution: fc.annualContribution,
    bc_fiscal_personal_deductions: sumDeductions(fc.deductions),
    bc_fiscal_has_ppr: fc.hasPpr ?? false,
    bc_fiscal_has_gmm: fc.hasGmm ?? false,
    bc_fiscal_estimate_min: fc.calculation.estimatedTaxBenefitMin,
    bc_fiscal_estimate_max: fc.calculation.estimatedTaxBenefitMax,
    bc_fiscal_submission_id: input.submissionId,
    bc_fiscal_calculated_at: input.calculatedAt.toISOString(),
    bc_fiscal_calculation_version: input.calculationVersion,
    bc_fiscal_score: input.fiscalScore.score,
    bc_fiscal_score_class: input.fiscalScore.scoreClass,
    bc_fiscal_score_version: input.fiscalScore.version,
    bc_fiscal_privacy_accepted: input.privacyAccepted,
    bc_fiscal_privacy_accepted_at: input.privacyAcceptedAt.toISOString(),
    bc_fiscal_consent_contact: input.consentContact,
  };
  if (fc.age !== undefined) properties.bc_fiscal_age = fc.age;
  if (fc.taxRegime) properties.bc_fiscal_tax_regime = fc.taxRegime;
  if (input.source) properties.bc_fiscal_source = input.source;

  const a = input.attribution;
  if (a?.utm_source) properties.bc_fiscal_utm_source = a.utm_source;
  if (a?.utm_medium) properties.bc_fiscal_utm_medium = a.utm_medium;
  if (a?.utm_campaign) properties.bc_fiscal_utm_campaign = a.utm_campaign;
  if (a?.utm_content) properties.bc_fiscal_utm_content = a.utm_content;
  if (a?.utm_term) properties.bc_fiscal_utm_term = a.utm_term;
  if (a?.fbclid) properties.bc_fiscal_fbclid = a.fbclid;
  if (a?.landing_page) properties.bc_fiscal_landing_page = a.landing_page;
  if (a?.referrer) properties.bc_fiscal_referrer = a.referrer;

  return properties;
}
