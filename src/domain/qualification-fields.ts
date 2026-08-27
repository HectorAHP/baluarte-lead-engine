export type QualificationVertical = "PATRIMONIAL" | "GMM";

/**
 * The three commercial products the Phase 3 qualifier routes into. SAVINGS and RETIREMENT_PPR
 * both live under the PATRIMONIAL vertical (they share a lead-scoring model and a qualification
 * outcome type) but ask different question catalogs -- this is the finer-grained distinction the
 * conversational qualifier needs that QualificationVertical alone doesn't capture.
 */
export type QualificationProduct = "SAVINGS" | "RETIREMENT_PPR" | "GMM";

export function productVertical(product: QualificationProduct): QualificationVertical {
  return product === "GMM" ? "GMM" : "PATRIMONIAL";
}

export const PATRIMONIAL_QUALIFICATION_FIELDS = [
  "objective",
  "timeline",
  "monthly_capacity",
  "occupation",
  "current_solution",
  "accepts_meeting",
  "age",
  "retirement_target",
  "existing_ppr",
  "existing_investment",
  // Added for the Phase 3 conversational qualifier (SAVINGS + RETIREMENT_PPR catalogs) --
  // additive only, the fields above are kept for backward compatibility even though nothing
  // currently writes them.
  "extra_contributions",
  "urgency",
  "age_range",
  "retirement_objective",
  "fiscal_situation",
] as const;
export type PatrimonialQualificationField = (typeof PATRIMONIAL_QUALIFICATION_FIELDS)[number];

export const GMM_QUALIFICATION_FIELDS = [
  "coverage_type",
  "member_count",
  "ages",
  "city",
  "current_policy",
  "renewal_date_or_new_policy_timing",
  "primary_need",
  "accepts_meeting",
  // Added for the Phase 3 conversational qualifier -- residence is captured as three separate
  // structured fields (never inferred from one another) per the GMM location rules.
  "residence_city",
  "residence_state",
  "postal_code",
  "age_range",
  "has_current_insurance",
  "priority",
  "urgency",
] as const;
export type GmmQualificationField = (typeof GMM_QUALIFICATION_FIELDS)[number];

export function isAllowedQualificationField(vertical: QualificationVertical, fieldName: string): boolean {
  const whitelist: readonly string[] = vertical === "PATRIMONIAL" ? PATRIMONIAL_QUALIFICATION_FIELDS : GMM_QUALIFICATION_FIELDS;
  return whitelist.includes(fieldName);
}
