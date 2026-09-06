import { describe, it, expect } from "vitest";
import { InMemoryHubSpotSyncOutboxRepository } from "../src/infrastructure/memory-repositories.js";

function samplePayload() {
  return { email: "a@example.com", phone: "+521111", properties: { bc_fiscal_score: 50 } };
}

// Fase 7C.1 §6 -- claimBatch's third argument (`staleBefore`) reclaims a PROCESSING row past a
// staleness threshold. `NEVER_STALE` is deliberately far in the past-relative-never-reached sense
// (i.e. a moment so far back that no row's updatedAt could ever be "older than" it going forward
// in these synchronous, single-tick tests) -- used everywhere a test only cares about the
// PENDING/FAILED_RETRYABLE claim path, so the pre-existing assertions below are unaffected by §6.
const NEVER_STALE = new Date(0);

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
    const claimed = await repo.claimBatch(new Date(), 10, NEVER_STALE);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("PROCESSING");
  });

  it("claimBatch respects the limit and claims oldest-eligible first", async () => {
    const repo = new InMemoryHubSpotSyncOutboxRepository();
    for (let i = 0; i < 5; i++) {
      await repo.tryCreate({ leadId: `lead-${i}`, submissionId: `sub-${i}`, payload: samplePayload() });
    }
    const claimed = await repo.claimBatch(new Date(), 3, NEVER_STALE);
    expect(claimed).toHaveLength(3);
    expect(await repo.listByStatus("PROCESSING")).toHaveLength(3);
    expect(await repo.listByStatus("PENDING")).toHaveLength(2);
  });

  it("a row not yet due (nextAttemptAt in the future) is never claimed", async () => {
    const repo = new InMemoryHubSpotSyncOutboxRepository();
    const future = new Date(Date.now() + 60_000);
    await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload(), nextAttemptAt: future });
    const claimedNow = await repo.claimBatch(new Date(), 10, NEVER_STALE);
    expect(claimedNow).toHaveLength(0);
    const claimedLater = await repo.claimBatch(future, 10, NEVER_STALE);
    expect(claimedLater).toHaveLength(1);
  });

  it("item 9: two 'concurrent' claimBatch calls never claim the same row (JS single-threaded atomicity)", async () => {
    const repo = new InMemoryHubSpotSyncOutboxRepository();
    for (let i = 0; i < 4; i++) {
      await repo.tryCreate({ leadId: `lead-${i}`, submissionId: `sub-${i}`, payload: samplePayload() });
    }
    const [batchA, batchB] = await Promise.all([repo.claimBatch(new Date(), 4, NEVER_STALE), repo.claimBatch(new Date(), 4, NEVER_STALE)]);
    const claimedIds = new Set([...batchA, ...batchB].map((r) => r.id));
    expect(claimedIds.size).toBe(batchA.length + batchB.length); // no overlap between the two batches
    expect(batchA.length + batchB.length).toBe(4); // together they claimed everything, exactly once each
  });

  it("SUCCEEDED and FAILED_PERMANENT rows are never re-claimed", async () => {
    const repo = new InMemoryHubSpotSyncOutboxRepository();
    const entry = await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload() });
    await repo.update(entry!.id, { status: "SUCCEEDED" });
    expect(await repo.claimBatch(new Date(), 10, NEVER_STALE)).toHaveLength(0);

    const entry2 = await repo.tryCreate({ leadId: "lead-2", submissionId: "sub-2", payload: samplePayload() });
    await repo.update(entry2!.id, { status: "FAILED_PERMANENT" });
    expect(await repo.claimBatch(new Date(), 10, NEVER_STALE)).toHaveLength(0);
  });

  it("FAILED_RETRYABLE rows ARE re-claimable once due", async () => {
    const repo = new InMemoryHubSpotSyncOutboxRepository();
    const entry = await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload() });
    await repo.update(entry!.id, { status: "FAILED_RETRYABLE", nextAttemptAt: new Date(0) });
    const claimed = await repo.claimBatch(new Date(), 10, NEVER_STALE);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("PROCESSING");
  });

  // Fase 7C.1 §6 -- worker-crash recovery via lease/staleness reclaim.
  describe("stale PROCESSING reclaim (worker-crash recovery)", () => {
    it("a PROCESSING row still within the staleness window is NOT reclaimed (a live worker is presumably still on it)", async () => {
      const repo = new InMemoryHubSpotSyncOutboxRepository();
      const entry = await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload() });
      const claimTime = new Date("2027-01-01T00:00:00.000Z");
      const firstClaim = await repo.claimBatch(claimTime, 10, NEVER_STALE);
      expect(firstClaim).toHaveLength(1);
      expect(firstClaim[0].id).toBe(entry!.id);

      // 1 minute later -- well within any reasonable staleness threshold -- staleBefore is set to
      // "10 minutes before now", i.e. still after claimTime, so the row must NOT be reclaimed.
      const shortlyAfter = new Date(claimTime.getTime() + 60_000);
      const staleBefore = new Date(shortlyAfter.getTime() - 10 * 60_000);
      const secondClaim = await repo.claimBatch(shortlyAfter, 10, staleBefore);
      expect(secondClaim).toHaveLength(0);
      expect(await repo.listByStatus("PROCESSING")).toHaveLength(1); // still claimed, untouched
    });

    it("a PROCESSING row past the staleness threshold (crashed worker) IS reclaimed by a later run", async () => {
      const repo = new InMemoryHubSpotSyncOutboxRepository();
      const entry = await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload() });
      const claimTime = new Date("2027-01-01T00:00:00.000Z");
      const firstClaim = await repo.claimBatch(claimTime, 10, NEVER_STALE);
      expect(firstClaim).toHaveLength(1); // simulates the worker crashing right after this point -- never calls update()

      // 20 minutes later, with a 10-minute staleness threshold -- the row is now stale.
      const muchLater = new Date(claimTime.getTime() + 20 * 60_000);
      const staleBefore = new Date(muchLater.getTime() - 10 * 60_000);
      const secondClaim = await repo.claimBatch(muchLater, 10, staleBefore);
      expect(secondClaim).toHaveLength(1);
      expect(secondClaim[0].id).toBe(entry!.id);
      expect(secondClaim[0].status).toBe("PROCESSING"); // reclaimed -- stays PROCESSING, now owned by the new run
    });

    it("a reclaimed row is never counted or returned twice within the same claim call", async () => {
      const repo = new InMemoryHubSpotSyncOutboxRepository();
      await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload() });
      const claimTime = new Date("2027-01-01T00:00:00.000Z");
      await repo.claimBatch(claimTime, 10, NEVER_STALE);

      const muchLater = new Date(claimTime.getTime() + 20 * 60_000);
      const staleBefore = new Date(muchLater.getTime() - 10 * 60_000);
      const [batchA, batchB] = await Promise.all([
        repo.claimBatch(muchLater, 10, staleBefore),
        repo.claimBatch(muchLater, 10, staleBefore),
      ]);
      // Same single-threaded-event-loop atomicity argument as the "concurrent claimBatch" test
      // above -- reclaiming a stale row must be exactly as race-safe as claiming a fresh one.
      expect(batchA.length + batchB.length).toBe(1);
    });

    it("a genuinely completed row (SUCCEEDED) is never reclaimed no matter how old its updatedAt is", async () => {
      const repo = new InMemoryHubSpotSyncOutboxRepository();
      const entry = await repo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: samplePayload() });
      const claimTime = new Date("2027-01-01T00:00:00.000Z");
      await repo.claimBatch(claimTime, 10, NEVER_STALE);
      await repo.update(entry!.id, { status: "SUCCEEDED" });

      const muchLater = new Date(claimTime.getTime() + 20 * 60_000);
      const staleBefore = new Date(muchLater.getTime() - 10 * 60_000);
      expect(await repo.claimBatch(muchLater, 10, staleBefore)).toHaveLength(0);
    });
  });
});
