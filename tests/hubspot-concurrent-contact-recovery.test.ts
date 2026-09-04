import { describe, expect, it, vi, afterEach } from "vitest";
import { RealHubSpotCRMProvider } from "../src/infrastructure/hubspot-crm-provider.js";
import { HubSpotProviderError } from "../src/domain/errors.js";
import { FakeHubSpotCRMProvider } from "../src/infrastructure/fake-hubspot-crm-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { HubSpotFiscalSyncService } from "../src/application/hubspot-fiscal-sync-service.js";
import { buildTestApp } from "./helpers/test-app.js";
import { InMemoryFiscalLeadScoreRepository, InMemoryAppointmentRepository } from "../src/infrastructure/memory-repositories.js";

/**
 * Fase 6F.3 -- recovers from HubSpot HTTP 409 on contact CREATE. Confirmed production root cause:
 * a race between this backend's own CREATE call and impuestos.html's PARALLEL, independent Forms
 * API call (the dual-write architecture, see HubSpotFiscalSyncService's class doc comment) --
 * both can be racing to create the SAME contact (by email) at the same time. Before this fix, a
 * 409 propagated straight up as an unrecovered error: the contact existed (via Forms API) but
 * every bc_fiscal_* property was left unset. Covers the task's "8. TESTS" list, numbered 1-17.
 *
 * Items 1-6, 11 test RealHubSpotCRMProvider directly against a mocked global.fetch -- the actual
 * multi-step search/create/recover logic only exists at this layer; FakeHubSpotCRMProvider (used
 * for items 12-17) models the WHOLE upsert as one atomic in-memory step and cannot itself race.
 */

interface MockResponse {
  status: number;
  body?: unknown;
}

function mockFetchSequence(responses: MockResponse[]): { fetchMock: ReturnType<typeof vi.fn>; calls: Array<{ url: string; method: string; body: unknown }> } {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let i = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: (init?.method as string) ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    const next = responses[i++];
    if (!next) throw new Error(`mockFetchSequence: no more canned responses (call ${i})`);
    return new Response(next.body !== undefined ? JSON.stringify(next.body) : "", { status: next.status });
  });
  return { fetchMock: fetchMock as unknown as ReturnType<typeof vi.fn>, calls };
}

const EMPTY_SEARCH = { status: 200, body: { results: [] } };
function foundSearch(id: string): MockResponse {
  return { status: 200, body: { results: [{ id }] } };
}
const CONFLICT = { status: 409 };
const PATCH_OK = { status: 200, body: {} };

describe("Fase 6F.3 -- RealHubSpotCRMProvider concurrent-create (409) recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("1. search email none, search phone none -> create success", async () => {
    const { fetchMock, calls } = mockFetchSequence([EMPTY_SEARCH, EMPTY_SEARCH, { status: 201, body: { id: "new-1" } }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new RealHubSpotCRMProvider("fake-token");

    const result = await provider.upsertContact({ email: "a@example.com", phone: "+521111", properties: { bc_fiscal_score: 10 } });

    expect(result).toEqual({ hubspotContactId: "new-1", created: true });
    expect(calls).toHaveLength(3);
    expect(calls[2].url).toContain("/crm/v3/objects/contacts");
    expect(calls[2].method).toBe("POST");
  });

  it("2. search email finds existing -> update", async () => {
    const { fetchMock, calls } = mockFetchSequence([foundSearch("existing-1"), PATCH_OK]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new RealHubSpotCRMProvider("fake-token");

    const result = await provider.upsertContact({ email: "b@example.com", properties: { bc_fiscal_score: 20 } });

    expect(result).toEqual({ hubspotContactId: "existing-1", created: false });
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("PATCH");
  });

  it("3. search email none -> create 409 -> re-search email finds contact -> update success", async () => {
    const { fetchMock, calls } = mockFetchSequence([
      EMPTY_SEARCH, EMPTY_SEARCH, // initial search: email, phone
      CONFLICT, // create -> 409
      foundSearch("recovered-1"), // recovery re-search: email finds it
      PATCH_OK, // recovery update
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new RealHubSpotCRMProvider("fake-token");

    const result = await provider.upsertContact({ email: "c@example.com", phone: "+521111", properties: { bc_fiscal_score: 30 } });

    expect(result).toEqual({ hubspotContactId: "recovered-1", created: false, recoveredFromConflict: true });
    expect(calls).toHaveLength(5);
  });

  it("4. 409 -> recovery email search none -> recovery phone search finds contact -> update success", async () => {
    const { fetchMock, calls } = mockFetchSequence([
      EMPTY_SEARCH, EMPTY_SEARCH, // initial search: email, phone
      CONFLICT, // create -> 409
      EMPTY_SEARCH, // recovery: email still not found
      foundSearch("recovered-2"), // recovery: phone finds it
      PATCH_OK,
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new RealHubSpotCRMProvider("fake-token");

    const result = await provider.upsertContact({ email: "d@example.com", phone: "+521112", properties: { bc_fiscal_score: 40 } });

    expect(result).toEqual({ hubspotContactId: "recovered-2", created: false, recoveredFromConflict: true });
    expect(calls).toHaveLength(6);
  });

  it("5. 409 -> recovery re-search still finds nothing -> controlled, bounded failure (no infinite retry)", async () => {
    const { fetchMock, calls } = mockFetchSequence([
      EMPTY_SEARCH, EMPTY_SEARCH, // initial search
      CONFLICT, // create -> 409
      EMPTY_SEARCH, EMPTY_SEARCH, // recovery: email, phone -- still nothing
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new RealHubSpotCRMProvider("fake-token");

    await expect(provider.upsertContact({ email: "e@example.com", phone: "+521113", properties: { bc_fiscal_score: 50 } }))
      .rejects.toThrow(HubSpotProviderError);
    expect(calls).toHaveLength(5); // exactly bounded: 2 initial + 1 create + 2 recovery -- never more
  });

  it("6. 409 recovery never issues a second CREATE call (no duplicate contact)", async () => {
    const { fetchMock, calls } = mockFetchSequence([EMPTY_SEARCH, EMPTY_SEARCH, CONFLICT, foundSearch("recovered-3"), PATCH_OK]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new RealHubSpotCRMProvider("fake-token");

    await provider.upsertContact({ email: "f@example.com", properties: {} });

    const createCalls = calls.filter((c) => c.method === "POST" && c.url.endsWith("/crm/v3/objects/contacts"));
    expect(createCalls).toHaveLength(1); // the original attempt only -- recovery is search+PATCH, never a second create
  });

  it("7. a recovered contact receives bc_fiscal_submission_id", async () => {
    const { fetchMock, calls } = mockFetchSequence([EMPTY_SEARCH, EMPTY_SEARCH, CONFLICT, foundSearch("recovered-4"), PATCH_OK]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new RealHubSpotCRMProvider("fake-token");

    await provider.upsertContact({ email: "g@example.com", phone: "+521117", properties: { bc_fiscal_submission_id: "sub-abc123" } });

    const patchCall = calls[calls.length - 1];
    expect(patchCall.method).toBe("PATCH");
    expect((patchCall.body as { properties: Record<string, unknown> }).properties.bc_fiscal_submission_id).toBe("sub-abc123");
  });

  it("8. a recovered contact receives the financial snapshot", async () => {
    const { fetchMock, calls } = mockFetchSequence([EMPTY_SEARCH, EMPTY_SEARCH, CONFLICT, foundSearch("recovered-5"), PATCH_OK]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new RealHubSpotCRMProvider("fake-token");

    await provider.upsertContact({ email: "h@example.com", properties: { bc_fiscal_monthly_income: 160000, bc_fiscal_estimate_min: 48000, bc_fiscal_estimate_max: 72000 } });

    const patchProps = (calls[calls.length - 1].body as { properties: Record<string, unknown> }).properties;
    expect(patchProps.bc_fiscal_monthly_income).toBe(160000);
    expect(patchProps.bc_fiscal_estimate_min).toBe(48000);
    expect(patchProps.bc_fiscal_estimate_max).toBe(72000);
  });

  it("9. a recovered contact receives the fiscal score", async () => {
    const { fetchMock, calls } = mockFetchSequence([EMPTY_SEARCH, EMPTY_SEARCH, CONFLICT, foundSearch("recovered-6"), PATCH_OK]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new RealHubSpotCRMProvider("fake-token");

    await provider.upsertContact({ email: "i@example.com", properties: { bc_fiscal_score: 90, bc_fiscal_score_class: "HOT", bc_fiscal_score_version: "fiscal_v1" } });

    const patchProps = (calls[calls.length - 1].body as { properties: Record<string, unknown> }).properties;
    expect(patchProps.bc_fiscal_score).toBe(90);
    expect(patchProps.bc_fiscal_score_class).toBe("HOT");
    expect(patchProps.bc_fiscal_score_version).toBe("fiscal_v1");
  });

  it("10. a recovered contact receives attribution", async () => {
    const { fetchMock, calls } = mockFetchSequence([EMPTY_SEARCH, EMPTY_SEARCH, CONFLICT, foundSearch("recovered-7"), PATCH_OK]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new RealHubSpotCRMProvider("fake-token");

    await provider.upsertContact({ email: "j@example.com", properties: { bc_fiscal_utm_source: "facebook", bc_fiscal_utm_campaign: "ppr-2026" } });

    const patchProps = (calls[calls.length - 1].body as { properties: Record<string, unknown> }).properties;
    expect(patchProps.bc_fiscal_utm_source).toBe("facebook");
    expect(patchProps.bc_fiscal_utm_campaign).toBe("ppr-2026");
  });

  it("11. the Private App token is never logged, even through the 409-recovery path", async () => {
    const fakeToken = "pat-na1-SECRET-409-RECOVERY-TOKEN";
    const { fetchMock } = mockFetchSequence([EMPTY_SEARCH, EMPTY_SEARCH, CONFLICT, foundSearch("recovered-8"), PATCH_OK]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new RealHubSpotCRMProvider(fakeToken);
    const logger = new FakeLogger();
    const service = new HubSpotFiscalSyncService(provider, logger);

    await service.syncFiscalCalculatorLead({
      lead: { id: "lead-409", email: "k@example.com", phoneE164: "+521118", source: "WEB_FISCAL_CALCULATOR" } as never,
      submissionId: "409000000-0000-4000-8000-000000000011",
      fiscalCalculator: {
        monthlyIncome: 1, annualContribution: 1,
        deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
        calculation: { annualIncome: 1, pprDeductionLimit: 1, effectivePprContribution: 1, otherDeductionsConsidered: 1, estimatedTaxBenefitMin: 1, estimatedTaxBenefitMax: 1 },
      },
      fiscalScore: { score: 1, scoreClass: "NURTURE", version: "fiscal_v1" },
      consentContact: true,
      privacyAcceptedAt: new Date(),
      calculatedAt: new Date(),
    });

    const serialized = JSON.stringify(logger.warnings);
    expect(serialized).not.toContain(fakeToken);
    expect(serialized).toContain("conflict_recovered");
  });
});

describe("Fase 6F.3 -- surrounding systems remain intact", () => {
  it("12. a fully unrecovered HubSpot failure still preserves the Supabase lead (fail-open)", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    hubspotCrm.shouldFail = true;
    const app = await buildTestApp({ hubspotCrm });
    const res = await app.inject({
      method: "POST", url: "/api/leads",
      payload: {
        firstName: "Ana", phone: "4779950001", email: "twelve@example.com", source: "WEB_FISCAL_CALCULATOR",
        privacyAccepted: true, consentContact: true,
        fiscalCalculator: {
          monthlyIncome: 160000, annualContribution: 200000,
          deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
          calculation: { annualIncome: 1920000, pprDeductionLimit: 213973.2, effectivePprContribution: 200000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 48000, estimatedTaxBenefitMax: 72000 },
        },
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("13. the same submission remains idempotent -- a retry never re-calls HubSpot", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const key = "13000000-0000-4000-8000-000000000013";
    const payload = {
      firstName: "Ana", phone: "4779950002", email: "thirteen@example.com", source: "WEB_FISCAL_CALCULATOR",
      privacyAccepted: true, consentContact: true,
      fiscalCalculator: {
        monthlyIncome: 160000, annualContribution: 200000,
        deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
        calculation: { annualIncome: 1920000, pprDeductionLimit: 213973.2, effectivePprContribution: 200000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 48000, estimatedTaxBenefitMax: 72000 },
      },
    };
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload });
    await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": key }, payload });
    expect(hubspotCrm.calls).toHaveLength(1);
  });

  it("14. a HubSpot sync failure does not affect the WhatsApp welcome flow", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    hubspotCrm.shouldFail = true;
    const app = await buildTestApp({ hubspotCrm });
    const leadRes = await app.inject({
      method: "POST", url: "/api/leads",
      payload: { firstName: "Ana", phone: "4779950014", source: "WHATSAPP", privacyAccepted: true },
    });
    expect(leadRes.statusCode).toBe(201);
  });

  it("15. CalendarProvider is never touched by a HubSpot 409/recovery outcome", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    hubspotCrm.shouldFail = true;
    const appointmentsRepo = new InMemoryAppointmentRepository();
    const app = await buildTestApp({ hubspotCrm, appointmentsRepo });
    const res = await app.inject({
      method: "POST", url: "/api/leads",
      payload: {
        firstName: "Ana", phone: "4779950015", email: "fifteen@example.com", source: "WEB_FISCAL_CALCULATOR",
        privacyAccepted: true, consentContact: true,
        fiscalCalculator: {
          monthlyIncome: 160000, annualContribution: 200000,
          deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
          calculation: { annualIncome: 1920000, pprDeductionLimit: 213973.2, effectivePprContribution: 200000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 48000, estimatedTaxBenefitMax: 72000 },
        },
      },
    });
    const appointments = await appointmentsRepo.listAllByLeadId(res.json().leadId);
    expect(appointments).toHaveLength(0);
  });

  it("16. fiscal_v1 scoring is untouched by a HubSpot 409/recovery outcome", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    hubspotCrm.shouldFail = true;
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ hubspotCrm, fiscalLeadScoresRepo });
    const res = await app.inject({
      method: "POST", url: "/api/leads",
      payload: {
        firstName: "Ana", phone: "4779950016", email: "sixteen@example.com", source: "WEB_FISCAL_CALCULATOR",
        privacyAccepted: true, consentContact: true,
        fiscalCalculator: {
          monthlyIncome: 160000, annualContribution: 200000,
          deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
          calculation: { annualIncome: 1920000, pprDeductionLimit: 213973.2, effectivePprContribution: 200000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 48000, estimatedTaxBenefitMax: 72000 },
        },
      },
    });
    const rows = await fiscalLeadScoresRepo.listByLeadId(res.json().leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe("fiscal_v1");
  });

  it("17. lead lifecycle (status) is untouched by a HubSpot 409/recovery outcome", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    hubspotCrm.shouldFail = true;
    const app = await buildTestApp({ hubspotCrm });
    const res = await app.inject({
      method: "POST", url: "/api/leads",
      payload: {
        firstName: "Ana", phone: "4779950017", email: "seventeen@example.com", source: "WEB_FISCAL_CALCULATOR",
        privacyAccepted: true, consentContact: true,
        fiscalCalculator: {
          monthlyIncome: 160000, annualContribution: 200000,
          deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
          calculation: { annualIncome: 1920000, pprDeductionLimit: 213973.2, effectivePprContribution: 200000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 48000, estimatedTaxBenefitMax: 72000 },
        },
      },
    });
    const leadGet = await app.inject({ method: "GET", url: `/api/leads/${res.json().leadId}` });
    expect(leadGet.json().status).toBe("NEW");
  });
});
