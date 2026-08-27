import { describe, it, expect } from "vitest";
import { SlotOfferingService } from "../src/application/slot-offering-service.js";
import { InMemoryLeadRepository, InMemoryAppointmentRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository, InMemoryLeadStatusHistoryRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { LeadNotOfferableError } from "../src/domain/errors.js";
import type { Lead } from "../src/domain/lead.js";

async function makeLead(leads: InMemoryLeadRepository, overrides: Partial<Omit<Lead, "id" | "createdAt" | "updatedAt">> = {}): Promise<Lead> {
  return leads.create({
    country: "MX", productVertical: "GMM", status: "RESCHEDULE_REQUESTED", score: 71,
    assignedAdvisor: "Hector Herrera", consentContact: true,
    ...overrides,
  });
}

function makeService() {
  const calendar = new FakeCalendarProvider();
  const offeredSlots = new InMemoryOfferedSlotRepository();
  const appointments = new InMemoryAppointmentRepository();
  const leads = new InMemoryLeadRepository();
  const slotOfferClaims = new InMemorySlotOfferClaimRepository();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const logger = new FakeLogger();
  const service = new SlotOfferingService(calendar, offeredSlots, appointments, leads, slotOfferClaims, leadStatusHistory, logger);
  return { service, calendar, offeredSlots, appointments, leads, leadStatusHistory, logger };
}

const NOW = new Date("2026-03-01T09:00:00.000Z");

describe("SlotOfferingService -- mode: 'RESCHEDULE'", () => {
  it("requires RESCHEDULE_REQUESTED -- rejects a normal booking-eligible status (QUALIFIED_A) with LeadNotOfferableError", async () => {
    const { service, leads } = makeService();
    const lead = await makeLead(leads, { status: "QUALIFIED_A" });
    await expect(service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: "RESCHEDULE" })).rejects.toThrow(LeadNotOfferableError);
  });

  it("rejects a plain BOOKED lead too -- RESCHEDULE mode is only for RESCHEDULE_REQUESTED, not BOOKED", async () => {
    const { service, leads } = makeService();
    const lead = await makeLead(leads, { status: "BOOKED" });
    await expect(service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: "RESCHEDULE" })).rejects.toThrow(LeadNotOfferableError);
  });

  it("an active OLD appointment (still BOOKED) is never treated as a conflict -- getOrCreateOffer still creates a round instead of returning ALREADY_BOOKED", async () => {
    const { service, leads, appointments } = makeService();
    const lead = await makeLead(leads);
    await appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-old" });

    const outcome = await service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: "RESCHEDULE" });

    expect(outcome.type).toBe("CREATED");
  });

  it("replaceOffer also never treats the active OLD appointment as a conflict", async () => {
    const { service, leads, appointments, offeredSlots } = makeService();
    const lead = await makeLead(leads);
    await appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City" });
    const first = await service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: "RESCHEDULE" });
    if (first.type !== "CREATED") throw new Error("unreachable");
    await Promise.all(first.slots.map((s) => offeredSlots.update(s.id, { expiresAt: NOW })));

    const replaced = await service.replaceOffer({ lead, conversationId: "conv-1", now: NOW, mode: "RESCHEDULE" });

    expect(replaced.type).toBe("CREATED");
  });

  it("a successful round never changes the lead's status -- it stays RESCHEDULE_REQUESTED, no lead_status_history row written (the lead is already correctly there, set by the caller before this)", async () => {
    const { service, leads, leadStatusHistory } = makeService();
    const lead = await makeLead(leads);

    const outcome = await service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: "RESCHEDULE" });

    expect(outcome.type).toBe("CREATED");
    if (outcome.type !== "CREATED") throw new Error("unreachable");
    expect(outcome.lead.status).toBe("RESCHEDULE_REQUESTED");
    expect((await leads.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    expect(await leadStatusHistory.listByLeadId(lead.id)).toEqual([]);
  });

  it("reusing an existing active round (REUSED) also never changes the lead's status", async () => {
    const { service, leads, leadStatusHistory } = makeService();
    const lead = await makeLead(leads);
    await service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: "RESCHEDULE" });

    const reused = await service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: "RESCHEDULE" });

    expect(reused.type).toBe("REUSED");
    expect((await leads.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    expect(await leadStatusHistory.listByLeadId(lead.id)).toEqual([]);
  });

  it("omitting mode is byte-for-byte the existing booking behavior -- a RESCHEDULE_REQUESTED lead is rejected exactly as before (not in OFFERABLE_LEAD_STATUSES)", async () => {
    const { service, leads } = makeService();
    const lead = await makeLead(leads); // RESCHEDULE_REQUESTED, mode omitted
    await expect(service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW })).rejects.toThrow(LeadNotOfferableError);
  });
});
