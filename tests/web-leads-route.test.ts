import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers/test-app.js";

/**
 * Route-level tests for the Baluarte Lead Engine web capture integration (POST /api/leads,
 * extended for baluartecapital.com.mx/impuestos.html -- see web-lead-capture.ts and this task's
 * integration report for the full design rationale).
 */

const validFiscalCalculator = {
  age: 35,
  city: "León",
  taxRegime: "sueldos",
  filesAnnualReturn: true,
  monthlyIncome: 27000,
  annualContribution: 20000,
  deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
  hasGmm: true,
  hasPpr: false,
  calculation: {
    annualIncome: 324000,
    pprDeductionLimit: 32400,
    effectivePprContribution: 20000,
    otherDeductionsConsidered: 0,
    estimatedTaxBenefitMin: 2400,
    estimatedTaxBenefitMax: 3600,
  },
};

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Juan",
    lastName: "Pérez",
    phone: "4771234567",
    email: "juan@example.com",
    source: "WEB_FISCAL_CALCULATOR",
    privacyAccepted: true,
    consentContact: false,
    fiscalCalculator: validFiscalCalculator,
    attribution: { utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "ppr_2026", landing_page: "/impuestos.html", referrer: "directo" },
    ...overrides,
  };
}

describe("POST /api/leads -- web lead capture (fiscal calculator)", () => {
  it("1. creates a new lead on a valid payload, with the correct source and PATRIMONIAL vertical", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" }, payload: basePayload() });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({ ok: true, leadId: expect.any(String) });

    const lookup = await app.inject({ method: "GET", url: `/api/leads/${body.leadId}` });
    const lead = lookup.json();
    expect(lead.source).toBe("WEB_FISCAL_CALCULATOR");
    expect(lead.productVertical).toBe("PATRIMONIAL");
    expect(lead.status).toBe("NEW");
    expect(lead.campaignName).toBe("ppr_2026");
  });

  it("2. a second submission from the same phone number updates the existing lead instead of creating a duplicate", async () => {
    const app = await buildTestApp();
    const first = await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": "22222222-2222-4222-8222-222222222222" }, payload: basePayload() });
    const second = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { "idempotency-key": "33333333-3333-4333-8333-333333333333" }, // different submission, same person
      payload: basePayload({ firstName: "Juan", phone: "4771234567", email: "juan@example.com" }),
    });
    expect(second.statusCode).toBe(200); // matched existing -- not 201
    expect(second.json().leadId).toBe(first.json().leadId);

    const lookup = await app.inject({ method: "GET", url: `/api/leads/${first.json().leadId}` });
    // Notes carry BOTH submissions -- appended, not overwritten.
    expect((lookup.json().notes as string).match(/Calculadora fiscal PPR/g)?.length).toBe(2);
  });

  it("3. resubmitting the exact same Idempotency-Key does not create a second lead or a second notes entry", async () => {
    const app = await buildTestApp();
    const key = "44444444-4444-4444-8444-444444444444";
    const first = await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: basePayload() });
    const replay = await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: basePayload() });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().leadId).toBe(first.json().leadId);

    const lookup = await app.inject({ method: "GET", url: `/api/leads/${first.json().leadId}` });
    expect((lookup.json().notes as string).match(/Calculadora fiscal PPR/g)?.length).toBe(1); // not appended twice
  });

  it("4. rejects a submission with privacyAccepted missing/false", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ privacyAccepted: false }) });
    expect(res.statusCode).toBe(400);
    const withoutField = await app.inject({ method: "POST", url: "/api/leads", payload: { firstName: "Juan", phone: "4771234567" } });
    expect(withoutField.statusCode).toBe(400);
  });

  it("5. accepts a submission with consentContact: false -- marketing consent is never required to capture the lead", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ consentContact: false }) });
    expect(res.statusCode).toBe(201);
    const lookup = await app.inject({ method: "GET", url: `/api/leads/${res.json().leadId}` });
    expect(lookup.json().consentContact).toBe(false);
  });

  it("6. rejects a malformed payload (negative income, out-of-range age, too-short phone) with 400 and no lead created", async () => {
    const app = await buildTestApp();
    const badIncome = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ fiscalCalculator: { ...validFiscalCalculator, monthlyIncome: -5000 } }) });
    expect(badIncome.statusCode).toBe(400);

    const badAge = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ fiscalCalculator: { ...validFiscalCalculator, age: 200 } }) });
    expect(badAge.statusCode).toBe(400);

    const badPhone = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ phone: "123" }) });
    expect(badPhone.statusCode).toBe(400);
  });

  it("7. persists UTM attribution internally (campaignName column + notes), never in the response", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload() });
    expect(Object.keys(res.json())).toEqual(["ok", "leadId"]); // response never echoes attribution/PII/financial data
    const lookup = await app.inject({ method: "GET", url: `/api/leads/${res.json().leadId}` });
    expect(lookup.json().campaignName).toBe("ppr_2026");
    expect(lookup.json().notes).toContain("utm_source: facebook");
  });

  it("8. never logs raw financial figures or PII -- Fastify's request/response logs only carry status/method/url, never the body", async () => {
    const app = await buildTestApp();
    const logs: unknown[] = [];
    app.log.info = ((...args: unknown[]) => { logs.push(args); }) as typeof app.log.info;
    await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ email: "secret-income-test@example.com" }) });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("27000");
    expect(serialized).not.toContain("secret-income-test@example.com");
    expect(serialized).not.toContain("4771234567");
  });

  it("9. a repository failure surfaces as a safe 500 with no internal details, never a stack trace or PII", async () => {
    const app = await buildTestApp({
      leadsRepo: {
        create: async () => { throw new Error("SUPABASE_LEAD_CREATE_FAILED: connection refused to db.internal:5432 user=svc_prod"); },
        findById: async () => null,
        update: async () => { throw new Error("unused"); },
        findByDedupKey: async () => null,
        findByEmail: async () => null,
        findByPhoneE164: async () => null,
      },
    });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload() });
    expect(res.statusCode).toBe(500);
    // Production hardening: POST /api/leads now has its own minimal error shape (ok:false,
    // error:"internal_error"), distinct from the app-wide error handler's {error:"INTERNAL_ERROR"}
    // used by every other route -- see this task's "error responses" requirement.
    expect(res.json()).toEqual({ ok: false, error: "internal_error" });
    expect(JSON.stringify(res.json())).not.toContain("db.internal");
    expect(JSON.stringify(res.json())).not.toContain("svc_prod");
  });

  it("10. matching an existing, already-qualified lead never resets its status, score, or assignedAdvisor", async () => {
    const app = await buildTestApp();
    const created = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload() });
    const leadId = created.json().leadId;
    await app.inject({ method: "POST", url: `/api/leads/${leadId}/contact` });
    await app.inject({ method: "POST", url: `/api/leads/${leadId}/qualification/start` });
    await app.inject({
      method: "POST",
      url: `/api/leads/${leadId}/score`,
      payload: { vertical: "PATRIMONIAL", urgency: "THIS_WEEK", monthlyCapacity: "5000_9999", objectiveDefined: true, hasCurrentSavingsOrInvestment: true, acceptsMeeting: true },
    });
    const beforeSecondSubmission = (await app.inject({ method: "GET", url: `/api/leads/${leadId}` })).json();
    expect(beforeSecondSubmission.status).toBe("QUALIFIED_A");

    await app.inject({ method: "POST", url: "/api/leads", payload: basePayload() }); // same phone/email, resubmits the calculator

    const after = (await app.inject({ method: "GET", url: `/api/leads/${leadId}` })).json();
    expect(after.status).toBe("QUALIFIED_A"); // untouched
    expect(after.score).toBe(beforeSecondSubmission.score); // untouched
    expect(after.assignedAdvisor).toBe("Hector Herrera"); // untouched
  });
});
