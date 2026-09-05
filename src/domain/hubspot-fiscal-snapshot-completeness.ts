/**
 * Fase 7C spec §20 -- "NO asumir '33' o '37' a ciegas. Leer hubspot-fiscal-properties.ts y definir
 * el conjunto esperado real." This file IS that reading: every name below is transcribed directly
 * from HUBSPOT_FISCAL_PROPERTY_NAMES / buildHubSpotFiscalProperties's own unconditional-vs-`if`
 * assignments (domain/hubspot-fiscal-properties.ts) -- verified by running
 * HUBSPOT_FISCAL_PROPERTY_NAMES.length directly (37, confirmed at the time this file was written;
 * the Fase 7B/7C reports both cited "33" from an eyeballed count of the array literal, which was
 * wrong -- see the Fase 7C report for the correction). REQUIRED_FISCAL_PROPERTIES +
 * OPTIONAL_FISCAL_PROPERTIES must always partition HUBSPOT_FISCAL_PROPERTY_NAMES exactly -- see
 * the dedicated test that imports both and asserts this, so the two files can never silently drift
 * apart again.
 */
import { HUBSPOT_FISCAL_PROPERTY_NAMES } from "./hubspot-fiscal-properties.js";

/** Every property buildHubSpotFiscalProperties assigns UNCONDITIONALLY -- always present in a
 * successful sync's payload, regardless of what the calculator submission did or didn't include. */
export const REQUIRED_FISCAL_PROPERTIES: readonly string[] = [
  "bc_fiscal_files_annual_return",
  "bc_fiscal_monthly_income",
  "bc_fiscal_annual_income",
  "bc_fiscal_annual_ppr_contribution",
  "bc_fiscal_deduction_medical_expenses",
  "bc_fiscal_deduction_tuition",
  "bc_fiscal_deduction_mortgage_interest",
  "bc_fiscal_deduction_other",
  "bc_fiscal_personal_deductions",
  "bc_fiscal_has_ppr",
  "bc_fiscal_has_gmm",
  "bc_fiscal_ppr_deduction_limit",
  "bc_fiscal_effective_ppr_contribution",
  "bc_fiscal_other_deductions_considered",
  "bc_fiscal_estimate_min",
  "bc_fiscal_estimate_max",
  "bc_fiscal_submission_id",
  "bc_fiscal_calculated_at",
  "bc_fiscal_synced_at",
  "bc_fiscal_calculation_version",
  "bc_fiscal_score",
  "bc_fiscal_score_class",
  "bc_fiscal_score_version",
  "bc_fiscal_privacy_accepted",
  "bc_fiscal_privacy_accepted_at",
  "bc_fiscal_consent_contact",
];

/** Every property buildHubSpotFiscalProperties only assigns `if` present in the submission (age,
 * taxRegime) or the lead's own attribution (source, utm_*, fbclid, landing_page, referrer). Their
 * absence on a real contact is NEVER evidence of an incomplete/failed sync -- a submission simply
 * without e.g. a landing_page never sets bc_fiscal_landing_page, by design. */
export const OPTIONAL_FISCAL_PROPERTIES: readonly string[] = [
  "bc_fiscal_age",
  "bc_fiscal_tax_regime",
  "bc_fiscal_source",
  "bc_fiscal_utm_source",
  "bc_fiscal_utm_medium",
  "bc_fiscal_utm_campaign",
  "bc_fiscal_utm_content",
  "bc_fiscal_utm_term",
  "bc_fiscal_fbclid",
  "bc_fiscal_landing_page",
  "bc_fiscal_referrer",
];

export interface FiscalSnapshotCompletenessResult {
  complete: boolean;
  missingRequired: string[];
}

/**
 * `contactProperties` is whatever a HubSpot Contact read returns -- a property present with an
 * empty string is treated the same as absent (HubSpot's own API does this for cleared properties),
 * never as "present but empty counts as complete".
 */
export function assessFiscalSnapshotCompleteness(contactProperties: Record<string, unknown>): FiscalSnapshotCompletenessResult {
  const missingRequired = REQUIRED_FISCAL_PROPERTIES.filter((name) => {
    const value = contactProperties[name];
    return value === undefined || value === null || value === "";
  });
  return { complete: missingRequired.length === 0, missingRequired };
}
