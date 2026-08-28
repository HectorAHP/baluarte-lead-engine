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

// ---------------------------------------------------------------------------------------------
// Phase 4C post-mortem regression tests. Root cause: listActiveByConversationId (the query that
// decides REUSED vs CREATE-NEW) was never scoped by reschedule_context_id -- only
// listRoundIdsByConversationId (round COUNTING) was. A reschedule request landing while the
// conversation's ORIGINAL booking round still had unselected, unexpired slots silently reused
// them as if they were fresh reschedule options, and never created a context-tagged round at all.
// See tests/whatsapp-reschedule-e2e.test.ts for the real-webhook-pipeline version of test A.
// ---------------------------------------------------------------------------------------------
describe("Phase 4C post-mortem -- item 12.A: a reschedule request never reuses the original booking round's leftover slots", () => {
  it("booking round (positions 1,2,3; position 1 selected; context=null) still unexpired when a reschedule starts -- getOrCreateOffer RESCHEDULE creates a BRAND NEW round tagged with the old appointment's id, never reusing positions 2/3", async () => {
    const { service, offeredSlots, leads } = makeService();
    const bookingLead = await leads.create({ country: "MX", productVertical: "GMM", status: "QUALIFIED_A", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true });
    const conversationId = "conv-postmortem-A";

    // The original booking round -- created via booking mode (mode omitted), context=null.
    const bookingOutcome = await service.getOrCreateOffer({ lead: bookingLead, conversationId, now: NOW });
    if (bookingOutcome.type !== "CREATED") throw new Error("unreachable");
    const originalRoundId = bookingOutcome.slots[0].roundId;
    expect(bookingOutcome.slots).toHaveLength(3);
    expect(bookingOutcome.slots.every((s) => s.rescheduleContextId === undefined)).toBe(true);
    // Simulate position 1 being selected (the original booking succeeded) -- positions 2/3 stay
    // active, unselected, unexpired, exactly as the real bug report described.
    const position1 = bookingOutcome.slots.find((s) => s.position === 1)!;
    await offeredSlots.update(position1.id, { selected: true });

    const oldAppointmentId = "old-appt-real-A";
    const rescheduleLead = await leads.create({ country: "MX", productVertical: "GMM", status: "RESCHEDULE_REQUESTED", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true });

    const rescheduleOutcome = await service.getOrCreateOffer({
      lead: rescheduleLead, conversationId, now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId },
    });

    expect(rescheduleOutcome.type).toBe("CREATED"); // NEVER "REUSED" of the booking round
    if (rescheduleOutcome.type !== "CREATED") throw new Error("unreachable");
    expect(rescheduleOutcome.slots).toHaveLength(3);
    // A brand new round_id -- never the original booking's.
    expect(rescheduleOutcome.slots.every((s) => s.roundId !== originalRoundId)).toBe(true);
    // Every new slot is tagged with the CURRENT reschedule episode's context.
    expect(rescheduleOutcome.slots.every((s) => s.rescheduleContextId === oldAppointmentId)).toBe(true);
    // The original booking round's positions 2/3 are untouched, unselected, and NOT among the
    // slots just offered.
    const rescheduleSlotIds = new Set(rescheduleOutcome.slots.map((s) => s.id));
    const position2 = bookingOutcome.slots.find((s) => s.position === 2)!;
    const position3 = bookingOutcome.slots.find((s) => s.position === 3)!;
    expect(rescheduleSlotIds.has(position2.id)).toBe(false);
    expect(rescheduleSlotIds.has(position3.id)).toBe(false);
    expect((await offeredSlots.listActiveByConversationId(conversationId, NOW))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: position2.id }), expect.objectContaining({ id: position3.id })]),
    ); // still exist, still active, just never offered as a reschedule option
  });
});

describe("Phase 4C post-mortem -- item 12.D: booking mode never reuses a reschedule round's slots", () => {
  it("a reschedule round (context=A) still unexpired never gets reused by a LATER, unrelated booking-mode getOrCreateOffer call on the same conversation", async () => {
    const { service, leads } = makeService();
    const conversationId = "conv-postmortem-D";
    const rescheduleLead = await leads.create({ country: "MX", productVertical: "GMM", status: "RESCHEDULE_REQUESTED", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true });
    const rescheduleOutcome = await service.getOrCreateOffer({ lead: rescheduleLead, conversationId, now: NOW, mode: { type: "RESCHEDULE", oldAppointmentId: "old-appt-real-D" } });
    if (rescheduleOutcome.type !== "CREATED") throw new Error("unreachable");
    const rescheduleRoundId = rescheduleOutcome.slots[0].roundId;

    const bookingLead = await leads.create({ country: "MX", productVertical: "GMM", status: "QUALIFIED_A", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true });
    const bookingOutcome = await service.getOrCreateOffer({ lead: bookingLead, conversationId, now: NOW }); // mode omitted -- booking

    expect(bookingOutcome.type).toBe("CREATED"); // never "REUSED" of the reschedule round
    if (bookingOutcome.type !== "CREATED") throw new Error("unreachable");
    expect(bookingOutcome.slots.every((s) => s.roundId !== rescheduleRoundId)).toBe(true);
    expect(bookingOutcome.slots.every((s) => s.rescheduleContextId === undefined)).toBe(true);
  });
});
