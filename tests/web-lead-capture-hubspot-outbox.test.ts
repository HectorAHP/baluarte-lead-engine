import { describe, it, expect } from "vitest";
import { WebLeadCaptureService } from "../src/application/web-lead-capture.js";
import { HubSpotFiscalSyncService } from "../src/application/hubspot-fiscal-sync-service.js";
import { LeadService } from "../src/application/services.js";
import {
  InMemoryLeadRepository, InMemoryProcessedEventRepository, InMemoryLeadStatusHistoryRepository,
  InMemoryFiscalLeadScoreRepository, InMemoryHubSpotSyncOutboxRepository, InMemoryAtomicFiscalCaptureRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import type { HubSpotCRMProvider, AtomicFiscalCaptureRepository } from "../src/application/ports.js";

const fiscalCalculator = {
  age: 35, city: "León", taxRegime: "sueldos", filesAnnualReturn: true,
  monthlyIncome: 40000, annualContribution: 20000,
  deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
  hasGmm: false, hasPpr: false,
  calculation: { annualIncome: 480000, pprDeductionLimit: 48000, effectivePprContribution: 20000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 2000, estimatedTaxBenefitMax: 3000 },
};

function slowHubSpotCrm(delayMs: number): HubSpotCRMProvider {
  return {
    upsertContact: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { hubspotContactId: "hs-1", created: true };
    },
  };
}

function makeService(hubspotCrm: HubSpotCRMProvider, hubspotOutboxEnabled: boolean, atomicFiscalCapture?: AtomicFiscalCaptureRepository) {
  const leads = new InMemoryLeadRepository();
  const processedEvents = new InMemoryProcessedEventRepository();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const leadService = new LeadService(leads, { create: async () => { throw new Error("unused"); }, listByLeadId: async () => [] }, leadStatusHistory, new FakeLogger());
  const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
  const hubspotOutbox = new InMemoryHubSpotSyncOutboxRepository();
  const hubspotSync = new HubSpotFiscalSyncService(hubspotCrm, new FakeLogger());
  const logger = new FakeLogger();
  const service = new WebLeadCaptureService(
    leads, processedEvents, leadService, logger, fiscalLeadScores, hubspotSync,
    { hubspotOutboxEnabled }, hubspotOutbox, atomicFiscalCapture,
  );
  return { leads, fiscalLeadScores, hubspotOutbox, service, logger };
}

function baseInput(overrides: Partial<Parameters<WebLeadCaptureService["capture"]>[0]> = {}) {
  return {
    submissionId: `sub-${Math.random()}`,
    phone: "4771234567",
    email: `lead-${Math.random()}@example.com`,
    source: "WEB_FISCAL_CALCULATOR",
    consentContact: false,
    privacyAcceptedAt: new Date(),
    fiscalCalculator,
    fiscalCalculatorSnapshot: fiscalCalculator,
    calculationVersion: "ppr_calc_2026_v1",
    ...overrides,
  };
}

describe("Fase 7C -- WebLeadCaptureService HubSpot outbox integration", () => {
  it("item 15: flag ON -- capture() does NOT wait for HubSpot's network round-trip", async () => {
    const { service, hubspotOutbox } = makeService(slowHubSpotCrm(300), true);
    const start = performance.now();
    const result = await service.capture(baseInput());
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(150); // comfortably under the 300ms HubSpot delay
    const entries = await hubspotOutbox.listByStatus("PENDING");
    expect(entries).toHaveLength(1);
    expect(entries[0].leadId).toBe(result.lead.id);
  });

  it("item 26 (performance before/after): flag OFF is measurably slower, bounded by HubSpot's own latency", async () => {
    const { service } = makeService(slowHubSpotCrm(150), false);
    const start = performance.now();
    await service.capture(baseInput());
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeGreaterThanOrEqual(150); // capture() genuinely waited for the slow call
  });

  it("flag OFF (default): byte-for-byte pre-Fase-7C behavior -- inline sync runs, no outbox row is ever written", async () => {
    const { service, hubspotOutbox } = makeService(slowHubSpotCrm(0), false);
    await service.capture(baseInput());
    expect(await hubspotOutbox.listByStatus("PENDING")).toHaveLength(0);
    expect(await hubspotOutbox.listByStatus("SUCCEEDED")).toHaveLength(0); // never written at all, not even completed
  });

  it("item 1 (critical path): lead + fiscal_v1 score persist even when HubSpot is completely unreachable, flag ON", async () => {
    const alwaysFails: HubSpotCRMProvider = { upsertContact: async () => { throw new Error("network down"); } };
    const { service, leads, fiscalLeadScores } = makeService(alwaysFails, true);
    const result = await service.capture(baseInput());
    expect(await leads.findById(result.lead.id)).not.toBeNull();
    expect(await fiscalLeadScores.listByLeadId(result.lead.id)).toHaveLength(1);
  });

  it("item 7 (duplicate POST /api/leads -> one outbox job): the SAME submissionId never schedules two outbox rows", async () => {
    const { service, hubspotOutbox } = makeService(slowHubSpotCrm(0), true);
    const input = baseInput({ submissionId: "fixed-sub-1" });
    await service.capture(input);
    await service.capture(input); // idempotent replay (processed_events)
    expect((await hubspotOutbox.listByStatus("PENDING")).length + (await hubspotOutbox.listByStatus("SUCCEEDED")).length).toBeLessThanOrEqual(1);
  });

  it("the frozen payload matches exactly what the inline path would have sent -- no drift between the two code paths", async () => {
    let inlinePayload: unknown;
    const capturingCrm: HubSpotCRMProvider = {
      upsertContact: async (input) => { inlinePayload = input; return { hubspotContactId: "hs-1", created: true }; },
    };
    const outboxCrm: HubSpotCRMProvider = {
      upsertContact: async () => ({ hubspotContactId: "hs-2", created: true }),
    };
    const input = baseInput({ submissionId: "sub-compare" });

    const { service: inlineService } = makeService(capturingCrm, false);
    await inlineService.capture(input);

    const { service: outboxService, hubspotOutbox } = makeService(outboxCrm, true);
    await outboxService.capture(input); // SAME submissionId -- both paths score the exact same submission
    const [entry] = await hubspotOutbox.listByStatus("PENDING");

    // Same shape, modulo calculatedAt/syncedAt (each path stamps its own fresh `new Date()`,
    // legitimately a few ms apart) -- every other property, including bc_fiscal_submission_id,
    // must be byte-for-byte identical between the two code paths.
    const strip = (p: Record<string, unknown>) => { const { bc_fiscal_calculated_at, bc_fiscal_synced_at, ...rest } = p; return rest; };
    expect(strip(entry.payload.properties)).toEqual(strip((inlinePayload as { properties: Record<string, unknown> }).properties));
  });
});

// Fase 7C.1 §1/§2 -- WebLeadCaptureService wired with a REAL AtomicFiscalCaptureRepository
// (InMemory stand-in here; migration 021's RPC in production/Supabase).
describe("Fase 7C.1 -- WebLeadCaptureService atomic fiscal-score + outbox wiring", () => {
  function makeServiceWithAtomicCapture(hubspotCrm: HubSpotCRMProvider, hubspotOutboxEnabled: boolean) {
    // IMPORTANT: the atomic-capture repository must wrap the SAME fiscalLeadScores/hubspotOutbox
    // instances actually wired into the service (the pre-existing 5th/8th constructor args) --
    // otherwise the OFF-path assertions below would be reading from a disconnected pair of
    // Maps that the service's own inline/pre-7C.1 path never touches.
    const leads = new InMemoryLeadRepository();
    const processedEvents = new InMemoryProcessedEventRepository();
    const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
    const leadService = new LeadService(leads, { create: async () => { throw new Error("unused"); }, listByLeadId: async () => [] }, leadStatusHistory, new FakeLogger());
    const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
    const hubspotOutbox = new InMemoryHubSpotSyncOutboxRepository();
    const hubspotSync = new HubSpotFiscalSyncService(hubspotCrm, new FakeLogger());
    const logger = new FakeLogger();
    const atomicFiscalCapture = new InMemoryAtomicFiscalCaptureRepository(fiscalLeadScores, hubspotOutbox);
    const service = new WebLeadCaptureService(
      leads, processedEvents, leadService, logger, fiscalLeadScores, hubspotSync,
      { hubspotOutboxEnabled }, hubspotOutbox, atomicFiscalCapture,
    );
    return { leads, fiscalLeadScores, hubspotOutbox, service, logger };
  }

  it("flag ON + atomic repo wired: exactly one outbox row is scheduled through the atomic path, never the old two-call path", async () => {
    const { service, hubspotOutbox, fiscalLeadScores, logger } = makeServiceWithAtomicCapture(slowHubSpotCrm(0), true);
    const result = await service.capture(baseInput());

    expect(await fiscalLeadScores.listByLeadId(result.lead.id)).toHaveLength(1);
    const entries = await hubspotOutbox.listByStatus("PENDING");
    expect(entries).toHaveLength(1);
    expect(entries[0].leadId).toBe(result.lead.id);
    const scheduledLog = logger.warnings.find((w) => w.message === "hubspot outbox delivery scheduled");
    expect(scheduledLog).toBeDefined();
    expect((scheduledLog!.details as Record<string, unknown>).outcome).toBe("scheduled");
  });

  it("flag ON + atomic repo wired: a resubmission of the SAME submissionId never creates a second outbox row (idempotent replay)", async () => {
    const { service, hubspotOutbox } = makeServiceWithAtomicCapture(slowHubSpotCrm(0), true);
    const input = baseInput({ submissionId: "fixed-sub-atomic" });
    await service.capture(input);
    await service.capture(input);
    expect(await hubspotOutbox.listByStatus("PENDING")).toHaveLength(1);
  });

  it("flag ON + atomic repo wired: a failure in the atomic write is swallowed -- capture() still succeeds, the lead is still persisted", async () => {
    const leads = new InMemoryLeadRepository();
    const processedEvents = new InMemoryProcessedEventRepository();
    const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
    const leadService = new LeadService(leads, { create: async () => { throw new Error("unused"); }, listByLeadId: async () => [] }, leadStatusHistory, new FakeLogger());
    const hubspotSync = new HubSpotFiscalSyncService(slowHubSpotCrm(0), new FakeLogger());
    const logger = new FakeLogger();
    const failingAtomicCapture: AtomicFiscalCaptureRepository = {
      createFiscalScoreWithOutbox: async () => { throw new Error("simulated atomic RPC failure"); },
    };
    const service = new WebLeadCaptureService(
      leads, processedEvents, leadService, logger, new InMemoryFiscalLeadScoreRepository(), hubspotSync,
      { hubspotOutboxEnabled: true }, new InMemoryHubSpotSyncOutboxRepository(), failingAtomicCapture,
    );

    const result = await service.capture(baseInput()); // must NOT throw -- fiscal scoring failures are always fail-open

    expect(await leads.findById(result.lead.id)).not.toBeNull();
    const failureLog = logger.warnings.find((w) => w.message === "lead fiscal score calculation failed");
    expect(failureLog).toBeDefined();
  });

  it("flag OFF: the atomic repo is wired but NEVER consulted -- falls back to the pre-Fase-7C.1 inline sync path unchanged", async () => {
    let inlineSyncCalled = false;
    const capturingCrm: HubSpotCRMProvider = {
      upsertContact: async () => { inlineSyncCalled = true; return { hubspotContactId: "hs-1", created: true }; },
    };
    const { service, hubspotOutbox, fiscalLeadScores } = makeServiceWithAtomicCapture(capturingCrm, false);
    const result = await service.capture(baseInput());

    expect(inlineSyncCalled).toBe(true); // the OLD inline path ran, not the atomic one
    expect(await fiscalLeadScores.listByLeadId(result.lead.id)).toHaveLength(1);
    expect(await hubspotOutbox.listByStatus("PENDING")).toHaveLength(0); // never written -- outbox disabled
  });
});
