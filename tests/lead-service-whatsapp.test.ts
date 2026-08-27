import { describe, expect, it } from "vitest";
import { LeadService } from "../src/application/services.js";
import { InMemoryLeadRepository, InMemoryLeadScoreRepository, InMemoryLeadStatusHistoryRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { InvalidLeadTransitionError } from "../src/domain/errors.js";

function makeService() {
  const leads = new InMemoryLeadRepository();
  const service = new LeadService(leads, new InMemoryLeadScoreRepository(), new InMemoryLeadStatusHistoryRepository(), new FakeLogger());
  return { leads, service };
}

describe("LeadService.recordInboundContact", () => {
  it("on a NEW lead: transitions to CONTACTED and sets both first_contact_at and first_response_at together", async () => {
    const { service } = makeService();
    const lead = await service.createLead({ firstName: "Test" });
    const updated = await service.recordInboundContact(lead.id);
    expect(updated.status).toBe("CONTACTED");
    expect(updated.firstContactAt).toBeInstanceOf(Date);
    expect(updated.firstResponseAt).toBeInstanceOf(Date);
    expect(updated.firstContactAt?.getTime()).toBe(updated.firstResponseAt?.getTime());
  });

  it("on an already-contacted lead: only backfills first_response_at if unset, leaves status alone", async () => {
    const { service, leads } = makeService();
    const lead = await service.createLead({ firstName: "Test" });
    await service.markContacted(lead.id); // sets firstContactAt, NOT firstResponseAt
    await service.startQualification(lead.id);
    const updated = await service.recordInboundContact(lead.id);
    expect(updated.status).toBe("QUALIFYING"); // untouched
    expect(updated.firstResponseAt).toBeInstanceOf(Date);
    const reloaded = await leads.findById(lead.id);
    expect(reloaded?.firstResponseAt).toBeInstanceOf(Date);
  });

  it("does not overwrite an already-set first_response_at", async () => {
    const { service } = makeService();
    const lead = await service.createLead({ firstName: "Test" });
    const first = await service.recordInboundContact(lead.id);
    const firstResponseTime = first.firstResponseAt!.getTime();
    const second = await service.recordInboundContact(lead.id);
    expect(second.firstResponseAt!.getTime()).toBe(firstResponseTime);
  });
});

describe("LeadService.requestHumanHandoff", () => {
  it("transitions a QUALIFYING lead to HUMAN_HANDOFF", async () => {
    const { service } = makeService();
    const lead = await service.createLead({ firstName: "Test" });
    await service.markContacted(lead.id);
    await service.startQualification(lead.id);
    const updated = await service.requestHumanHandoff(lead.id);
    expect(updated.status).toBe("HUMAN_HANDOFF");
  });

  it("throws InvalidLeadTransitionError from a terminal state", async () => {
    const { service, leads } = makeService();
    const lead = await service.createLead({ firstName: "Test" });
    await leads.update(lead.id, { status: "CLOSED_WON" });
    await expect(service.requestHumanHandoff(lead.id)).rejects.toThrow(InvalidLeadTransitionError);
  });
});

describe("LeadService.requestDoNotContact", () => {
  it("transitions a NEW lead directly to DO_NOT_CONTACT", async () => {
    const { service } = makeService();
    const lead = await service.createLead({ firstName: "Test" });
    const updated = await service.requestDoNotContact(lead.id);
    expect(updated.status).toBe("DO_NOT_CONTACT");
  });

  it("transitions a QUALIFYING lead to DO_NOT_CONTACT", async () => {
    const { service } = makeService();
    const lead = await service.createLead({ firstName: "Test" });
    await service.markContacted(lead.id);
    await service.startQualification(lead.id);
    const updated = await service.requestDoNotContact(lead.id);
    expect(updated.status).toBe("DO_NOT_CONTACT");
  });
});
