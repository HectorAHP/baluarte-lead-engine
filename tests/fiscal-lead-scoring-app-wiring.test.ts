import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { TEST_WHATSAPP_VERIFY_TOKEN, TEST_META_APP_SECRET } from "./helpers/test-app.js";

/**
 * Fase 6A.1 -- pre-deploy wiring guarantee.
 *
 * Every other fiscal-scoring test (fiscal-lead-scoring-integration.test.ts) goes through
 * buildTestApp(), which ALWAYS supplies its own explicit `fiscalLeadScoresRepo` override -- so
 * those tests would keep passing even if src/app.ts's real construction/injection of
 * FiscalLeadScoreRepository silently broke (e.g. a future edit drops the
 * `new WebLeadCaptureService(..., fiscalLeadScoresRepo)` argument, or the
 * `overrides.fiscalLeadScoresRepo ?? (...)` construction line is deleted), because the override
 * would simply never be reached and no test would notice.
 *
 * This test calls buildApp() directly instead -- deliberately WITHOUT a fiscalLeadScoresRepo (or
 * leadsRepo/processedEventsRepo) override -- so it exercises app.ts's REAL default wiring path.
 * `supabaseClient: null` forces that real path to resolve to the InMemory* implementations
 * (this repo's .env genuinely carries live Supabase/Google/Meta credentials -- see
 * tests/test-harness-safety.test.ts -- so this is the only override that keeps this test off
 * production Supabase; calendar/messaging are swapped for the same never-touch-real-services
 * reason, unrelated to what this test is actually proving).
 *
 * WebLeadCaptureService only logs "lead fiscal score calculated" AFTER
 * FiscalLeadScoreRepository.tryCreate() returns a persisted row (see
 * scoreFiscalCalculatorSubmission in web-lead-capture.ts) -- so that log line appearing is direct
 * proof the repository was (1) constructed and (2) actually received and persisted the write,
 * through app.ts's own unmodified wiring, not a test double standing in for it.
 */
describe("Fase 6A.1 -- app.ts wires FiscalLeadScoreRepository into WebLeadCaptureService for real", () => {
  it("a WEB_FISCAL_CALCULATOR lead captured through the real buildApp() wiring persists a fiscal_v1 score", async () => {
    const app = await buildApp({
      supabaseClient: null, // the only override needed to keep this off real Supabase -- see class doc comment
      calendar: new FakeCalendarProvider(),
      messaging: new FakeMessagingProvider(),
      whatsappVerifyToken: TEST_WHATSAPP_VERIFY_TOKEN,
      metaAppSecret: TEST_META_APP_SECRET,
      qualificationEngineEnabled: false,
      whatsappBookingEnabled: false,
      whatsappCancellationEnabled: false,
      whatsappRescheduleEnabled: false,
      // Deliberately NOT overriding leadsRepo / processedEventsRepo / fiscalLeadScoresRepo: this
      // test's entire point is exercising app.ts's own `overrides.fiscalLeadScoresRepo ?? (...)`
      // construction and its injection into `new WebLeadCaptureService(...)`, unmodified.
    });

    const logs: unknown[] = [];
    app.log.warn = ((...args: unknown[]) => { logs.push(args); }) as typeof app.log.warn;

    const res = await app.inject({
      method: "POST",
      url: "/api/leads",
      payload: {
        firstName: "Wiring",
        lastName: "Test",
        phone: "4771515151",
        email: "wiring-test@example.com",
        source: "WEB_FISCAL_CALCULATOR",
        privacyAccepted: true,
        consentContact: false,
        fiscalCalculator: {
          age: 35,
          city: "León",
          taxRegime: "sueldos",
          filesAnnualReturn: true,
          monthlyIncome: 60000,
          annualContribution: 40000,
          deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
          hasGmm: true,
          hasPpr: false,
          calculation: {
            annualIncome: 720000, pprDeductionLimit: 0, effectivePprContribution: 0,
            otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 0, estimatedTaxBenefitMax: 0,
          },
        },
      },
    });

    // The lead capture itself succeeds regardless (fail-open) -- this is the baseline, not the
    // thing under test.
    expect(res.statusCode).toBe(201);

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).toContain("lead fiscal score calculated");
    expect(serializedLogs).toContain("fiscal_v1");
    // Exact financial figures still never leak into the log, even through the real wiring path.
    expect(serializedLogs).not.toContain("60000");
    expect(serializedLogs).not.toContain("40000");
  });
});
