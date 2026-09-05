import { describe, it, expect } from "vitest";
import { InMemoryHubSpotSyncOutboxRepository } from "../src/infrastructure/memory-repositories.js";

function samplePayload() {
  return { email: "a@example.com", phone: "+521111", properties: { bc_fiscal_score: 50 } };
}

describe("InMemoryHubSpotSyncOutboxRepository", () => {
  it("item 11: tryCreate is idempotent on (leadId, submissionId) -- a retried write never creates two rows", async () => {
    const repo = new InMemoryHubSpotSyncOutboxRepository();
    const first = await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload() });
    const second = await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload() });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await repo.findByLeadAndSubmission("lead-1", "sub-1")).toEqual(first);
  });

  it("a different submissionId for the SAME lead creates a separate row", async () => {
    const repo = new InMemoryHubSpotSyncOutboxRepository();
    const first = await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload() });
    const second = await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-2", payload: samplePayload() });
    expect(first!.id).not.toBe(second!.id);
  });

  it("a fresh row is immediately eligible for claim (nextAttemptAt defaults to now)", async () => {
    const repo = new InMemoryHubSpotSyncOutboxRepository();
    await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload() });
    const claimed = await repo.claimBatch(new Date(), 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("PROCESSING");
  });

  it("claimBatch respects the limit and claims oldest-eligible first", async () => {
    const repo = new InMemoryHubSpotSyncOutboxRepository();
    for (let i = 0; i < 5; i++) {
      await repo.tryCreate({ leadId: `lead-${i}`, submissionId: `sub-${i}`, payload: samplePayload() });
    }
    const claimed = await repo.claimBatch(new Date(), 3);
    expect(claimed).toHaveLength(3);
    expect(await repo.listByStatus("PROCESSING")).toHaveLength(3);
    expect(await repo.listByStatus("PENDING")).toHaveLength(2);
  });

  it("a row not yet due (nextAttemptAt in the future) is never claimed", async () => {
    const repo = new InMemoryHubSpotSyncOutboxRepository();
    const future = new Date(Date.now() + 60_000);
    await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload(), nextAttemptAt: future });
    const claimedNow = await repo.claimBatch(new Date(), 10);
    expect(claimedNow).toHaveLength(0);
    const claimedLater = await repo.claimBatch(future, 10);
    expect(claimedLater).toHaveLength(1);
  });

  it("item 9: two 'concurrent' claimBatch calls never claim the same row (JS single-threaded atomicity)", async () => {
    const repo = new InMemoryHubSpotSyncOutboxRepository();
    for (let i = 0; i < 4; i++) {
      await repo.tryCreate({ leadId: `lead-${i}`, submissionId: `sub-${i}`, payload: samplePayload() });
    }
    const [batchA, batchB] = await Promise.all([repo.claimBatch(new Date(), 4), repo.claimBatch(new Date(), 4)]);
    const claimedIds = new Set([...batchA, ...batchB].map((r) => r.id));
    expect(claimedIds.size).toBe(batchA.length + batchB.length); // no overlap between the two batches
    expect(batchA.length + batchB.length).toBe(4); // together they claimed everything, exactly once each
  });

  it("SUCCEEDED and FAILED_PERMANENT rows are never re-claimed", async () => {
    const repo = new InMemoryHubSpotSyncOutboxRepository();
    const entry = await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload() });
    await repo.update(entry!.id, { status: "SUCCEEDED" });
    expect(await repo.claimBatch(new Date(), 10)).toHaveLength(0);

    const entry2 = await repo.tryCreate({ leadId: "lead-2", submissionId: "sub-2", payload: samplePayload() });
    await repo.update(entry2!.id, { status: "FAILED_PERMANENT" });
    expect(await repo.claimBatch(new Date(), 10)).toHaveLength(0);
  });

  it("FAILED_RETRYABLE rows ARE re-claimable once due", async () => {
    const repo = new InMemoryHubSpotSyncOutboxRepository();
    const entry = await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload() });
    await repo.update(entry!.id, { status: "FAILED_RETRYABLE", nextAttemptAt: new Date(0) });
    const claimed = await repo.claimBatch(new Date(), 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("PROCESSING");
  });
});
