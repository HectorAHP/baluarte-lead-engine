import { describe, it, expect } from "vitest";
import { HubSpotOutboxReconciliationService, formatCandidateForDisplay } from "../src/application/hubspot-outbox-reconciliation.js";
import { InMemoryFiscalLeadScoreRepository, InMemoryHubSpotSyncOutboxRepository, InMemoryLeadRepository } from "../src/infrastructure/memory-repositories.js";
import { formatFiscalCalculatorNote } from "../src/domain/fiscal-calculator-lead-note.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import type { Lead } from "../src/domain/lead.js";

function makeService() {
  const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
  const outbox = new InMemoryHubSpotSyncOutboxRepository();
  const leads = new InMemoryLeadRepository();
  const service = new HubSpotOutboxReconciliationService(fiscalLeadScores, outbox, new FakeLogger(), leads);
  return { fiscalLeadScores, outbox, leads, service };
}

const SINCE = new Date("2020-01-01T00:00:00.000Z");

async function seedScore(fiscalLeadScores: InMemoryFiscalLeadScoreRepository, leadId: string, submissionId: string) {
  await fiscalLeadScores.tryCreate({
    leadId, submissionId, score: 50, scoreClass: "WARM", version: "fiscal_v1", reasons: [],
    monthlyIncomeBand: "25K_34K", annualContributionBand: "UNDER_18K",
  });
}

/** Seeds a lead with a real, parseable id (InMemoryLeadRepository generates its own UUID on
 * create()) -- returns the created Lead so tests can key fiscal scores/outbox rows off its real id
 * rather than an arbitrary string, matching how a real Supabase-backed lead_id foreign key would
 * behave. */
async function seedLead(leads: InMemoryLeadRepository, overrides: Partial<Lead> = {}): Promise<Lead> {
  return leads.create({
    country: "MX", productVertical: "PATRIMONIAL", status: "NEW", score: 0,
    assignedAdvisor: "Hector Herrera", consentContact: true,
    ...overrides,
  });
}

describe("Fase 7C -- HubSpotOutboxReconciliationService", () => {
  it("item 24: dryRun never mutates anything -- outbox rows are untouched by a dry-run alone", async () => {
    const { fiscalLeadScores, outbox, leads, service } = makeService();
    const lead = await seedLead(leads);
    await seedScore(fiscalLeadScores, lead.id, "sub-1");
    const entry = await outbox.tryCreate({ leadId: lead.id, submissionId: "sub-1", payload: { properties: {} } });
    await outbox.update(entry!.id, { status: "FAILED_PERMANENT" });

    await service.dryRun(SINCE, 100);

    const unchanged = await outbox.findById(entry!.id);
    expect(unchanged?.status).toBe("FAILED_PERMANENT"); // still there, untouched
  });

  it("a fiscal score with NO outbox row, and no notes/identity signal -> MISSING_OUTBOX_PARTIAL_DATA_ONLY / NOT_RECONSTRUCTABLE", async () => {
    const { fiscalLeadScores, leads, service } = makeService();
    const lead = await seedLead(leads);
    await seedScore(fiscalLeadScores, lead.id, "sub-1");
    const report = await service.dryRun(SINCE, 100);
    expect(report.candidateCount).toBe(1);
    expect(report.candidates[0].reason).toBe("MISSING_OUTBOX_PARTIAL_DATA_ONLY");
    expect(report.candidates[0].dataQuality).toBe("NOT_RECONSTRUCTABLE");
  });

  it("a fiscal score with a FAILED_PERMANENT outbox row -> FAILED_PERMANENT_RETRIABLE / FULLY_RECONSTRUCTABLE", async () => {
    const { fiscalLeadScores, outbox, leads, service } = makeService();
    const lead = await seedLead(leads);
    await seedScore(fiscalLeadScores, lead.id, "sub-1");
    const entry = await outbox.tryCreate({ leadId: lead.id, submissionId: "sub-1", payload: { properties: {} } });
    await outbox.update(entry!.id, { status: "FAILED_PERMANENT" });

    const report = await service.dryRun(SINCE, 100);
    expect(report.candidateCount).toBe(1);
    expect(report.candidates[0].reason).toBe("FAILED_PERMANENT_RETRIABLE");
    expect(report.candidates[0].dataQuality).toBe("FULLY_RECONSTRUCTABLE");
  });

  it("a fiscal score with a SUCCEEDED outbox row is never a candidate", async () => {
    const { fiscalLeadScores, outbox, leads, service } = makeService();
    const lead = await seedLead(leads);
    await seedScore(fiscalLeadScores, lead.id, "sub-1");
    const entry = await outbox.tryCreate({ leadId: lead.id, submissionId: "sub-1", payload: { properties: {} } });
    await outbox.update(entry!.id, { status: "SUCCEEDED" });

    const report = await service.dryRun(SINCE, 100);
    expect(report.candidateCount).toBe(0);
  });

  it("a fiscal score with a PENDING or FAILED_RETRYABLE outbox row is never a candidate -- still legitimately in-flight", async () => {
    const { fiscalLeadScores, outbox, leads, service } = makeService();
    const lead = await seedLead(leads);
    await seedScore(fiscalLeadScores, lead.id, "sub-1");
    await outbox.tryCreate({ leadId: lead.id, submissionId: "sub-1", payload: { properties: {} } });

    const report = await service.dryRun(SINCE, 100);
    expect(report.candidateCount).toBe(0);
  });

  it("item 25: execute ONLY resets FAILED_PERMANENT_RETRIABLE candidates, never touches MISSING_OUTBOX_PARTIAL_DATA_ONLY", async () => {
    const { fiscalLeadScores, outbox, leads, service } = makeService();
    const lead1 = await seedLead(leads);
    const lead2 = await seedLead(leads);
    await seedScore(fiscalLeadScores, lead1.id, "sub-1"); // -> MISSING_OUTBOX_PARTIAL_DATA_ONLY
    await seedScore(fiscalLeadScores, lead2.id, "sub-2");
    const entry2 = await outbox.tryCreate({ leadId: lead2.id, submissionId: "sub-2", payload: { properties: {} } });
    await outbox.update(entry2!.id, { status: "FAILED_PERMANENT" }); // -> FAILED_PERMANENT_RETRIABLE

    const report = await service.dryRun(SINCE, 100);
    expect(report.candidateCount).toBe(2);

    const result = await service.execute(report.candidates, new Date());
    expect(result).toEqual({ attempted: 1, reset: 1 }); // only the one FAILED_PERMANENT_RETRIABLE candidate

    const resetEntry = await outbox.findById(entry2!.id);
    expect(resetEntry?.status).toBe("PENDING");
    // lead-1 never got an outbox row created for it -- execute never fabricates one.
    expect(await outbox.findByLeadAndSubmission(lead1.id, "sub-1")).toBeNull();
  });

  it("execute re-checks status fresh -- a candidate already resolved since the dry-run is skipped, never double-reset", async () => {
    const { fiscalLeadScores, outbox, leads, service } = makeService();
    const lead = await seedLead(leads);
    await seedScore(fiscalLeadScores, lead.id, "sub-1");
    const entry = await outbox.tryCreate({ leadId: lead.id, submissionId: "sub-1", payload: { properties: {} } });
    await outbox.update(entry!.id, { status: "FAILED_PERMANENT" });

    const report = await service.dryRun(SINCE, 100);
    await outbox.update(entry!.id, { status: "SUCCEEDED" }); // resolved by something else in the meantime

    const result = await service.execute(report.candidates, new Date());
    expect(result).toEqual({ attempted: 1, reset: 0 });
    expect((await outbox.findById(entry!.id))?.status).toBe("SUCCEEDED"); // never reverted
  });

  it("item 22: formatCandidateForDisplay never exposes full leadId/submissionId, only last-8", async () => {
    const { fiscalLeadScores, leads, service } = makeService();
    const lead = await seedLead(leads);
    await seedScore(fiscalLeadScores, lead.id, "22222222-2222-2222-2222-22223333bbbb");
    const report = await service.dryRun(SINCE, 100);
    const display = formatCandidateForDisplay(report.candidates[0]);
    expect(display.leadIdLast8).toBe(lead.id.slice(-8));
    expect(display.submissionIdLast8).toBe("3333bbbb");
    expect(JSON.stringify(display)).not.toContain(lead.id);
  });

  it("--dry-run is the default posture: a report alone never changes any data (confirmed structurally -- dryRun has no write path at all)", async () => {
    const { fiscalLeadScores, outbox, leads, service } = makeService();
    const lead = await seedLead(leads);
    await seedScore(fiscalLeadScores, lead.id, "sub-1");
    const before = await outbox.listByStatus("PENDING");
    await service.dryRun(SINCE, 100);
    const after = await outbox.listByStatus("PENDING");
    expect(after).toEqual(before);
  });

  // Fase 7C.1 §14 -- the 4-way dataQuality taxonomy, informed by leads.notes (via
  // fiscal-calculator-note-parser.ts) and leads.identityConflict.
  describe("dataQuality classification (Fase 7C.1 §14)", () => {
    it("a lead with a parseable calculator note block for this submission -> PARTIALLY_RECONSTRUCTABLE", async () => {
      const { fiscalLeadScores, leads, service } = makeService();
      const submissionId = "092b017c-06ac-44eb-aeff-d39545575fb1";
      const note = formatFiscalCalculatorNote({
        age: 32, city: "León", taxRegime: "sueldos", filesAnnualReturn: true,
        monthlyIncome: 100000, annualContribution: 120000,
        deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
        hasGmm: false, hasPpr: false,
        calculation: { annualIncome: 1200000, pprDeductionLimit: 213973, effectivePprContribution: 120000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 24000, estimatedTaxBenefitMax: 36000 },
        submissionId, submittedAt: new Date("2026-09-04T20:00:20.468Z"),
      });
      const lead = await seedLead(leads, { notes: note });
      await seedScore(fiscalLeadScores, lead.id, submissionId);

      const report = await service.dryRun(SINCE, 100);
      expect(report.candidates[0].dataQuality).toBe("PARTIALLY_RECONSTRUCTABLE");
      expect(report.candidates[0].actionPlanned).toContain("approximate");
    });

    it("a lead with notes that DON'T contain a block for this specific submissionId -> NOT_RECONSTRUCTABLE", async () => {
      const { fiscalLeadScores, leads, service } = makeService();
      const note = formatFiscalCalculatorNote({
        monthlyIncome: 50000, annualContribution: 20000,
        deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
        calculation: { annualIncome: 600000, pprDeductionLimit: 60000, effectivePprContribution: 20000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 1000, estimatedTaxBenefitMax: 2000 },
        submissionId: "a-totally-different-submission", submittedAt: new Date(),
      });
      const lead = await seedLead(leads, { notes: note });
      await seedScore(fiscalLeadScores, lead.id, "sub-not-in-notes");

      const report = await service.dryRun(SINCE, 100);
      expect(report.candidates[0].dataQuality).toBe("NOT_RECONSTRUCTABLE");
    });

    it("an identityConflict lead is ALWAYS IDENTITY_CONFLICT, even when its notes have a perfectly parseable block", async () => {
      const { fiscalLeadScores, leads, service } = makeService();
      const submissionId = "sub-conflict-1";
      const note = formatFiscalCalculatorNote({
        monthlyIncome: 50000, annualContribution: 20000,
        deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
        calculation: { annualIncome: 600000, pprDeductionLimit: 60000, effectivePprContribution: 20000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 1000, estimatedTaxBenefitMax: 2000 },
        submissionId, submittedAt: new Date(),
      });
      const lead = await seedLead(leads, { notes: note, identityConflict: true });
      await seedScore(fiscalLeadScores, lead.id, submissionId);

      const report = await service.dryRun(SINCE, 100);
      expect(report.candidates[0].dataQuality).toBe("IDENTITY_CONFLICT");
      expect(report.candidates[0].actionPlanned).toContain("identity");
    });

    it("a FAILED_PERMANENT_RETRIABLE candidate is always FULLY_RECONSTRUCTABLE, regardless of notes/identityConflict", async () => {
      const { fiscalLeadScores, outbox, leads, service } = makeService();
      const lead = await seedLead(leads, { identityConflict: true }); // even here -- the frozen payload makes notes/identity moot
      await seedScore(fiscalLeadScores, lead.id, "sub-1");
      const entry = await outbox.tryCreate({ leadId: lead.id, submissionId: "sub-1", payload: { properties: {} } });
      await outbox.update(entry!.id, { status: "FAILED_PERMANENT" });

      const report = await service.dryRun(SINCE, 100);
      expect(report.candidates[0].dataQuality).toBe("FULLY_RECONSTRUCTABLE");
    });
  });
});
