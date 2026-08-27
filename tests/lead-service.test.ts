import { describe, expect, it, beforeEach } from "vitest";
import { LeadService } from "../src/application/services.js";
import { InMemoryLeadRepository, InMemoryLeadScoreRepository } from "../src/infrastructure/memory-repositories.js";
import { LeadNotFoundError, InvalidLeadTransitionError } from "../src/domain/errors.js";
import type { PatrimonialScoreInput } from "../src/domain/scoring.js";

const aInput: PatrimonialScoreInput = { urgency: "THIS_WEEK", monthlyCapacity: "10000_19999", objectiveDefined: true, hasCurrentSavingsOrInvestment: true, acceptsMeeting: true };
const bInput: PatrimonialScoreInput = { urgency: "ONE_TO_THREE_MONTHS", monthlyCapacity: "5000_9999", objectiveDefined: true, hasCurrentSavingsOrInvestment: false, acceptsMeeting: true };
const cInput: PatrimonialScoreInput = { urgency: "RESEARCHING", monthlyCapacity: "LT_3000", objectiveDefined: false, hasCurrentSavingsOrInvestment: false, acceptsMeeting: false };

describe("LeadService qualification lifecycle", () => {
  let repo: InMemoryLeadRepository;
  let leadScores: InMemoryLeadScoreRepository;
  let service: LeadService;

  beforeEach(() => {
    repo = new InMemoryLeadRepository();
    leadScores = new InMemoryLeadScoreRepository();
    service = new LeadService(repo, leadScores);
  });

  async function newLead() {
    return service.createLead({ firstName: "Test", productVertical: "PATRIMONIAL" });
  }

  it("NEW -> CONTACTED succeeds", async () => {
    const lead = await newLead();
    const updated = await service.markContacted(lead.id);
    expect(updated.status).toBe("CONTACTED");
  });

  it("CONTACTED -> QUALIFYING succeeds", async () => {
    const lead = await newLead();
    await service.markContacted(lead.id);
    const updated = await service.startQualification(lead.id);
    expect(updated.status).toBe("QUALIFYING");
  });

  it("QUALIFYING -> QUALIFIED_A succeeds", async () => {
    const lead = await newLead();
    await service.markContacted(lead.id);
    await service.startQualification(lead.id);
    const updated = await service.scorePatrimonialLead(lead.id, aInput);
    expect(updated.status).toBe("QUALIFIED_A");
    expect(updated.scoreClass).toBe("A");
  });

  it("QUALIFYING -> QUALIFIED_B succeeds", async () => {
    const lead = await newLead();
    await service.markContacted(lead.id);
    await service.startQualification(lead.id);
    const updated = await service.scorePatrimonialLead(lead.id, bInput);
    expect(updated.status).toBe("QUALIFIED_B");
    expect(updated.scoreClass).toBe("B");
  });

  it("QUALIFYING -> NURTURE_C succeeds", async () => {
    const lead = await newLead();
    await service.markContacted(lead.id);
    await service.startQualification(lead.id);
    const updated = await service.scorePatrimonialLead(lead.id, cInput);
    expect(updated.status).toBe("NURTURE_C");
    expect(updated.scoreClass).toBe("C");
  });

  it("QUALIFYING -> QUALIFIED_A succeeds for the GMM path too", async () => {
    const lead = await newLead();
    await service.markContacted(lead.id);
    await service.startQualification(lead.id);
    const updated = await service.scoreGmmLead(lead.id, { renewalWindow: "LE_30", concreteNeed: true, completeInfo: true, acceptsMeeting: true });
    expect(updated.status).toBe("QUALIFIED_A");
  });

  it("NEW -> QUALIFIED_A fails: scoring a lead that skipped contact/qualifying is rejected", async () => {
    const lead = await newLead();
    await expect(service.scorePatrimonialLead(lead.id, aInput)).rejects.toThrow(InvalidLeadTransitionError);
    const unchanged = await repo.findById(lead.id);
    expect(unchanged?.status).toBe("NEW");
  });

  it("CLOSED_WON cannot be re-qualified", async () => {
    const lead = await newLead();
    await repo.update(lead.id, { status: "CLOSED_WON" });
    await expect(service.markContacted(lead.id)).rejects.toThrow(InvalidLeadTransitionError);
    await expect(service.startQualification(lead.id)).rejects.toThrow(InvalidLeadTransitionError);
    await expect(service.scorePatrimonialLead(lead.id, aInput)).rejects.toThrow(InvalidLeadTransitionError);
  });

  it("unknown lead returns LEAD_NOT_FOUND", async () => {
    const missingId = "00000000-0000-0000-0000-000000000000";
    await expect(service.markContacted(missingId)).rejects.toThrow(LeadNotFoundError);
    await expect(service.startQualification(missingId)).rejects.toThrow(LeadNotFoundError);
    await expect(service.scorePatrimonialLead(missingId, aInput)).rejects.toThrow(LeadNotFoundError);
  });
});
