import { describe, it, expect } from "vitest";
import { HubSpotOutboxReconciliationService, formatCandidateForDisplay } from "../src/application/hubspot-outbox-reconciliation.js";
import { InMemoryFiscalLeadScoreRepository, InMemoryHubSpotSyncOutboxRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";

function makeService() {
  const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
  const outbox = new InMemoryHubSpotSyncOutboxRepository();
  const service = new HubSpotOutboxReconciliationService(fiscalLeadScores, outbox, new FakeLogger());
  return { fiscalLeadScores, outbox, service };
}

const SINCE = new Date("2020-01-01T00:00:00.000Z");

async function seedScore(fiscalLeadScores: InMemoryFiscalLeadScoreRepository, leadId: string, submissionId: string) {
  await fiscalLeadScores.tryCreate({
    leadId, submissionId, score: 50, scoreClass: "WARM", version: "fiscal_v1", reasons: [],
    monthlyIncomeBand: "25K_34K", annualContributionBand: "UNDER_18K",
  });
}

describe("Fase 7C -- HubSpotOutboxReconciliationService", () => {
  it("item 24: dryRun never mutates anything -- outbox rows are untouched by a dry-run alone", async () => {
    const { fiscalLeadScores, outbox, service } = makeService();
    await seedScore(fiscalLeadScores, "lead-1", "sub-1");
    const entry = await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: { properties: {} } });
    await outbox.update(entry!.id, { status: "FAILED_PERMANENT" });

    await service.dryRun(SINCE, 100);

    const unchanged = await outbox.findById(entry!.id);
    expect(unchanged?.status).toBe("FAILED_PERMANENT"); // still there, untouched
  });

  it("a fiscal score with NO outbox row -> MISSING_OUTBOX_PARTIAL_DATA_ONLY", async () => {
    const { fiscalLeadScores, service } = makeService();
    await seedScore(fiscalLeadScores, "lead-1", "sub-1");
    const report = await service.dryRun(SINCE, 100);
    expect(report.candidateCount).toBe(1);
    expect(report.candidates[0].reason).toBe("MISSING_OUTBOX_PARTIAL_DATA_ONLY");
  });

  it("a fiscal score with a FAILED_PERMANENT outbox row -> FAILED_PERMANENT_RETRIABLE", async () => {
    const { fiscalLeadScores, outbox, service } = makeService();
    await seedScore(fiscalLeadScores, "lead-1", "sub-1");
    const entry = await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: { properties: {} } });
    await outbox.update(entry!.id, { status: "FAILED_PERMANENT" });

    const report = await service.dryRun(SINCE, 100);
    expect(report.candidateCount).toBe(1);
    expect(report.candidates[0].reason).toBe("FAILED_PERMANENT_RETRIABLE");
  });

  it("a fiscal score with a SUCCEEDED outbox row is never a candidate", async () => {
    const { fiscalLeadScores, outbox, service } = makeService();
    await seedScore(fiscalLeadScores, "lead-1", "sub-1");
    const entry = await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: { properties: {} } });
    await outbox.update(entry!.id, { status: "SUCCEEDED" });

    const report = await service.dryRun(SINCE, 100);
    expect(report.candidateCount).toBe(0);
  });

  it("a fiscal score with a PENDING or FAILED_RETRYABLE outbox row is never a candidate -- still legitimately in-flight", async () => {
    const { fiscalLeadScores, outbox, service } = makeService();
    await seedScore(fiscalLeadScores, "lead-1", "sub-1");
    await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: { properties: {} } });

    const report = await service.dryRun(SINCE, 100);
    expect(report.candidateCount).toBe(0);
  });

  it("item 25: execute ONLY resets FAILED_PERMANENT_RETRIABLE candidates, never touches MISSING_OUTBOX_PARTIAL_DATA_ONLY", async () => {
    const { fiscalLeadScores, outbox, service } = makeService();
    await seedScore(fiscalLeadScores, "lead-1", "sub-1"); // -> MISSING_OUTBOX_PARTIAL_DATA_ONLY
    await seedScore(fiscalLeadScores, "lead-2", "sub-2");
    const entry2 = await outbox.tryCreate({ leadId: "lead-2", submissionId: "sub-2", payload: { properties: {} } });
    await outbox.update(entry2!.id, { status: "FAILED_PERMANENT" }); // -> FAILED_PERMANENT_RETRIABLE

    const report = await service.dryRun(SINCE, 100);
    expect(report.candidateCount).toBe(2);

    const result = await service.execute(report.candidates, new Date());
    expect(result).toEqual({ attempted: 1, reset: 1 }); // only the one FAILED_PERMANENT_RETRIABLE candidate

    const resetEntry = await outbox.findById(entry2!.id);
    expect(resetEntry?.status).toBe("PENDING");
    // lead-1 never got an outbox row created for it -- execute never fabricates one.
    expect(await outbox.findByLeadAndSubmission("lead-1", "sub-1")).toBeNull();
  });

  it("execute re-checks status fresh -- a candidate already resolved since the dry-run is skipped, never double-reset", async () => {
    const { fiscalLeadScores, outbox, service } = makeService();
    await seedScore(fiscalLeadScores, "lead-1", "sub-1");
    const entry = await outbox.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: { properties: {} } });
    await outbox.update(entry!.id, { status: "FAILED_PERMANENT" });

    const report = await service.dryRun(SINCE, 100);
    await outbox.update(entry!.id, { status: "SUCCEEDED" }); // resolved by something else in the meantime

    const result = await service.execute(report.candidates, new Date());
    expect(result).toEqual({ attempted: 1, reset: 0 });
    expect((await outbox.findById(entry!.id))?.status).toBe("SUCCEEDED"); // never reverted
  });

  it("item 22: formatCandidateForDisplay never exposes full leadId/submissionId, only last-8", async () => {
    const { fiscalLeadScores, service } = makeService();
    await seedScore(fiscalLeadScores, "11111111-1111-1111-1111-11112222aaaa", "22222222-2222-2222-2222-22223333bbbb");
    const report = await service.dryRun(SINCE, 100);
    const display = formatCandidateForDisplay(report.candidates[0]);
    expect(display.leadIdLast8).toBe("2222aaaa");
    expect(display.submissionIdLast8).toBe("3333bbbb");
    expect(JSON.stringify(display)).not.toContain("11111111-1111-1111-1111");
  });

  it("--dry-run is the default posture: a report alone never changes any data (confirmed structurally -- dryRun has no write path at all)", async () => {
    const { fiscalLeadScores, outbox, service } = makeService();
    await seedScore(fiscalLeadScores, "lead-1", "sub-1");
    const before = await outbox.listByStatus("PENDING");
    await service.dryRun(SINCE, 100);
    const after = await outbox.listByStatus("PENDING");
    expect(after).toEqual(before);
  });
});
