import { describe, it, expect } from "vitest";
import { HubSpotOutboxProcessorService } from "../src/application/hubspot-outbox-processor.js";
import { InMemoryHubSpotSyncOutboxRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeHubSpotCRMProvider } from "../src/infrastructure/fake-hubspot-crm-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { HubSpotProviderError } from "../src/domain/errors.js";
import type { HubSpotCRMProvider, HubSpotContactUpsertInput, HubSpotContactUpsertResult } from "../src/application/ports.js";

function samplePayload(email: string) {
  return { email, phone: "+521111", firstName: "Ana", properties: { bc_fiscal_score: 50 } };
}

function makeProcessor(hubspotCrm: HubSpotCRMProvider, options = { batchSize: 20, maxAttempts: 6 }) {
  const outbox = new InMemoryHubSpotSyncOutboxRepository();
  const logger = new FakeLogger();
  const processor = new HubSpotOutboxProcessorService({ outbox, hubspotCrm, logger }, options);
  return { outbox, logger, processor };
}

// Safely in the future relative to tryCreate's own real-wall-clock nextAttemptAt default (`new
// Date()` at insert time) -- otherwise a freshly-created row's nextAttemptAt could land AFTER this
// fixed NOW and never be claimable in these tests.
const NOW = new Date("2027-01-01T00:00:00.000Z");

describe("HubSpotOutboxProcessorService", () => {
  it("item 6: a healthy HubSpot call succeeds -- row marked SUCCEEDED, hubspotContactId stored", async () => {
    const crm = new FakeHubSpotCRMProvider();
    const { outbox, processor } = makeProcessor(crm);
    const entry = await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload("a@example.com") });

    const summary = await processor.run(NOW);

    expect(summary).toEqual({ claimed: 1, succeeded: 1, retryScheduled: 0, permanentlyFailed: 0 });
    const updated = await outbox.findById(entry!.id);
    expect(updated?.status).toBe("SUCCEEDED");
    expect(updated?.hubspotContactId).toBeDefined();
    expect(updated?.completedAt).toBeInstanceOf(Date);
  });

  it("item 2/3: a 5xx/429 error schedules a retry with the correct backoff, never permanent", async () => {
    const failing: HubSpotCRMProvider = { upsertContact: async () => { throw new HubSpotProviderError("simulated", { httpStatus: 500 }); } };
    const { outbox, processor } = makeProcessor(failing);
    const entry = await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload("a@example.com") });

    const summary = await processor.run(NOW);

    expect(summary).toEqual({ claimed: 1, succeeded: 0, retryScheduled: 1, permanentlyFailed: 0 });
    const updated = await outbox.findById(entry!.id);
    expect(updated?.status).toBe("FAILED_RETRYABLE");
    expect(updated?.attemptCount).toBe(1);
    expect(updated?.nextAttemptAt.getTime()).toBe(NOW.getTime() + 60_000); // attempt 2: +1min
  });

  it("item 4: a network/timeout error (no httpStatus) is also retryable", async () => {
    const failing: HubSpotCRMProvider = { upsertContact: async () => { throw new HubSpotProviderError("timeout"); } };
    const { outbox, processor } = makeProcessor(failing);
    await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload("a@example.com") });

    const summary = await processor.run(NOW);
    expect(summary.retryScheduled).toBe(1);
  });

  it("item 5: a permanent error (400) marks FAILED_PERMANENT immediately, never retried", async () => {
    const failing: HubSpotCRMProvider = { upsertContact: async () => { throw new HubSpotProviderError("bad payload", { httpStatus: 400 }); } };
    const { outbox, processor } = makeProcessor(failing);
    const entry = await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload("a@example.com") });

    const summary = await processor.run(NOW);

    expect(summary).toEqual({ claimed: 1, succeeded: 0, retryScheduled: 0, permanentlyFailed: 1 });
    const updated = await outbox.findById(entry!.id);
    expect(updated?.status).toBe("FAILED_PERMANENT");
  });

  it("item 6/27: a retryable error eventually succeeds after retries", async () => {
    let calls = 0;
    const flaky: HubSpotCRMProvider = {
      upsertContact: async (input: HubSpotContactUpsertInput): Promise<HubSpotContactUpsertResult> => {
        calls++;
        if (calls < 3) throw new HubSpotProviderError("transient", { httpStatus: 503 });
        return { hubspotContactId: "hs-1", created: true };
      },
    };
    const { outbox, processor } = makeProcessor(flaky);
    const entry = await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload("a@example.com") });

    await processor.run(NOW);
    let current = await outbox.findById(entry!.id);
    expect(current?.status).toBe("FAILED_RETRYABLE");

    await processor.run(current!.nextAttemptAt);
    current = await outbox.findById(entry!.id);
    expect(current?.status).toBe("FAILED_RETRYABLE");

    const finalSummary = await processor.run(current!.nextAttemptAt);
    expect(finalSummary.succeeded).toBe(1);
    current = await outbox.findById(entry!.id);
    expect(current?.status).toBe("SUCCEEDED");
    expect(calls).toBe(3);
  });

  it("item 27/28: max attempts enforced -- a persistently-retryable error eventually becomes FAILED_PERMANENT, never retries forever", async () => {
    const alwaysFailing: HubSpotCRMProvider = { upsertContact: async () => { throw new HubSpotProviderError("down", { httpStatus: 500 }); } };
    const { outbox, processor } = makeProcessor(alwaysFailing, { batchSize: 20, maxAttempts: 3 });
    const entry = await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload("a@example.com") });

    let now = NOW;
    for (let i = 0; i < 3; i++) {
      await processor.run(now);
      const current = await outbox.findById(entry!.id);
      now = current!.status === "FAILED_RETRYABLE" ? current!.nextAttemptAt : now;
    }

    const final = await outbox.findById(entry!.id);
    expect(final?.status).toBe("FAILED_PERMANENT");
    expect(final?.attemptCount).toBe(3);
  });

  it("item 10/11: 409-recovery and identity-conflict outcomes from the CRM provider pass through untouched", async () => {
    // FakeHubSpotCRMProvider models the SAME identity-conflict contract as the real adapter --
    // see fake-hubspot-crm-provider.ts.
    const crm = new FakeHubSpotCRMProvider();
    await crm.upsertContact({ email: "old@example.com", phone: "+521111", properties: {} }); // seed a conflicting contact
    const { outbox, processor } = makeProcessor(crm);
    const entry = await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: { email: "new@example.com", phone: "+521111", properties: {} } });

    const summary = await processor.run(NOW);

    expect(summary.succeeded).toBe(1); // identity conflict is NOT an error -- a new, separate contact is created safely
    const updated = await outbox.findById(entry!.id);
    expect(updated?.status).toBe("SUCCEEDED");
    expect(updated?.hubspotContactId).not.toBe((await crm.upsertContact({ email: "old@example.com", properties: {} })).hubspotContactId);
  });

  it("claiming respects batchSize -- a run never processes more than configured", async () => {
    const crm = new FakeHubSpotCRMProvider();
    const { outbox, processor } = makeProcessor(crm, { batchSize: 2, maxAttempts: 6 });
    for (let i = 0; i < 5; i++) {
      await outbox.tryCreate({ leadId: `lead-${i}`, submissionId: `sub-${i}`, payload: samplePayload(`a${i}@example.com`) });
    }
    const summary = await processor.run(NOW);
    expect(summary.claimed).toBe(2);
    expect(await outbox.listByStatus("PENDING")).toHaveLength(3);
  });

  // Fase 7C.1 §9 -- 401/403 gets a distinct, actionable log outcome, never lumped in with a
  // generic "invalid lead" permanent failure.
  it("item 9 (Fase 7C.1): a 401 marks FAILED_PERMANENT AND logs the distinct 'failed_permanent_auth_error' outcome", async () => {
    const failing: HubSpotCRMProvider = { upsertContact: async () => { throw new HubSpotProviderError("unauthorized", { httpStatus: 401 }); } };
    const { outbox, logger, processor } = makeProcessor(failing);
    const entry = await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload("a@example.com") });

    const summary = await processor.run(NOW);

    expect(summary.permanentlyFailed).toBe(1);
    const updated = await outbox.findById(entry!.id);
    expect(updated?.status).toBe("FAILED_PERMANENT");
    const authLog = logger.warnings.find((c) => (c.details as Record<string, unknown>)?.outcome === "failed_permanent_auth_error");
    expect(authLog).toBeDefined();
  });

  it("item 9 (Fase 7C.1): a 403 gets the same distinct auth-error outcome as 401", async () => {
    const failing: HubSpotCRMProvider = { upsertContact: async () => { throw new HubSpotProviderError("forbidden", { httpStatus: 403 }); } };
    const { outbox, logger, processor } = makeProcessor(failing);
    await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload("a@example.com") });

    await processor.run(NOW);

    const authLog = logger.warnings.find((c) => (c.details as Record<string, unknown>)?.outcome === "failed_permanent_auth_error");
    expect(authLog).toBeDefined();
  });

  it("a plain 400 (genuinely bad lead data) does NOT get the auth-error outcome", async () => {
    const failing: HubSpotCRMProvider = { upsertContact: async () => { throw new HubSpotProviderError("bad payload", { httpStatus: 400 }); } };
    const { outbox, logger, processor } = makeProcessor(failing);
    await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload("a@example.com") });

    await processor.run(NOW);

    const authLog = logger.warnings.find((c) => (c.details as Record<string, unknown>)?.outcome === "failed_permanent_auth_error");
    expect(authLog).toBeUndefined();
    const genericLog = logger.warnings.find((c) => (c.details as Record<string, unknown>)?.outcome === "failed_permanent");
    expect(genericLog).toBeDefined();
  });

  // Fase 7C.1 §6 -- worker-crash recovery, proven at the processor level (not just the repository
  // unit test in hubspot-sync-outbox-repository.test.ts): a claimed-but-never-finished row (the
  // worker died mid-flight, so update() was never called) is reclaimed and successfully processed
  // by a LATER run, once past the staleness threshold.
  describe("worker-crash recovery (Fase 7C.1 §6)", () => {
    it("a row stuck in PROCESSING past the staleness threshold is reclaimed and can succeed on the next run", async () => {
      const outbox = new InMemoryHubSpotSyncOutboxRepository();
      const logger = new FakeLogger();
      const staleProcessingThresholdMs = 10 * 60_000;
      const crashedCrm: HubSpotCRMProvider = { upsertContact: async () => { throw new Error("simulated process crash -- never resolves, never rejects observably to the outbox row"); } };
      const entry = await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload("a@example.com") });

      // Simulate a worker crashing mid-flight: claim the row directly (bypassing processOne, which
      // would call update() -- a real crash happens strictly between claim and update).
      const claimTime = NOW;
      const claimed = await outbox.claimBatch(claimTime, 20, new Date(0));
      expect(claimed).toHaveLength(1);
      expect((await outbox.findById(entry!.id))?.status).toBe("PROCESSING");

      // A healthy worker's run, well past the staleness threshold, must reclaim and process it.
      const laterProcessor = new HubSpotOutboxProcessorService({ outbox, hubspotCrm: new FakeHubSpotCRMProvider(), logger }, { batchSize: 20, maxAttempts: 6, staleProcessingThresholdMs });
      const muchLater = new Date(claimTime.getTime() + 20 * 60_000);
      const summary = await laterProcessor.run(muchLater);

      expect(summary.claimed).toBe(1);
      expect(summary.succeeded).toBe(1);
      const finalRow = await outbox.findById(entry!.id);
      expect(finalRow?.status).toBe("SUCCEEDED");
      void crashedCrm; // documents the crash scenario; the actual reclaim uses a healthy CRM afterward
    });

    it("a row still within the staleness window is NEVER reclaimed by a concurrent/second run", async () => {
      const outbox = new InMemoryHubSpotSyncOutboxRepository();
      const logger = new FakeLogger();
      const entry = await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload("a@example.com") });
      const claimTime = NOW;
      await outbox.claimBatch(claimTime, 20, new Date(0));

      const processor = new HubSpotOutboxProcessorService({ outbox, hubspotCrm: new FakeHubSpotCRMProvider(), logger }, { batchSize: 20, maxAttempts: 6, staleProcessingThresholdMs: 10 * 60_000 });
      const shortlyAfter = new Date(claimTime.getTime() + 60_000); // 1 min later, threshold is 10 min
      const summary = await processor.run(shortlyAfter);

      expect(summary.claimed).toBe(0); // must NOT reclaim -- a live worker could still legitimately own this row
      expect((await outbox.findById(entry!.id))?.status).toBe("PROCESSING");
    });
  });
});
