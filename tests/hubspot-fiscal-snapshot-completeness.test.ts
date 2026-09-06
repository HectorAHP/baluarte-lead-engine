import { describe, it, expect } from "vitest";
import { REQUIRED_FISCAL_PROPERTIES, OPTIONAL_FISCAL_PROPERTIES, assessFiscalSnapshotCompleteness } from "../src/domain/hubspot-fiscal-snapshot-completeness.js";
import { HUBSPOT_FISCAL_PROPERTY_NAMES, buildHubSpotFiscalProperties, CALCULATION_VERSION_UNKNOWN } from "../src/domain/hubspot-fiscal-properties.js";

describe("Fase 7C spec §20 -- the real, authoritative expected-property set", () => {
  it("REQUIRED + OPTIONAL partition HUBSPOT_FISCAL_PROPERTY_NAMES exactly -- no drift, no double-count", () => {
    const combined = new Set([...REQUIRED_FISCAL_PROPERTIES, ...OPTIONAL_FISCAL_PROPERTIES]);
    expect(combined.size).toBe(REQUIRED_FISCAL_PROPERTIES.length + OPTIONAL_FISCAL_PROPERTIES.length); // no overlap
    expect([...combined].sort()).toEqual([...HUBSPOT_FISCAL_PROPERTY_NAMES].sort());
  });

  it("the real count is 37 (NOT 33 -- see the Fase 7B/7C reports' correction)", () => {
    expect(HUBSPOT_FISCAL_PROPERTY_NAMES.length).toBe(37);
    expect(REQUIRED_FISCAL_PROPERTIES.length).toBe(26);
    expect(OPTIONAL_FISCAL_PROPERTIES.length).toBe(11);
  });

  it("every REQUIRED property is actually unconditionally produced by buildHubSpotFiscalProperties for a minimal input", () => {
    const properties = buildHubSpotFiscalProperties({
      fiscalCalculator: {
        monthlyIncome: 10000, annualContribution: 5000,
        deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
        calculation: { annualIncome: 120000, pprDeductionLimit: 12000, effectivePprContribution: 5000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 500, estimatedTaxBenefitMax: 800 },
      },
      submissionId: "sub-1",
      calculatedAt: new Date(),
      syncedAt: new Date(),
      calculationVersion: CALCULATION_VERSION_UNKNOWN,
      fiscalScore: { score: 50, scoreClass: "WARM", version: "fiscal_v1" },
      privacyAccepted: true,
      privacyAcceptedAt: new Date(),
      consentContact: false,
    });
    for (const name of REQUIRED_FISCAL_PROPERTIES) {
      expect(properties).toHaveProperty(name);
    }
    // No OPTIONAL property leaks in when its source input was never provided (age/taxRegime/
    // source/attribution all omitted above).
    for (const name of OPTIONAL_FISCAL_PROPERTIES) {
      expect(properties).not.toHaveProperty(name);
    }
  });

  // Fase 7C.1 §10 -- the mirror-image case: EVERY optional source field supplied. This is the test
  // that actually FAILS if the mapper (buildHubSpotFiscalProperties) and the schema
  // (REQUIRED_FISCAL_PROPERTIES/OPTIONAL_FISCAL_PROPERTIES/HUBSPOT_FISCAL_PROPERTY_NAMES) ever
  // drift apart in EITHER direction -- a key set match, not just "every required key is present"
  // (which the minimal-input test above already covers, but would never catch the mapper silently
  // gaining or losing an OPTIONAL property).
  it("with every optional input field populated, the output key set is EXACTLY the full 37 -- no more, no fewer", () => {
    const properties = buildHubSpotFiscalProperties({
      fiscalCalculator: {
        age: 35,
        city: "León",
        taxRegime: "sueldos",
        filesAnnualReturn: true,
        monthlyIncome: 40000,
        annualContribution: 20000,
        deductions: { medicalExpenses: 1000, tuition: 500, mortgageInterest: 0, other: 0 },
        hasGmm: true,
        hasPpr: false,
        calculation: { annualIncome: 480000, pprDeductionLimit: 48000, effectivePprContribution: 20000, otherDeductionsConsidered: 1500, estimatedTaxBenefitMin: 2000, estimatedTaxBenefitMax: 3000 },
      },
      submissionId: "sub-full",
      calculatedAt: new Date(),
      syncedAt: new Date(),
      calculationVersion: "ppr_calc_2026_v1",
      fiscalScore: { score: 90, scoreClass: "HOT", version: "fiscal_v1" },
      attribution: {
        utm_source: "google", utm_medium: "cpc", utm_campaign: "ppr", utm_content: "ad1", utm_term: "retiro",
        fbclid: "fbclid-1", landing_page: "https://baluartecapital.com.mx/impuestos", referrer: "https://google.com",
      },
      source: "WEB_FISCAL_CALCULATOR",
      privacyAccepted: true,
      privacyAcceptedAt: new Date(),
      consentContact: true,
    });

    expect(Object.keys(properties).sort()).toEqual([...HUBSPOT_FISCAL_PROPERTY_NAMES].sort());
  });
});

describe("assessFiscalSnapshotCompleteness", () => {
  it("complete when every REQUIRED property is present and non-empty", () => {
    const complete: Record<string, unknown> = {};
    for (const name of REQUIRED_FISCAL_PROPERTIES) complete[name] = "1";
    expect(assessFiscalSnapshotCompleteness(complete)).toEqual({ complete: true, missingRequired: [] });
  });

  it("incomplete when a required property is missing, null, or empty string", () => {
    const complete: Record<string, unknown> = {};
    for (const name of REQUIRED_FISCAL_PROPERTIES) complete[name] = "1";
    delete complete["bc_fiscal_score"];
    complete["bc_fiscal_monthly_income"] = "";
    complete["bc_fiscal_annual_income"] = null;

    const result = assessFiscalSnapshotCompleteness(complete);
    expect(result.complete).toBe(false);
    expect(result.missingRequired).toEqual(expect.arrayContaining(["bc_fiscal_score", "bc_fiscal_monthly_income", "bc_fiscal_annual_income"]));
  });

  it("a missing OPTIONAL property never affects completeness", () => {
    const complete: Record<string, unknown> = {};
    for (const name of REQUIRED_FISCAL_PROPERTIES) complete[name] = "1";
    // Deliberately no bc_fiscal_age / bc_fiscal_tax_regime / utm_* set at all.
    expect(assessFiscalSnapshotCompleteness(complete).complete).toBe(true);
  });
});
