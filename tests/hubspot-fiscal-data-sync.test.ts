import { describe, expect, it, vi, afterEach } from "vitest";
import { buildTestApp } from "./helpers/test-app.js";
import { FakeHubSpotCRMProvider } from "../src/infrastructure/fake-hubspot-crm-provider.js";
import { RealHubSpotCRMProvider } from "../src/infrastructure/hubspot-crm-provider.js";
import { InMemoryFiscalLeadScoreRepository, InMemoryAppointmentRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { HubSpotFiscalSyncService } from "../src/application/hubspot-fiscal-sync-service.js";
import { CALCULATION_VERSION_UNKNOWN } from "../src/domain/hubspot-fiscal-properties.js";
import { LIA_IDENTITY } from "../src/domain/lia-identity.js";

/**
 * Fase 6F -- HubSpot fiscal data sync tests. Covers the 32 scenarios listed in the task's
 * "24. TESTS" section (numbered 1-32 below, matching that list one-for-one).
 *
 * Every test injects its OWN FakeHubSpotCRMProvider explicitly (never relies on
 * buildTestApp()'s default instance) so it can inspect exactly what was sent -- same convention
 * as fiscalLeadScoresRepo throughout fiscal-lead-scoring-integration.test.ts.
 */

function fiscalCalculator(overrides: Record<string, unknown> = {}) {
  return {
    age: 35,
    city: "León",
    taxRegime: "sueldos",
    filesAnnualReturn: true,
    monthlyIncome: 160000,
    annualContribution: 200000,
    deductions: { medicalExpenses: 1000, tuition: 2000, mortgageInterest: 500, other: 250 },
    hasGmm: true,
    hasPpr: false,
    calculation: {
      annualIncome: 1920000, pprDeductionLimit: 213973.2, effectivePprContribution: 200000,
      otherDeductionsConsidered: 3750, estimatedTaxBenefitMin: 48000, estimatedTaxBenefitMax: 72000,
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

describe("Fase 6F -- HubSpot fiscal data sync", () => {
  it("1. a new fiscal calculator submission creates/syncs a HubSpot contact", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000001", "sync1@example.com") });
    expect(res.statusCode).toBe(201);
    expect(hubspotCrm.contacts).toHaveLength(1);
    expect(hubspotCrm.contacts[0].email).toBe("sync1@example.com");
  });

  it("2. an existing lead's resubmission updates the SAME HubSpot contact, never a duplicate", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const phone = "4771000002", email = "sync2@example.com";
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": "20000000-0000-4000-8000-000000000001" }, payload: payload(phone, email) });
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": "20000000-0000-4000-8000-000000000002" }, payload: payload(phone, email) });
    expect(hubspotCrm.contacts).toHaveLength(1);
    expect(hubspotCrm.calls).toHaveLength(2);
  });

  it("3. the exact same submission (idempotency-key replay) does not duplicate or re-call HubSpot", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const key = "30000000-0000-4000-8000-000000000003";
    const p = payload("4771000003", "sync3@example.com");
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: p });
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: p });
    expect(hubspotCrm.contacts).toHaveLength(1);
    expect(hubspotCrm.calls).toHaveLength(1); // replay never re-calls HubSpot -- see HubSpotFiscalSyncService's class doc comment
  });

  it("4. a new submission for the same lead updates the last snapshot on the same contact", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const phone = "4771000004", email = "sync4@example.com";
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": "40000000-0000-4000-8000-000000000001" }, payload: payload(phone, email, { fiscalCalculator: fiscalCalculator({ monthlyIncome: 30000 }) }) });
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": "40000000-0000-4000-8000-000000000002" }, payload: payload(phone, email, { fiscalCalculator: fiscalCalculator({ monthlyIncome: 90000 }) }) });
    expect(hubspotCrm.contacts).toHaveLength(1);
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_monthly_income).toBe(90000); // latest wins
  });

  it("5. monthlyIncome is mapped exactly", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000005", "sync5@example.com", { fiscalCalculator: fiscalCalculator({ monthlyIncome: 77777 }) }) });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_monthly_income).toBe(77777);
  });

  it("6. annualIncome (derived) is mapped when present", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000006", "sync6@example.com", { fiscalCalculator: fiscalCalculator({ calculation: { ...fiscalCalculator().calculation, annualIncome: 933444 } }) }) });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_annual_income).toBe(933444);
  });

  it("7. the exact PPR contribution is mapped", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000007", "sync7@example.com", { fiscalCalculator: fiscalCalculator({ annualContribution: 55555 }) }) });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_annual_ppr_contribution).toBe(55555);
  });

  it("8. exact personal deductions (summed) are mapped", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4771000008", "sync8@example.com", { fiscalCalculator: fiscalCalculator({ deductions: { medicalExpenses: 1000, tuition: 2000, mortgageInterest: 3000, other: 4000 } }) }),
    });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_personal_deductions).toBe(10000);
  });

  it("9. tax regime is mapped", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000009", "sync9@example.com", { fiscalCalculator: fiscalCalculator({ taxRegime: "resico" }) }) });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_tax_regime).toBe("resico");
  });

  it("10. filesAnnualReturn is mapped", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000010", "sync10@example.com", { fiscalCalculator: fiscalCalculator({ filesAnnualReturn: false }) }) });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_files_annual_return).toBe(false);
  });

  it("11. hasPpr is mapped", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000011", "sync11@example.com", { fiscalCalculator: fiscalCalculator({ hasPpr: true }) }) });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_has_ppr).toBe(true);
  });

  it("12. hasGmm is mapped", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000012", "sync12@example.com", { fiscalCalculator: fiscalCalculator({ hasGmm: false }) }) });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_has_gmm).toBe(false);
  });

  it("13. the fiscal result (min/max) is mapped exactly, unmodified from the calculator's own output", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4771000013", "sync13@example.com", { fiscalCalculator: fiscalCalculator({ calculation: { ...fiscalCalculator().calculation, estimatedTaxBenefitMin: 11111, estimatedTaxBenefitMax: 22222 } }) }),
    });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_estimate_min).toBe(11111);
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_estimate_max).toBe(22222);
  });

  it("14. the fiscal_v1 score is mapped", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    // filesAnnualReturn:true(15) + income 150K_PLUS(40) + contribution 180K_PLUS(35) + noPpr(10) = 100 -> HOT
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000014", "sync14@example.com") });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_score).toBe(100);
  });

  it("15. HOT/WARM/NURTURE scoreClass is mapped", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4771000015", "sync15@example.com", { fiscalCalculator: fiscalCalculator({ monthlyIncome: 0, annualContribution: 0, filesAnnualReturn: false, hasPpr: undefined }) }),
    });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_score_class).toBe("NURTURE");
  });

  it("16. submissionId is mapped", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const key = "16000000-0000-4000-8000-000000000016";
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: payload("4771000016", "sync16@example.com") });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_submission_id).toBe(key);
  });

  it("17. calculationVersion is mapped -- falls back to the honest CALCULATION_VERSION_UNKNOWN placeholder when the caller doesn't send one, passes through when it does", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000017", "sync17a@example.com") });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_calculation_version).toBe(CALCULATION_VERSION_UNKNOWN);

    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4771000018", "sync17b@example.com", { fiscalCalculator: fiscalCalculator({ calculationVersion: "ppr_calc_2027_v2" }) }),
    });
    const contact = hubspotCrm.contacts.find((c) => c.email === "sync17b@example.com");
    expect(contact?.properties.bc_fiscal_calculation_version).toBe("ppr_calc_2027_v2");
  });

  it("18. scoreVersion (fiscal_v1) is mapped", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000019", "sync19@example.com") });
    expect(hubspotCrm.contacts[0].properties.bc_fiscal_score_version).toBe("fiscal_v1");
  });

  it("19. attribution (UTMs) is mapped", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4771000020", "sync20@example.com", {
        attribution: { utm_source: "facebook", utm_medium: "cpc", utm_campaign: "ppr-2026", utm_content: "ad1", utm_term: "ahorro", landing_page: "/impuestos", referrer: "https://facebook.com" },
      }),
    });
    const props = hubspotCrm.contacts[0].properties;
    expect(props.bc_fiscal_utm_source).toBe("facebook");
    expect(props.bc_fiscal_utm_medium).toBe("cpc");
    expect(props.bc_fiscal_utm_campaign).toBe("ppr-2026");
    expect(props.bc_fiscal_utm_content).toBe("ad1");
    expect(props.bc_fiscal_utm_term).toBe("ahorro");
    expect(props.bc_fiscal_landing_page).toBe("/impuestos");
    expect(props.bc_fiscal_referrer).toBe("https://facebook.com");
  });

  it("20. privacy consent (accepted + timestamp) is mapped", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000021", "sync21@example.com") });
    const props = hubspotCrm.contacts[0].properties;
    expect(props.bc_fiscal_privacy_accepted).toBe(true);
    expect(typeof props.bc_fiscal_privacy_accepted_at).toBe("string");
  });

  it("21. contact (marketing) consent is mapped", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000022", "sync22a@example.com", { consentContact: true }) });
    await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000023", "sync22b@example.com", { consentContact: false }) });
    expect(hubspotCrm.contacts.find((c) => c.email === "sync22a@example.com")?.properties.bc_fiscal_consent_contact).toBe(true);
    expect(hubspotCrm.contacts.find((c) => c.email === "sync22b@example.com")?.properties.bc_fiscal_consent_contact).toBe(false);
  });

  it("22. a HubSpot failure never loses the lead (fail-open) -- lead and fiscal_v1 score persist normally", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    hubspotCrm.shouldFail = true;
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ hubspotCrm, fiscalLeadScoresRepo });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000024", "sync24@example.com") });
    expect(res.statusCode).toBe(201);
    const lead = await getLead(app, res.json().leadId);
    expect(lead.id).toBe(res.json().leadId);
    const rows = await fiscalLeadScoresRepo.listByLeadId(res.json().leadId);
    expect(rows).toHaveLength(1);
  });

  it("23. HubSpot credentials are never logged, even on failure", async () => {
    const fakeToken = "pat-na1-SECRET-TOKEN-abc123";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    try {
      const provider = new RealHubSpotCRMProvider(fakeToken);
      const logger = new FakeLogger();
      const service = new HubSpotFiscalSyncService(provider, logger);
      const lead = { id: "lead-1234-abcd", email: "secure@example.com", phoneE164: "+524770000000", firstName: "Sec", lastName: "Ure", source: "WEB_FISCAL_CALCULATOR" } as never;
      await service.syncFiscalCalculatorLead({
        lead,
        submissionId: "23000000-0000-4000-8000-000000000023",
        fiscalCalculator: fiscalCalculator(),
        fiscalScore: { score: 50, scoreClass: "WARM", version: "fiscal_v1" },
        consentContact: true,
        privacyAcceptedAt: new Date(),
        calculatedAt: new Date(),
      });
      const serialized = JSON.stringify(logger.warnings);
      expect(serialized).not.toContain(fakeToken);
      expect(serialized).not.toContain("Bearer");
      expect(serialized).toContain("error"); // hubspotOutcome: "error" was logged
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("24. exact financial figures never appear in logs during a fiscal calculator submission (HubSpot sync included)", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const logs: unknown[] = [];
    app.log.warn = ((...args: unknown[]) => { logs.push(args); }) as typeof app.log.warn;
    await app.inject({
      method: "POST", url: "/api/leads",
      payload: payload("4771000025", "sync25@example.com", { fiscalCalculator: fiscalCalculator({ monthlyIncome: 313131, annualContribution: 424242 }) }),
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("313131");
    expect(serialized).not.toContain("424242");
    expect(serialized).not.toContain("sync25@example.com");
  });

  it("25. existing POST /api/leads idempotency (unrelated to HubSpot) remains intact", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const key = "25000000-0000-4000-8000-000000000025";
    const first = await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: payload("4771000026", "sync26@example.com") });
    const replay = await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: payload("4771000026", "sync26@example.com") });
    expect(replay.json().leadId).toBe(first.json().leadId);
    expect(replay.statusCode).toBe(200);
  });

  it("26. contact dedupe by normalized email (provider-level, mirrors RealHubSpotCRMProvider's search order)", async () => {
    const provider = new FakeHubSpotCRMProvider();
    const first = await provider.upsertContact({ email: "dedupe@example.com", phone: "+524771111111", properties: { bc_fiscal_score: 10 } });
    const second = await provider.upsertContact({ email: "dedupe@example.com", phone: "+524772222222", properties: { bc_fiscal_score: 20 } }); // different phone, same email
    expect(second.hubspotContactId).toBe(first.hubspotContactId);
    expect(provider.contacts).toHaveLength(1);
  });

  it("27. contact dedupe by normalized phone when no email match exists", async () => {
    const provider = new FakeHubSpotCRMProvider();
    const first = await provider.upsertContact({ email: "phoneA@example.com", phone: "+524773333333", properties: { bc_fiscal_score: 10 } });
    const second = await provider.upsertContact({ phone: "+524773333333", properties: { bc_fiscal_score: 30 } }); // no email at all -- must fall back to phone
    expect(second.hubspotContactId).toBe(first.hubspotContactId);
    expect(provider.contacts).toHaveLength(1);
    expect(provider.contacts[0].properties.bc_fiscal_score).toBe(30); // latest write wins
  });

  it("28. a retry (same submissionId) does not duplicate the HubSpot contact", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const key = "28000000-0000-4000-8000-000000000028";
    const p = payload("4771000028", "sync28@example.com");
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: p });
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: p }); // retry
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload: p }); // retry again
    expect(hubspotCrm.contacts).toHaveLength(1);
  });

  it("29. a HubSpot error does not change the fiscal_v1 score that was already persisted", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    hubspotCrm.shouldFail = true;
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ hubspotCrm, fiscalLeadScoresRepo });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000029", "sync29@example.com") });
    const rows = await fiscalLeadScoresRepo.listByLeadId(res.json().leadId);
    expect(rows[0].score).toBe(100);
    expect(rows[0].scoreClass).toBe("HOT");
    expect(rows[0].version).toBe("fiscal_v1");
  });

  it("30. a HubSpot error does not change the lead's WhatsApp lifecycle status/score", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    hubspotCrm.shouldFail = true;
    const app = await buildTestApp({ hubspotCrm });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000030", "sync30@example.com") });
    const lead = await getLead(app, res.json().leadId);
    expect(lead.status).toBe("NEW");
    expect(lead.score).toBe(0);
    expect(lead.scoreClass).toBeUndefined();
  });

  it("31. Lía's identity is untouched by this phase", () => {
    // Direct, literal proof this branch never modified Lía's copy -- the full Fase 6E test suite
    // (18 tests, whatsapp-lia-conversation-experience.test.ts) also still passes unmodified.
    expect(LIA_IDENTITY).toBe("Lía, asistente de Baluarte Capital");
  });

  it("32. Calendar/booking is untouched -- a fiscal calculator submission never creates an appointment", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const appointmentsRepo = new InMemoryAppointmentRepository();
    const app = await buildTestApp({ hubspotCrm, appointmentsRepo });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: payload("4771000031", "sync31@example.com") });
    const appointments = await appointmentsRepo.listAllByLeadId(res.json().leadId);
    expect(appointments).toHaveLength(0);
  });
});

describe("Fase 6F -- HubSpotFiscalSyncService not-configured no-op", () => {
  afterEach(() => vi.restoreAllMocks());

  it("silently does nothing when hubspot is undefined (no credentials configured)", async () => {
    const logger = new FakeLogger();
    const service = new HubSpotFiscalSyncService(undefined, logger);
    const lead = { id: "lead-x", email: "noop@example.com", source: "WEB_FISCAL_CALCULATOR" } as never;
    await expect(
      service.syncFiscalCalculatorLead({
        lead,
        submissionId: "sub-1",
        fiscalCalculator: fiscalCalculator(),
        fiscalScore: { score: 10, scoreClass: "NURTURE", version: "fiscal_v1" },
        consentContact: false,
        privacyAcceptedAt: new Date(),
        calculatedAt: new Date(),
      }),
    ).resolves.toBeUndefined();
    expect(logger.warnings).toHaveLength(0);
  });
});
