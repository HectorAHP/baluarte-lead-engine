import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers/test-app.js";
import { FakeHubSpotCRMProvider } from "../src/infrastructure/fake-hubspot-crm-provider.js";
import { InMemoryFiscalLeadScoreRepository } from "../src/infrastructure/memory-repositories.js";
import { CALCULATION_VERSION_UNKNOWN } from "../src/domain/hubspot-fiscal-properties.js";

/**
 * Fase 6F.2 -- calculationVersion now originates in impuestos.html itself
 * (FISCAL_CALCULATION_VERSION = "ppr_calc_2026_v1", set once next to UMA_ANUAL_2026/
 * LIMITE_5_UMAS, sent as fiscalCalculator.calculationVersion in buildLeadEnginePayload). The
 * backend keeps doing exactly what it did in Fase 6F.1: transport that value verbatim, or fall
 * back to CALCULATION_VERSION_UNKNOWN ("unknown") for a legacy submission that omits it -- NEVER
 * invent a version of its own. This file covers the task's "6. TESTS" list (numbered below).
 */

const REAL_FRONTEND_VERSION = "ppr_calc_2026_v1"; // must match impuestos.html's own FISCAL_CALCULATION_VERSION literal

function fiscalCalculator(overrides: Record<string, unknown> = {}) {
  return {
    age: 35,
    city: "León",
    taxRegime: "sueldos",
    filesAnnualReturn: true,
    monthlyIncome: 160000,
    annualContribution: 200000,
    deductions: { medicalExpenses: 1111, tuition: 2222, mortgageInterest: 3333, other: 4444 },
    hasGmm: true,
    hasPpr: false,
    calculation: {
      annualIncome: 1920000, pprDeductionLimit: 213973.2, effectivePprContribution: 200000,
      otherDeductionsConsidered: 11110, estimatedTaxBenefitMin: 48000, estimatedTaxBenefitMax: 72000,
    },
    ...overrides,
  };
}

function payload(phone: string, email: string, overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Ana",
    lastName: "García",
    phone,
    email,
    source: "WEB_FISCAL_CALCULATOR",
    privacyAccepted: true,
    consentContact: true,
    fiscalCalculator: fiscalCalculator(),
    attribution: { utm_source: "facebook", utm_medium: "cpc", utm_campaign: "ppr-2026" },
    ...overrides,
  };
}

describe("Fase 6F.2 -- calculator version originates in impuestos.html, backend only transports it", () => {
  it("1. a new-shape submission (sends calculationVersion, mirroring impuestos.html's own FISCAL_CALCULATION_VERSION) uses ppr_calc_2026_v1", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4773000001", "ver1@example.com", { fiscalCalculator: fiscalCalculator({ calculationVersion: REAL_FRONTEND_VERSION }) }),
    });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_calculation_version).toBe("ppr_calc_2026_v1");
  });

  it("2. a legacy-shaped submission (no calculationVersion field at all, exactly what impuestos.html sent before Fase 6F.2) falls back to the honest 'unknown' placeholder", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4773000002", "ver2@example.com", { fiscalCalculator: fiscalCalculator() }), // no calculationVersion key
    });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_calculation_version).toBe(CALCULATION_VERSION_UNKNOWN);
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_calculation_version).toBe("unknown");
  });

  it("3. bc_fiscal_score_version is still always fiscal_v1, unaffected by calculationVersion", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4773000003", "ver3@example.com", { fiscalCalculator: fiscalCalculator({ calculationVersion: REAL_FRONTEND_VERSION }) }),
    });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_score_version).toBe("fiscal_v1");
  });

  it("4. calculationVersion and scoreVersion are never equal, for both the new and legacy shapes", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4773000004", "ver4a@example.com", { fiscalCalculator: fiscalCalculator({ calculationVersion: REAL_FRONTEND_VERSION }) }),
    });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4773000005", "ver4b@example.com") });

    const withVersion = hubspotCrm.contacts.find((c) => c.email === "ver4a@example.com")!.properties;
    const legacy = hubspotCrm.contacts.find((c) => c.email === "ver4b@example.com")!.properties;
    expect(withVersion.bc_fiscal_calculation_version).not.toBe(withVersion.bc_fiscal_score_version);
    expect(legacy.bc_fiscal_calculation_version).not.toBe(legacy.bc_fiscal_score_version);
  });

  it("5. the fiscal_v1 scoring numeric output is byte-identical regardless of calculationVersion being present or absent -- confirms no formula was touched", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ hubspotCrm, fiscalLeadScoresRepo });
    const withVersion = await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4773000006", "ver5a@example.com", { fiscalCalculator: fiscalCalculator({ calculationVersion: REAL_FRONTEND_VERSION }) }),
    });
    const withoutVersion = await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4773000007", "ver5b@example.com"),
    });
    const rowsWith = await fiscalLeadScoresRepo.listByLeadId(withVersion.json().leadId);
    const rowsWithout = await fiscalLeadScoresRepo.listByLeadId(withoutVersion.json().leadId);
    expect(rowsWith[0].score).toBe(rowsWithout[0].score);
    expect(rowsWith[0].scoreClass).toBe(rowsWithout[0].scoreClass);
  });

  it("6. the full snapshot (all fields from the task's item 3 checklist) is present on a new-shape submission", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4773000008", "ver6@example.com", { fiscalCalculator: fiscalCalculator({ calculationVersion: REAL_FRONTEND_VERSION }) }),
    });
    const p = hubspotCrm.contacts[0].properties;
    expect(p.bc_fiscal_calculation_version).toBe("ppr_calc_2026_v1");
    expect(p.bc_fiscal_calculated_at).toBeDefined();
    expect(p.bc_fiscal_deduction_medical_expenses).toBe(1111);
    expect(p.bc_fiscal_deduction_tuition).toBe(2222);
    expect(p.bc_fiscal_deduction_mortgage_interest).toBe(3333);
    expect(p.bc_fiscal_deduction_other).toBe(4444);
    expect(p.bc_fiscal_personal_deductions).toBe(11110);
    expect(p.bc_fiscal_annual_income).toBe(1920000);
    expect(p.bc_fiscal_ppr_deduction_limit).toBe(213973.2);
    expect(p.bc_fiscal_effective_ppr_contribution).toBe(200000);
    expect(p.bc_fiscal_other_deductions_considered).toBe(11110);
    expect(p.bc_fiscal_estimate_min).toBe(48000);
    expect(p.bc_fiscal_estimate_max).toBe(72000);
    expect(p.bc_fiscal_score).toBe(100);
    expect(p.bc_fiscal_score_class).toBe("HOT");
    expect(p.bc_fiscal_score_version).toBe("fiscal_v1");
    expect(p.bc_fiscal_utm_source).toBe("facebook");
    expect(p.bc_fiscal_utm_medium).toBe("cpc");
    expect(p.bc_fiscal_utm_campaign).toBe("ppr-2026");
    expect(p.bc_fiscal_privacy_accepted).toBe(true);
    expect(p.bc_fiscal_privacy_accepted_at).toBeDefined();
    expect(p.bc_fiscal_consent_contact).toBe(true);
  });

  it("7. idempotency remains intact with the new calculationVersion field in the payload", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const key = "70000000-0000-4000-8000-000000000007";
    const p = payload("4773000009", "ver7@example.com", { fiscalCalculator: fiscalCalculator({ calculationVersion: REAL_FRONTEND_VERSION }) });
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: p });
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: p });
    expect(hubspotCrm.contacts).toHaveLength(1);
    expect(hubspotCrm.calls).toHaveLength(1);
  });

  it("8. HubSpot fail-open remains intact with the new calculationVersion field in the payload", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    hubspotCrm.shouldFail = true;
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ hubspotCrm, fiscalLeadScoresRepo });
    const res = await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4773000010", "ver8@example.com", { fiscalCalculator: fiscalCalculator({ calculationVersion: REAL_FRONTEND_VERSION }) }),
    });
    expect(res.statusCode).toBe(201);
    const rows = await fiscalLeadScoresRepo.listByLeadId(res.json().leadId);
    expect(rows).toHaveLength(1);
  });

  it("9. calculationVersion is not a financial figure and is safe to travel to HubSpot -- confirmed alongside the existing no-financial-leak guarantee in logs", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const logs: unknown[] = [];
    app.log.warn = ((...args: unknown[]) => { logs.push(args); }) as typeof app.log.warn;
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4773000011", "ver9@example.com", { fiscalCalculator: fiscalCalculator({ calculationVersion: REAL_FRONTEND_VERSION, monthlyIncome: 626262 }) }),
    });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_calculation_version).toBe("ppr_calc_2026_v1");
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("626262");
    expect(serialized).not.toContain("ver9@example.com");
  });

  it("10. does not break existing /api/leads behavior for a payload with no fiscalCalculator at all (plain manual lead)", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const res = await app.inject({
      method: "POST", url: "/api/leads",
      payload: { firstName: "Plain", phone: "4773000012", email: "plain@example.com", source: "WEB", privacyAccepted: true },
    });
    expect(res.statusCode).toBe(201);
    expect(hubspotCrm.contacts).toHaveLength(0); // not a fiscal calculator submission -- no HubSpot sync triggered
  });
});
