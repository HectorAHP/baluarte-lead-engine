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
    await expect(service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId: "old-appt-1" } })).rejects.toThrow(LeadNotOfferableError);
  });

  it("rejects a plain BOOKED lead too -- RESCHEDULE mode is only for RESCHEDULE_REQUESTED, not BOOKED", async () => {
    const { service, leads } = makeService();
    const lead = await makeLead(leads, { status: "BOOKED" });
    await expect(service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId: "old-appt-1" } })).rejects.toThrow(LeadNotOfferableError);
  });

  it("an active OLD appointment (still BOOKED) is never treated as a conflict -- getOrCreateOffer still creates a round instead of returning ALREADY_BOOKED", async () => {
    const { service, leads, appointments } = makeService();
    const lead = await makeLead(leads);
    await appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-old" });

    const outcome = await service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId: "old-appt-1" } });

    expect(outcome.type).toBe("CREATED");
  });

  it("replaceOffer also never treats the active OLD appointment as a conflict", async () => {
    const { service, leads, appointments, offeredSlots } = makeService();
    const lead = await makeLead(leads);
    await appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City" });
    const first = await service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId: "old-appt-1" } });
    if (first.type !== "CREATED") throw new Error("unreachable");
    await Promise.all(first.slots.map((s) => offeredSlots.update(s.id, { expiresAt: NOW })));

    const replaced = await service.replaceOffer({ lead, conversationId: "conv-1", now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId: "old-appt-1" } });

    expect(replaced.type).toBe("CREATED");
  });

  it("a successful round never changes the lead's status -- it stays RESCHEDULE_REQUESTED, no lead_status_history row written (the lead is already correctly there, set by the caller before this)", async () => {
    const { service, leads, leadStatusHistory } = makeService();
    const lead = await makeLead(leads);

    const outcome = await service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId: "old-appt-1" } });

    expect(outcome.type).toBe("CREATED");
    if (outcome.type !== "CREATED") throw new Error("unreachable");
    expect(outcome.lead.status).toBe("RESCHEDULE_REQUESTED");
    expect((await leads.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    expect(await leadStatusHistory.listByLeadId(lead.id)).toEqual([]);
  });

  it("reusing an existing active round (REUSED) also never changes the lead's status", async () => {
    const { service, leads, leadStatusHistory } = makeService();
    const lead = await makeLead(leads);
    await service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId: "old-appt-1" } });

    const reused = await service.getOrCreateOffer({ lead, conversationId: "conv-1", now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId: "old-appt-1" } });

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

describe("SlotOfferingService -- MAX_OFFER_ROUNDS scoped per booking context (item 11 of the Phase 4C hardening report)", () => {
  it("a reschedule episode gets its OWN 3-round budget, independent of rounds already used by the conversation's original booking", async () => {
    const { service, offeredSlots, leads } = makeService();
    const bookingLead = await leads.create({ country: "MX", productVertical: "GMM", status: "QUALIFIED_A", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true });
    const conversationId = "conv-shared-1";

    // Exhaust the conversation's 3 booking-mode rounds (booking-mode calls omit `mode` entirely).
    let bookingRoundsLead: Lead = bookingLead;
    for (let i = 0; i < 3; i++) {
      const outcome = await service.getOrCreateOffer({ lead: bookingRoundsLead, conversationId, now: NOW });
      if (outcome.type !== "CREATED") throw new Error(`unreachable at round ${i}`);
      bookingRoundsLead = outcome.lead;
      await Promise.all(outcome.slots.map((s) => offeredSlots.update(s.id, { expiresAt: NOW })));
    }
    const exhausted = await service.getOrCreateOffer({ lead: bookingRoundsLead, conversationId, now: NOW });
    expect(exhausted.type).toBe("MAX_ROUNDS_REACHED"); // confirms the booking budget really is exhausted

    // A DIFFERENT lead's reschedule episode, sharing the SAME conversationId, must NOT be
    // affected by the booking rounds counted above -- its own budget starts fresh.
    const rescheduleLead = await leads.create({ country: "MX", productVertical: "GMM", status: "RESCHEDULE_REQUESTED", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true });
    const outcome = await service.getOrCreateOffer({ lead: rescheduleLead, conversationId, now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId: "old-appt-999" } });

    expect(outcome.type).toBe("CREATED");
  });

  it("two DIFFERENT reschedule episodes (two different oldAppointmentId values) in the same conversation get independent budgets too", async () => {
    const { service, offeredSlots, leads } = makeService();
    const lead = await makeLead(leads);
    const conversationId = "conv-shared-2";

    // Exhaust the budget for reschedule episode A.
    let episodeALead = lead;
    for (let i = 0; i < 3; i++) {
      const outcome = await service.getOrCreateOffer({ lead: episodeALead, conversationId, now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId: "old-appt-A" } });
      if (outcome.type !== "CREATED") throw new Error(`unreachable at round ${i}`);
      episodeALead = outcome.lead;
      await Promise.all(outcome.slots.map((s) => offeredSlots.update(s.id, { expiresAt: NOW })));
    }
    const exhaustedA = await service.getOrCreateOffer({ lead: episodeALead, conversationId, now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId: "old-appt-A" } });
    expect(exhaustedA.type).toBe("MAX_ROUNDS_REACHED");

    // Episode B (a different old appointment id -- e.g. a later, separate reschedule for the
    // same lead) is unaffected.
    const outcomeB = await service.getOrCreateOffer({ lead: episodeALead, conversationId, now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId: "old-appt-B" } });
    expect(outcomeB.type).toBe("CREATED");
  });
});
