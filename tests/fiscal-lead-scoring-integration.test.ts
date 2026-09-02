import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers/test-app.js";
import { InMemoryFiscalLeadScoreRepository, InMemoryLeadRepository } from "../src/infrastructure/memory-repositories.js";
import { canProactivelyContactLead } from "../src/domain/contact-eligibility.js";
import { getFiscalLeadContextByPhone } from "../src/application/fiscal-lead-context.js";

/**
 * Fase 6A -- fiscal lead scoring + context bridge integration tests. Exercises
 * WebLeadCaptureService's fiscal_v1 scoring hook end-to-end via POST /api/leads, using a
 * caller-supplied InMemoryFiscalLeadScoreRepository so each test can inspect what was actually
 * persisted -- buildTestApp()'s own default instance is otherwise opaque to a caller.
 */

function fiscalCalculator(overrides: Record<string, unknown> = {}) {
  return {
    age: 35,
    city: "León",
    taxRegime: "sueldos",
    filesAnnualReturn: true,
    monthlyIncome: 160000, // 150K_PLUS -> 40
    annualContribution: 200000, // 180K_PLUS -> 35
    deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
    hasGmm: true,
    hasPpr: false, // NO_EXISTING_PPR -> 10
    calculation: {
      annualIncome: 1920000, pprDeductionLimit: 0, effectivePprContribution: 0,
      otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 0, estimatedTaxBenefitMax: 0,
    },
    ...overrides,
  };
  // filesAnnualReturn:true(15) + income 150K_PLUS(40) + contribution 180K_PLUS(35) + noPpr(10) = 100 -> HOT
}

function payload(phone: string, overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Ana",
    lastName: "García",
    phone,
    email: `${phone}@example.com`,
    source: "WEB_FISCAL_CALCULATOR",
    privacyAccepted: true,
    consentContact: false,
    fiscalCalculator: fiscalCalculator(),
    ...overrides,
  };
}

async function getLead(app: Awaited<ReturnType<typeof buildTestApp>>, leadId: string) {
  const res = await app.inject({ method: "GET", url: `/api/leads/${leadId}` });
  return res.json();
}

describe("Fase 6A -- fiscal lead scoring integration", () => {
  it("1. a fiscal calculator submission creates a lead AND a fiscal_v1 score row", async () => {
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ fiscalLeadScoresRepo });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771111111") });
    expect(res.statusCode).toBe(201);
    const leadId = res.json().leadId;

    const rows = await fiscalLeadScoresRepo.listByLeadId(leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe("fiscal_v1");
    expect(rows[0].leadId).toBe(leadId);

    // Isolation: leads.score / leads.scoreClass (owned by the WhatsApp qualifier) are NEVER
    // written by fiscal scoring -- this is the architectural guarantee migration
    // 017_fiscal_lead_scores.sql's header comment documents.
    const lead = await getLead(app, leadId);
    expect(lead.score).toBe(0);
    expect(lead.scoreClass).toBeUndefined();
  });

  it("2. a HOT-shaped submission (score >= 70) is classified HOT", async () => {
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ fiscalLeadScoresRepo });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4772222222") }); // fiscalCalculator() defaults to 100 pts
    const rows = await fiscalLeadScoresRepo.listByLeadId(res.json().leadId);
    expect(rows[0].score).toBe(100);
    expect(rows[0].scoreClass).toBe("HOT");
  });

  it("3. a WARM-shaped submission (45 <= score < 70) is classified WARM", async () => {
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ fiscalLeadScoresRepo });
    const res = await app.inject({
      method: "POST",
      url: "/api/leads",
      payload: payload("4773333333", {
        fiscalCalculator: fiscalCalculator({ monthlyIncome: 40000, annualContribution: 20000, filesAnnualReturn: true, hasPpr: undefined }), // 18+12+15+0=45
      }),
    });
    const rows = await fiscalLeadScoresRepo.listByLeadId(res.json().leadId);
    expect(rows[0].score).toBe(45);
    expect(rows[0].scoreClass).toBe("WARM");
  });

  it("4. a NURTURE-shaped submission (score < 45) is classified NURTURE", async () => {
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ fiscalLeadScoresRepo });
    const res = await app.inject({
      method: "POST",
      url: "/api/leads",
      payload: payload("4774444444", {
        fiscalCalculator: fiscalCalculator({ monthlyIncome: 0, annualContribution: 0, filesAnnualReturn: false, hasPpr: undefined }), // 0
      }),
    });
    const rows = await fiscalLeadScoresRepo.listByLeadId(res.json().leadId);
    expect(rows[0].score).toBe(0);
    expect(rows[0].scoreClass).toBe("NURTURE");
  });

  it("5. consentContact=false does NOT change the score", async () => {
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ fiscalLeadScoresRepo });
    const withConsent = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4775555551", { consentContact: true }) });
    const withoutConsent = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4775555552", { consentContact: false }) });
    const rowsWith = await fiscalLeadScoresRepo.listByLeadId(withConsent.json().leadId);
    const rowsWithout = await fiscalLeadScoresRepo.listByLeadId(withoutConsent.json().leadId);
    expect(rowsWith[0].score).toBe(rowsWithout[0].score);
    expect(rowsWith[0].scoreClass).toBe(rowsWithout[0].scoreClass);
  });

  it("6. consentContact=false -> contactEligible=false (HOT lead stays HOT, just not contactable)", async () => {
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ fiscalLeadScoresRepo });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4776666666", { consentContact: false }) });
    const leadId = res.json().leadId;
    const lead = await getLead(app, leadId);
    const rows = await fiscalLeadScoresRepo.listByLeadId(leadId);
    expect(rows[0].scoreClass).toBe("HOT");
    expect(canProactivelyContactLead(lead)).toBe(false);
  });

  it("7. consentContact=true -> contactEligible=true", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4777777777", { consentContact: true }) });
    const lead = await getLead(app, res.json().leadId);
    expect(canProactivelyContactLead(lead)).toBe(true);
  });

  it("8. resubmitting the exact same Idempotency-Key does not duplicate scoring/history", async () => {
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ fiscalLeadScoresRepo });
    const key = "88888888-8888-4888-8888-888888888888";
    const first = await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: payload("4778888888") });
    const replay = await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: payload("4778888888") });
    expect(replay.json().leadId).toBe(first.json().leadId);

    const rows = await fiscalLeadScoresRepo.listByLeadId(first.json().leadId);
    expect(rows).toHaveLength(1); // not duplicated
  });

  it("9. a new submissionId for the same lead recalculates fiscal_v1 (new run, new numbers)", async () => {
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ fiscalLeadScoresRepo });
    const phone = "4779999999";
    const first = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { "idempotency-key": "99999999-9999-4999-8999-999999999991" },
      payload: payload(phone, { fiscalCalculator: fiscalCalculator({ monthlyIncome: 0, annualContribution: 0, filesAnnualReturn: false, hasPpr: undefined }) }), // NURTURE, 0 pts
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { "idempotency-key": "99999999-9999-4999-8999-999999999992" }, // different submission, same person
      payload: payload(phone), // fiscalCalculator() default -> 100 pts, HOT
    });
    expect(second.json().leadId).toBe(first.json().leadId); // same lead, not a duplicate

    const rows = await fiscalLeadScoresRepo.listByLeadId(first.json().leadId);
    expect(rows).toHaveLength(2); // history preserved, both runs kept
    const scores = rows.map((r) => r.score).sort((a, b) => a - b);
    expect(scores).toEqual([0, 100]);
  });

  it("10. an existing lead's status/qualification lifecycle is preserved across a fiscal resubmission", async () => {
    const app = await buildTestApp();
    const created = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4770101010") });
    const leadId = created.json().leadId;
    await app.inject({ method: "POST", url: `/api/leads/${leadId}/contact` });
    await app.inject({ method: "POST", url: `/api/leads/${leadId}/qualification/start` });
    await app.inject({
      method: "POST",
      url: `/api/leads/${leadId}/score`,
      payload: { vertical: "PATRIMONIAL", urgency: "THIS_WEEK", monthlyCapacity: "5000_9999", objectiveDefined: true, hasCurrentSavingsOrInvestment: true, acceptsMeeting: true },
    });
    const before = await getLead(app, leadId);
    expect(before.status).toBe("QUALIFIED_A");

    await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { "idempotency-key": "10101010-1010-4101-8101-101010101010" },
      payload: payload("4770101010"), // same phone -- resubmits the fiscal calculator
    });

    const after = await getLead(app, leadId);
    expect(after.status).toBe("QUALIFIED_A"); // untouched by fiscal scoring
    expect(after.score).toBe(before.score); // WhatsApp-engine score untouched
    expect(after.qualifiedAt).toBe(before.qualifiedAt);
  });

  it("11. an existing lead's assignedAdvisor is preserved across a fiscal resubmission", async () => {
    const app = await buildTestApp();
    const created = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4770202020") });
    const leadId = created.json().leadId;
    const before = await getLead(app, leadId);

    await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { "idempotency-key": "20202020-2020-4202-8202-202020202020" },
      payload: payload("4770202020"),
    });

    const after = await getLead(app, leadId);
    expect(after.assignedAdvisor).toBe(before.assignedAdvisor);
  });

  it("12. the WhatsApp context bridge can recover score/context by phone lookup", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ leadsRepo, fiscalLeadScoresRepo });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4770303030") });
    expect(res.statusCode).toBe(201);

    // Same raw phone shape the WhatsApp inbound pipeline would receive (a wa_id-style MX number).
    const context = await getFiscalLeadContextByPhone({ leads: leadsRepo, fiscalLeadScores: fiscalLeadScoresRepo }, "4770303030");
    expect(context).not.toBeNull();
    expect(context?.leadId).toBe(res.json().leadId);
    expect(context?.scoreClass).toBe("HOT");
    expect(context?.scoreVersion).toBe("fiscal_v1");
    expect(context?.monthlyIncomeBand).toBe("150K_PLUS");
    expect(context?.annualContributionBand).toBe("180K_PLUS");
    expect(context?.hasPpr).toBe(false);
    expect(context?.filesAnnualReturn).toBe(true);
  });

  it("12b. the context bridge returns null for a phone with no matching lead", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const context = await getFiscalLeadContextByPhone({ leads: leadsRepo, fiscalLeadScores: fiscalLeadScoresRepo }, "4779990000");
    expect(context).toBeNull();
  });

  it("13. exact financial figures never appear in logs -- only opaque leadId, score, scoreClass, version", async () => {
    const app = await buildTestApp();
    const logs: unknown[] = [];
    app.log.warn = ((...args: unknown[]) => { logs.push(args); }) as typeof app.log.warn;
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771313131") });
    const serialized = JSON.stringify(logs);
    expect(serialized).toContain("lead fiscal score calculated");
    expect(serialized).not.toContain("160000"); // exact monthlyIncome
    expect(serialized).not.toContain("200000"); // exact annualContribution
    expect(serialized).not.toContain("4771313131"); // phone
    expect(serialized).not.toContain("@example.com"); // email
  });

  it("14. a submission with source !== WEB_FISCAL_CALCULATOR does NOT run fiscal_v1 scoring, even with a fiscalCalculator payload present", async () => {
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ fiscalLeadScoresRepo });
    const res = await app.inject({
      method: "POST",
      url: "/api/leads",
      payload: payload("4771414141", { source: "WEB" }),
    });
    expect(res.statusCode).toBe(201);
    const rows = await fiscalLeadScoresRepo.listByLeadId(res.json().leadId);
    expect(rows).toHaveLength(0);
  });
});
