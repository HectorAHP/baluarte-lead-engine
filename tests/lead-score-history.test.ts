import { describe, expect, it } from "vitest";
import { LeadService } from "../src/application/services.js";
import { InMemoryLeadRepository, InMemoryLeadScoreRepository } from "../src/infrastructure/memory-repositories.js";

describe("lead score history", () => {
  it("appends a lead_scores record on every scoring call, while leads.score reflects only the latest", async () => {
    const leads = new InMemoryLeadRepository();
    const leadScores = new InMemoryLeadScoreRepository();
    const service = new LeadService(leads, leadScores);
    const lead = await service.createLead({ firstName: "Test", productVertical: "PATRIMONIAL" });
    await service.markContacted(lead.id);
    await service.startQualification(lead.id);

    const first = await service.scorePatrimonialLead(lead.id, {
      urgency: "RESEARCHING", monthlyCapacity: "LT_3000", objectiveDefined: false, hasCurrentSavingsOrInvestment: false, acceptsMeeting: false,
    });
    expect(first.scoreClass).toBe("C");

    // NURTURE_C -> QUALIFYING is a valid state-machine transition, so a lead can be re-qualified and re-scored.
    await service.startQualification(lead.id);
    const second = await service.scorePatrimonialLead(lead.id, {
      urgency: "THIS_WEEK", monthlyCapacity: "20000_PLUS", objectiveDefined: true, hasCurrentSavingsOrInvestment: true, acceptsMeeting: true,
    });
    expect(second.scoreClass).toBe("A");

    const history = await leadScores.listByLeadId(lead.id);
    expect(history).toHaveLength(2);
    expect(history[0].scoreClass).toBe("C");
    expect(history[0].vertical).toBe("PATRIMONIAL");
    expect(history[0].breakdown).toBeTruthy();
    expect(history[1].scoreClass).toBe("A");

    const finalLead = await leads.findById(lead.id);
    expect(finalLead?.score).toBe(second.score);
    expect(finalLead?.scoreClass).toBe("A");
  });

  it("records GMM scoring history under the GMM vertical", async () => {
    const leads = new InMemoryLeadRepository();
    const leadScores = new InMemoryLeadScoreRepository();
    const service = new LeadService(leads, leadScores);
    const lead = await service.createLead({ firstName: "Test", productVertical: "GMM" });
    await service.markContacted(lead.id);
    await service.startQualification(lead.id);

    await service.scoreGmmLead(lead.id, { renewalWindow: "LE_30", concreteNeed: true, completeInfo: true, acceptsMeeting: true });

    const history = await leadScores.listByLeadId(lead.id);
    expect(history).toHaveLength(1);
    expect(history[0].vertical).toBe("GMM");
    expect(history[0].scoreClass).toBe("A");
  });
});
