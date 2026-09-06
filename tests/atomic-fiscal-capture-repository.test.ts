import { describe, it, expect } from "vitest";
import {
  InMemoryFiscalLeadScoreRepository, InMemoryHubSpotSyncOutboxRepository, InMemoryAtomicFiscalCaptureRepository,
} from "../src/infrastructure/memory-repositories.js";
import type { AtomicFiscalScoreWithOutboxInput } from "../src/application/ports.js";
import type { HubSpotSyncOutboxRepository } from "../src/application/ports.js";
import type { HubSpotSyncOutboxEntry } from "../src/domain/hubspot-sync-outbox.js";

function sampleInput(overrides: Partial<AtomicFiscalScoreWithOutboxInput> = {}): AtomicFiscalScoreWithOutboxInput {
  return {
    leadId: "lead-1",
    submissionId: "sub-1",
    score: 80,
    scoreClass: "HOT",
    version: "fiscal_v1",
    reasons: [{ code: "HIGH_INCOME", points: 50 }],
    monthlyIncomeBand: "25K_34K",
    annualContributionBand: "UNDER_18K",
    hasPpr: false,
    filesAnnualReturn: true,
    outbox: { contactEmail: "a@example.com", contactPhone: "+521111", payload: { email: "a@example.com", phone: "+521111", properties: { bc_fiscal_score: 80 } } },
    ...overrides,
  };
}

/**
 * Fase 7C.1 §1 -- these tests exercise AtomicFiscalCaptureRepository (the interface migration
 * 021's create_fiscal_score_with_outbox RPC implements atomically in real Postgres). The
 * InMemory implementation under test here is explicitly NOT a crash-atomicity stand-in (see its
 * own class doc comment) -- these tests confirm its LOGICAL contract (outbox iff a genuinely new
 * fiscal score) and, deliberately, ALSO demonstrate where the in-memory model's guarantee ends,
 * so the difference from the real RPC is never overstated again.
 */
describe("AtomicFiscalCaptureRepository (InMemory)", () => {
  it("a genuinely new submission creates BOTH the fiscal score row and the outbox row", async () => {
    const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
    const hubspotOutbox = new InMemoryHubSpotSyncOutboxRepository();
    const repo = new InMemoryAtomicFiscalCaptureRepository(fiscalLeadScores, hubspotOutbox);

    const result = await repo.createFiscalScoreWithOutbox(sampleInput());

    expect(result).toEqual({ fiscalScoreCreated: true, outboxCreated: true });
    expect(await fiscalLeadScores.listByLeadId("lead-1")).toHaveLength(1);
    expect(await hubspotOutbox.listByStatus("PENDING")).toHaveLength(1);
  });

  it("outbox: undefined creates ONLY the fiscal score row -- the outbox table is never touched", async () => {
    const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
    const hubspotOutbox = new InMemoryHubSpotSyncOutboxRepository();
    const repo = new InMemoryAtomicFiscalCaptureRepository(fiscalLeadScores, hubspotOutbox);

    const result = await repo.createFiscalScoreWithOutbox(sampleInput({ outbox: undefined }));

    expect(result).toEqual({ fiscalScoreCreated: true, outboxCreated: false });
    expect(await fiscalLeadScores.listByLeadId("lead-1")).toHaveLength(1);
    expect(await hubspotOutbox.listByStatus("PENDING")).toHaveLength(0);
  });

  it("an idempotent replay of the SAME (leadId, submissionId) creates neither row again", async () => {
    const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
    const hubspotOutbox = new InMemoryHubSpotSyncOutboxRepository();
    const repo = new InMemoryAtomicFiscalCaptureRepository(fiscalLeadScores, hubspotOutbox);

    const first = await repo.createFiscalScoreWithOutbox(sampleInput());
    const second = await repo.createFiscalScoreWithOutbox(sampleInput());

    expect(first).toEqual({ fiscalScoreCreated: true, outboxCreated: true });
    expect(second).toEqual({ fiscalScoreCreated: false, outboxCreated: false });
    expect(await fiscalLeadScores.listByLeadId("lead-1")).toHaveLength(1);
    expect(await hubspotOutbox.listByStatus("PENDING")).toHaveLength(1);
  });

  it("never schedules an outbox row for an idempotent replay, even if a caller mistakenly supplies `outbox` again", async () => {
    const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
    const hubspotOutbox = new InMemoryHubSpotSyncOutboxRepository();
    const repo = new InMemoryAtomicFiscalCaptureRepository(fiscalLeadScores, hubspotOutbox);

    await repo.createFiscalScoreWithOutbox(sampleInput());
    const replay = await repo.createFiscalScoreWithOutbox(sampleInput({ submissionId: "sub-1" })); // same key, outbox supplied again

    expect(replay.outboxCreated).toBe(false);
    expect(await hubspotOutbox.listByStatus("PENDING")).toHaveLength(1); // still exactly one, never a second
  });

  it("a DIFFERENT submissionId for the same lead is a genuinely new row, not a replay", async () => {
    const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
    const hubspotOutbox = new InMemoryHubSpotSyncOutboxRepository();
    const repo = new InMemoryAtomicFiscalCaptureRepository(fiscalLeadScores, hubspotOutbox);

    await repo.createFiscalScoreWithOutbox(sampleInput({ submissionId: "sub-1" }));
    const second = await repo.createFiscalScoreWithOutbox(sampleInput({ submissionId: "sub-2" }));

    expect(second).toEqual({ fiscalScoreCreated: true, outboxCreated: true });
    expect(await fiscalLeadScores.listByLeadId("lead-1")).toHaveLength(2);
  });

  // Fase 7C.1 §1 -- failure-injection: fiscal score succeeds, outbox write fails.
  describe("failure injection: fiscal score succeeds, outbox write fails", () => {
    it("HONEST LIMITATION: the InMemory repository does NOT roll back the fiscal score row -- only the real Postgres RPC (migration 021) provides that guarantee", async () => {
      const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
      const failingOutbox: HubSpotSyncOutboxRepository = {
        tryCreate: async () => { throw new Error("simulated outbox insert failure"); },
        findById: async () => null,
        findByLeadAndSubmission: async () => null,
        claimBatch: async () => [],
        update: async (): Promise<HubSpotSyncOutboxEntry> => { throw new Error("unused"); },
        listByStatus: async () => [],
      };
      const repo = new InMemoryAtomicFiscalCaptureRepository(fiscalLeadScores, failingOutbox);

      await expect(repo.createFiscalScoreWithOutbox(sampleInput())).rejects.toThrow("simulated outbox insert failure");

      // The fiscal score row IS still there -- this is exactly the silent-gap failure mode Fase
      // 7C.1 identifies: with two independent stores (or two independent Supabase calls), a
      // failure on the SECOND write can never undo the first. This is precisely why migration
      // 021's RPC exists -- a real Postgres transaction rolls BOTH inserts back together on any
      // error inside the function body, which this InMemory stand-in structurally cannot do.
      expect(await fiscalLeadScores.listByLeadId("lead-1")).toHaveLength(1);
    });
  });
});
