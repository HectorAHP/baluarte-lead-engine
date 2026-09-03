import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers/test-app.js";
import { FakeHubSpotCRMProvider } from "../src/infrastructure/fake-hubspot-crm-provider.js";
import { InMemoryFiscalLeadScoreRepository, InMemoryAppointmentRepository } from "../src/infrastructure/memory-repositories.js";
import { CALCULATION_VERSION_UNKNOWN } from "../src/domain/hubspot-fiscal-properties.js";
import { LIA_IDENTITY } from "../src/domain/lia-identity.js";

/**
 * Fase 6F.1 -- HubSpot fiscal snapshot hardening tests (task's "7. TESTS" section, numbered 1-13
 * below to match). Complements tests/hubspot-fiscal-data-sync.test.ts (Fase 6F's own 32 tests,
 * still passing unmodified) rather than replacing it.
 */

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
    ...overrides,
  };
}

async function getLead(app: Awaited<ReturnType<typeof buildTestApp>>, leadId: string) {
  const res = await app.inject({ method: "GET", url: `/api/leads/${leadId}` });
  return res.json();
}

describe("Fase 6F.1 -- HubSpot fiscal snapshot hardening", () => {
  it("1. each of the 4 exact deduction inputs is mapped to its own property", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4772000001", "hard1@example.com", { fiscalCalculator: fiscalCalculator({ deductions: { medicalExpenses: 100, tuition: 200, mortgageInterest: 300, other: 400 } }) }),
    });
    const props = hubspotCrm.contacts[0].properties;
    expect(props.bc_fiscal_deduction_medical_expenses).toBe(100);
    expect(props.bc_fiscal_deduction_tuition).toBe(200);
    expect(props.bc_fiscal_deduction_mortgage_interest).toBe(300);
    expect(props.bc_fiscal_deduction_other).toBe(400);
  });

  it("1b. the total (bc_fiscal_personal_deductions) is kept ALONGSIDE the 4 individual properties, not instead of them", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4772000002", "hard2@example.com", { fiscalCalculator: fiscalCalculator({ deductions: { medicalExpenses: 10, tuition: 20, mortgageInterest: 30, other: 40 } }) }),
    });
    const props = hubspotCrm.contacts[0].properties;
    expect(props.bc_fiscal_personal_deductions).toBe(100);
    expect(props.bc_fiscal_deduction_medical_expenses).toBe(10);
  });

  it("1c. all-zero deductions map to exact zeros, never omitted/undefined", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4772000003", "hard3@example.com", { fiscalCalculator: fiscalCalculator({ deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 } }) }),
    });
    const props = hubspotCrm.contacts[0].properties;
    expect(props.bc_fiscal_deduction_medical_expenses).toBe(0);
    expect(props.bc_fiscal_deduction_tuition).toBe(0);
    expect(props.bc_fiscal_deduction_mortgage_interest).toBe(0);
    expect(props.bc_fiscal_deduction_other).toBe(0);
    expect(props.bc_fiscal_personal_deductions).toBe(0);
  });

  it("2. bc_fiscal_calculated_at reflects the AUTHORITATIVE submission timestamp, not the HubSpot sync moment", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const before = new Date();
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4772000004", "hard4@example.com") });
    const after = new Date();
    expect(res.statusCode).toBe(201);

    const calculatedAt = new Date(hubspotCrm.contacts[0].properties.bc_fiscal_calculated_at as string);
    expect(calculatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(calculatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("3. bc_fiscal_synced_at is a SEPARATE property from bc_fiscal_calculated_at, both present, never confused", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4772000005", "hard5@example.com") });
    const props = hubspotCrm.contacts[0].properties;
    expect(props.bc_fiscal_calculated_at).toBeDefined();
    expect(props.bc_fiscal_synced_at).toBeDefined();
    // syncedAt is generated strictly after calculatedAt in the real request flow (sync happens
    // after lead + fiscal_v1 persistence -- see HubSpotFiscalSyncService's class doc comment).
    const calculatedAt = new Date(props.bc_fiscal_calculated_at as string).getTime();
    const syncedAt = new Date(props.bc_fiscal_synced_at as string).getTime();
    expect(syncedAt).toBeGreaterThanOrEqual(calculatedAt);
  });

  it("4. calculationVersion falls back to the honest CALCULATION_VERSION_UNKNOWN placeholder, never a fabricated engine version, and is never fiscal_v1", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4772000006", "hard6@example.com") });
    const props = hubspotCrm.contacts[0].properties;
    expect(props.bc_fiscal_calculation_version).toBe(CALCULATION_VERSION_UNKNOWN);
    expect(props.bc_fiscal_calculation_version).not.toBe("fiscal_v1");
  });

  it("5. bc_fiscal_score_version (fiscal_v1) and bc_fiscal_calculation_version are always kept separate, never equal for the same submission", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4772000007", "hard7@example.com", { fiscalCalculator: fiscalCalculator({ calculationVersion: "ppr_calc_2027_v3" }) }),
    });
    const props = hubspotCrm.contacts[0].properties;
    expect(props.bc_fiscal_score_version).toBe("fiscal_v1");
    expect(props.bc_fiscal_calculation_version).toBe("ppr_calc_2027_v3");
    expect(props.bc_fiscal_score_version).not.toBe(props.bc_fiscal_calculation_version);
  });

  it("6. the snapshot is complete enough to reconstruct the calculator's exact result: intermediate/capped values are present, verbatim from the engine", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4772000008", "hard8@example.com", {
        fiscalCalculator: fiscalCalculator({
          calculation: {
            annualIncome: 999999, pprDeductionLimit: 55555, effectivePprContribution: 44444,
            otherDeductionsConsidered: 3333, estimatedTaxBenefitMin: 11111, estimatedTaxBenefitMax: 22222,
          },
        }),
      }),
    });
    const props = hubspotCrm.contacts[0].properties;
    expect(props.bc_fiscal_annual_income).toBe(999999);
    expect(props.bc_fiscal_ppr_deduction_limit).toBe(55555);
    expect(props.bc_fiscal_effective_ppr_contribution).toBe(44444);
    expect(props.bc_fiscal_other_deductions_considered).toBe(3333);
    expect(props.bc_fiscal_estimate_min).toBe(11111);
    expect(props.bc_fiscal_estimate_max).toBe(22222);
    // Never recomputed: the min/max are the SAME numbers the calculator itself produced, not a
    // HubSpot-side derivation -- see the domain module's doc comment.
  });

  it("7. no financial figures leak into logs during a hardened snapshot sync", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const logs: unknown[] = [];
    app.log.warn = ((...args: unknown[]) => { logs.push(args); }) as typeof app.log.warn;
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4772000009", "hard9@example.com", { fiscalCalculator: fiscalCalculator({ deductions: { medicalExpenses: 515151, tuition: 0, mortgageInterest: 0, other: 0 } }) }),
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("515151");
    expect(serialized).not.toContain("hard9@example.com");
  });

  it("8. HubSpot failure remains fail-open with the hardened snapshot (lead + fiscal_v1 unaffected)", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    hubspotCrm.shouldFail = true;
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ hubspotCrm, fiscalLeadScoresRepo });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4772000010", "hard10@example.com") });
    expect(res.statusCode).toBe(201);
    const rows = await fiscalLeadScoresRepo.listByLeadId(res.json().leadId);
    expect(rows).toHaveLength(1);
  });

  it("9. idempotency remains intact -- a retry never duplicates the contact or its snapshot", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const key = "90000000-0000-4000-8000-000000000009";
    const p = payload("4772000011", "hard11@example.com");
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: p });
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: p });
    expect(hubspotCrm.contacts).toHaveLength(1);
    expect(hubspotCrm.calls).toHaveLength(1);
  });

  it("10. Lía's identity remains untouched", () => {
    expect(LIA_IDENTITY).toBe("Lía, asistente de Baluarte Capital");
  });

  it("11. Calendar/booking remains untouched -- no appointment is created by a fiscal submission", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const appointmentsRepo = new InMemoryAppointmentRepository();
    const app = await buildTestApp({ hubspotCrm, appointmentsRepo });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4772000012", "hard12@example.com") });
    const appointments = await appointmentsRepo.listAllByLeadId(res.json().leadId);
    expect(appointments).toHaveLength(0);
  });

  it("12. WhatsApp lifecycle (status/score/scoreClass) remains untouched by the hardened snapshot sync", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4772000013", "hard13@example.com") });
    const lead = await getLead(app, res.json().leadId);
    expect(lead.status).toBe("NEW");
    expect(lead.score).toBe(0);
    expect(lead.scoreClass).toBeUndefined();
  });

  it("13. fiscal_v1 scoring output is unaffected by the snapshot hardening changes", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ hubspotCrm, fiscalLeadScoresRepo });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4772000014", "hard14@example.com") });
    const rows = await fiscalLeadScoresRepo.listByLeadId(res.json().leadId);
    expect(rows[0].version).toBe("fiscal_v1");
    expect(rows[0].scoreClass).toBe("HOT");
  });
});
