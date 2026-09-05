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
});
