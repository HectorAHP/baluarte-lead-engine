import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { SlotOfferingService, OFFERED_SLOT_TTL_MS, MAX_OFFERED_SLOTS, MAX_OFFER_ROUNDS } from "../src/application/slot-offering-service.js";
import { InMemoryLeadRepository, InMemoryAppointmentRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository, InMemoryLeadStatusHistoryRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { LeadNotOfferableError, ActiveOfferInconsistentError } from "../src/domain/errors.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";
import type { OfferedSlot } from "../src/domain/offered-slot.js";
import type { CalendarProvider, CalendarEventInput, LeadRepository, OfferedSlotRepository } from "../src/application/ports.js";

// NOTE on Phase 3B regression (test S in the block spec): already covered end-to-end by the
// unmodified "WHATSAPP_BOOKING_ENABLED=true alone" regression test in
// tests/whatsapp-booking-flag.test.ts -- this block touched nothing in whatsapp-inbound-service.ts
// or whatsapp-qualification-handler.ts, and SlotOfferingService is still not wired into any
// webhook/handler code path, so that existing test continues to prove the point without
// duplicating a slow E2E webhook flow in this unit-test file.

/** Wraps a CalendarProvider to count getAvailableSlots calls, so tests can assert "Calendar was
 * never (or exactly N times) consulted" for guard-short-circuited paths. */
class CountingCalendarProvider implements CalendarProvider {
  calls = 0;
  constructor(private readonly inner: CalendarProvider) {}
  async getAvailableSlots(from: Date, to: Date, durationMinutes: number) {
    this.calls++;
    return this.inner.getAvailableSlots(from, to, durationMinutes);
  }
  async isSlotAvailable(start: Date, end: Date) {
    return this.inner.isSlotAvailable(start, end);
  }
  async createEvent(input: CalendarEventInput) {
    return this.inner.createEvent(input);
  }
  async deleteEvent(eventId: string) {
    return this.inner.deleteEvent(eventId);
  }
}

const emptyCalendar: CalendarProvider = {
  async getAvailableSlots() {
    return [];
  },
  async isSlotAvailable() {
    return true;
  },
  async createEvent(): Promise<never> {
    throw new Error("not used in this test");
  },
  async deleteEvent() {},
};

/** Returns 5 slots -- more than MAX_OFFERED_SLOTS -- to prove the service itself caps the round. */
const fiveSlotCalendar: CalendarProvider = {
  async getAvailableSlots() {
    const base = new Date("2026-03-03T15:00:00.000Z").getTime();
    return Array.from({ length: 5 }, (_, i) => ({
      start: new Date(base + i * 3_600_000),
      end: new Date(base + i * 3_600_000 + 1_800_000),
    }));
  },
  async isSlotAvailable() {
    return true;
  },
  async createEvent(): Promise<never> {
    throw new Error("not used in this test");
  },
  async deleteEvent() {},
};

async function makeLead(leads: InMemoryLeadRepository, overrides: Partial<Omit<Lead, "id" | "createdAt" | "updatedAt">> = {}): Promise<Lead> {
  return leads.create({
    country: "MX",
    productVertical: "PATRIMONIAL",
    status: "QUALIFIED_A",
    score: 80,
    assignedAdvisor: "Hector Herrera",
    consentContact: true,
    ...overrides,
  });
}

function makeService(overrides: { calendar?: CalendarProvider; roundIdFactory?: () => string } = {}) {
  const calendar = overrides.calendar ?? new FakeCalendarProvider();
  const offeredSlots = new InMemoryOfferedSlotRepository();
  const appointments = new InMemoryAppointmentRepository();
  const leads = new InMemoryLeadRepository();
  const slotOfferClaims = new InMemorySlotOfferClaimRepository();
  const logger = new FakeLogger();
  const service = new SlotOfferingService(calendar, offeredSlots, appointments, leads, slotOfferClaims, new InMemoryLeadStatusHistoryRepository(), logger, { roundIdFactory: overrides.roundIdFactory });
  return { service, calendar, offeredSlots, appointments, leads, slotOfferClaims, logger };
}

/** Expires every given slot in place (mirrors what a future SLOT_UNAVAILABLE/DECLINED flow, or
 * simple TTL elapse, would eventually do) so the next getOrCreateOffer call sees no active offer. */
async function expireAll(offeredSlots: InMemoryOfferedSlotRepository, slots: OfferedSlot[], now: Date) {
  for (const s of slots) await offeredSlots.update(s.id, { expiresAt: now });
}

describe("SlotOfferingService -- round_id identity", () => {
  it("A: createRound persists 3 slots sharing exactly one roundId", async () => {
    const { service, leads } = makeService();
    const lead = await makeLead(leads, { status: "QUALIFIED_A" });
    const now = new Date("2026-03-02T12:00:00.000Z");

    const outcome = await service.getOrCreateOffer({ lead, conversationId: randomUUID(), now });

    expect(outcome.type).toBe("CREATED");
    if (outcome.type !== "CREATED") throw new Error("unreachable");
    expect(outcome.slots).toHaveLength(3);
    const roundIds = new Set(outcome.slots.map((s) => s.roundId));
    expect(roundIds.size).toBe(1);
    expect([...roundIds][0]).toBeTruthy();
  });

  it("B: the next round (after the first is expired) uses a different roundId", async () => {
    const { service, leads, offeredSlots } = makeService();
    const lead = await makeLead(leads, { status: "QUALIFIED_A" });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    const round1 = await service.getOrCreateOffer({ lead, conversationId, now });
    if (round1.type !== "CREATED") throw new Error("unreachable");
    await expireAll(offeredSlots, round1.slots, now);

    const later = new Date(now.getTime() + 60 * 60_000);
    const round2 = await service.getOrCreateOffer({ lead: round1.lead, conversationId, now: later });
    if (round2.type !== "CREATED") throw new Error("unreachable");

    expect(round2.slots[0].roundId).not.toBe(round1.slots[0].roundId);
  });
});

describe("InMemoryOfferedSlotRepository.createMany", () => {
  it("C: succeeds -- persists every row", async () => {
    const repo = new InMemoryOfferedSlotRepository();
    const roundId = randomUUID();
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");
    const rows = await repo.createMany([
      { conversationId, leadId: "l1", roundId, slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() + 60_000), selected: false },
      { conversationId, leadId: "l1", roundId, slotStart: new Date(), slotEnd: new Date(), position: 2, expiresAt: new Date(now.getTime() + 60_000), selected: false },
      { conversationId, leadId: "l1", roundId, slotStart: new Date(), slotEnd: new Date(), position: 3, expiresAt: new Date(now.getTime() + 60_000), selected: false },
    ]);
    expect(rows).toHaveLength(3);
    const active = await repo.listActiveByConversationId(conversationId, now);
    expect(active).toHaveLength(3);
  });

  it("D: a batch containing a duplicate (roundId, position) persists nothing at all", async () => {
    const repo = new InMemoryOfferedSlotRepository();
    const roundId = randomUUID();
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    await expect(
      repo.createMany([
        { conversationId, leadId: "l1", roundId, slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() + 60_000), selected: false },
        { conversationId, leadId: "l1", roundId, slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() + 60_000), selected: false }, // duplicate position
      ]),
    ).rejects.toThrow();

    const active = await repo.listActiveByConversationId(conversationId, now);
    expect(active).toHaveLength(0); // all-or-nothing -- zero rows, not one
  });

  it("E: a duplicate (roundId, position) against an already-persisted row is rejected", async () => {
    const repo = new InMemoryOfferedSlotRepository();
    const roundId = randomUUID();
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");
    await repo.create({ conversationId, leadId: "l1", roundId, slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() + 60_000), selected: false });

    await expect(
      repo.create({ conversationId, leadId: "l1", roundId, slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() + 60_000), selected: false }),
    ).rejects.toThrow();
  });
});

describe("SlotOfferingService.getOrCreateOffer", () => {
  it("F: an existing active offer -- REUSED, same roundId", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const { service, leads, offeredSlots } = makeService({ calendar });
    const lead = await makeLead(leads, { status: "QUALIFIED_A" });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");
    const roundId = randomUUID();
    const persisted = await offeredSlots.createMany([
      { conversationId, leadId: lead.id, roundId, slotStart: new Date("2026-03-03T15:00:00.000Z"), slotEnd: new Date("2026-03-03T15:30:00.000Z"), position: 1, expiresAt: new Date(now.getTime() + 600_000), selected: false },
    ]);

    const outcome = await service.getOrCreateOffer({ lead, conversationId, now });

    expect(outcome.type).toBe("REUSED");
    if (outcome.type !== "REUSED") throw new Error("unreachable");
    expect(outcome.slots.map((s) => s.id)).toEqual(persisted.map((s) => s.id));
    expect(outcome.slots[0].roundId).toBe(roundId);
    expect(calendar.calls).toBe(0);
  });

  it("G: recovery after a failed transition -- same slot ids, same roundId, no new round", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const offeredSlots = new InMemoryOfferedSlotRepository();
    const appointments = new InMemoryAppointmentRepository();
    const realLeads = new InMemoryLeadRepository();
    let failNextUpdate = true;
    const flakyLeads: LeadRepository = {
      create: (input) => realLeads.create(input),
      findById: (id) => realLeads.findById(id),
      findByDedupKey: (key) => realLeads.findByDedupKey(key),
      update: (id, patch) => {
        if (failNextUpdate) {
          failNextUpdate = false;
          return Promise.reject(new Error("LEAD_UPDATE_DOWN"));
        }
        return realLeads.update(id, patch);
      },
    };
    const service = new SlotOfferingService(calendar, offeredSlots, appointments, flakyLeads, new InMemorySlotOfferClaimRepository(), new InMemoryLeadStatusHistoryRepository(), new FakeLogger());
    const lead = await realLeads.create({
      country: "MX", productVertical: "PATRIMONIAL", status: "QUALIFIED_A",
      score: 80, assignedAdvisor: "Hector Herrera", consentContact: true,
    });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    await expect(service.getOrCreateOffer({ lead, conversationId, now })).rejects.toThrow("LEAD_UPDATE_DOWN");
    expect(calendar.calls).toBe(1);
    const persistedAfterFailure = await offeredSlots.listActiveByConversationId(conversationId, now);
    expect(persistedAfterFailure).toHaveLength(3);
    const roundIdAfterFailure = persistedAfterFailure[0].roundId;
    const roundsAfterFailure = await offeredSlots.listRoundIdsByConversationId(conversationId);
    expect(roundsAfterFailure).toEqual([roundIdAfterFailure]);

    const stillQualified = await realLeads.findById(lead.id);
    const outcome = await service.getOrCreateOffer({ lead: stillQualified!, conversationId, now: new Date(now.getTime() + 1_000) });

    expect(outcome.type).toBe("REUSED");
    if (outcome.type !== "REUSED") throw new Error("unreachable");
    expect(outcome.slots.map((s) => s.id).sort()).toEqual(persistedAfterFailure.map((s) => s.id).sort());
    expect(outcome.slots.every((s) => s.roundId === roundIdAfterFailure)).toBe(true);
    expect(outcome.lead.status).toBe("BOOKING_PENDING");
    expect(calendar.calls).toBe(1); // still 1 -- no new Calendar call, no new round
    expect(await offeredSlots.listRoundIdsByConversationId(conversationId)).toHaveLength(1);
  });

  it("H/I/J/K/L: rounds 1-3 are allowed with distinct roundIds, a 4th is refused before touching Calendar, and repeated REUSED never advances the round count", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const { service, leads, offeredSlots } = makeService({ calendar });
    let lead = await makeLead(leads, { status: "QUALIFIED_A" });
    const conversationId = randomUUID();
    let now = new Date("2026-03-02T12:00:00.000Z");

    // L, folded in early: repeated REUSED calls (no expiry in between) never change the round count.
    const round1 = await service.getOrCreateOffer({ lead, conversationId, now });
    if (round1.type !== "CREATED") throw new Error("unreachable");
    lead = round1.lead;
    const reused1 = await service.getOrCreateOffer({ lead, conversationId, now });
    const reused2 = await service.getOrCreateOffer({ lead, conversationId, now });
    expect(reused1.type).toBe("REUSED");
    expect(reused2.type).toBe("REUSED");
    expect(await offeredSlots.listRoundIdsByConversationId(conversationId)).toHaveLength(1);
    expect(calendar.calls).toBe(1); // round1 only -- REUSED never calls Calendar

    await expireAll(offeredSlots, round1.slots, now);
    now = new Date(now.getTime() + 60 * 60_000);
    const round2 = await service.getOrCreateOffer({ lead, conversationId, now });
    if (round2.type !== "CREATED") throw new Error("unreachable");
    lead = round2.lead;
    expect(round2.slots[0].roundId).not.toBe(round1.slots[0].roundId);
    expect(calendar.calls).toBe(2);

    await expireAll(offeredSlots, round2.slots, now);
    now = new Date(now.getTime() + 60 * 60_000);
    const round3 = await service.getOrCreateOffer({ lead, conversationId, now });
    if (round3.type !== "CREATED") throw new Error("unreachable");
    lead = round3.lead;
    expect(calendar.calls).toBe(3);
    expect(await offeredSlots.listRoundIdsByConversationId(conversationId)).toHaveLength(3);

    // K: a 4th round is refused -- MAX_ROUNDS_REACHED, and Calendar is never consulted for it.
    await expireAll(offeredSlots, round3.slots, now);
    now = new Date(now.getTime() + 60 * 60_000);
    const round4 = await service.getOrCreateOffer({ lead, conversationId, now });
    expect(round4).toEqual({ type: "MAX_ROUNDS_REACHED" });
    expect(calendar.calls).toBe(3); // unchanged -- no Calendar call for the refused 4th attempt
    expect(MAX_OFFER_ROUNDS).toBe(3);
  });

  it("N: multiple active roundIds for one conversation -- ActiveOfferInconsistentError, never mixed", async () => {
    const { service, leads, offeredSlots } = makeService();
    const lead = await makeLead(leads, { status: "QUALIFIED_A" });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");
    // Simulates data corruption / the replaceOffer residual-risk window: two distinct rounds
    // both currently active for the same conversation.
    await offeredSlots.createMany([
      { conversationId, leadId: lead.id, roundId: "round-a", slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() + 600_000), selected: false },
    ]);
    await offeredSlots.createMany([
      { conversationId, leadId: lead.id, roundId: "round-b", slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() + 600_000), selected: false },
    ]);

    await expect(service.getOrCreateOffer({ lead, conversationId, now })).rejects.toThrow(ActiveOfferInconsistentError);
    // The lead is never touched -- assertSingleActiveRound throws before any recovery/transition logic runs.
    const reloaded = await leads.findById(lead.id);
    expect(reloaded?.status).toBe("QUALIFIED_A");
  });

  it("O: createMany fails entirely -- the lead is never transitioned (atomic batch failure)", async () => {
    const calendar = new FakeCalendarProvider();
    const appointments = new InMemoryAppointmentRepository();
    const leads = new InMemoryLeadRepository();
    const failingOfferedSlots: OfferedSlotRepository = {
      create: () => Promise.reject(new Error("not used")),
      createMany: () => Promise.reject(new Error("OFFERED_SLOT_DB_DOWN")),
      listActiveByConversationId: async () => [],
      listRoundIdsByConversationId: async () => [],
      update: () => Promise.reject(new Error("not used")),
    };
    const service = new SlotOfferingService(calendar, failingOfferedSlots, appointments, leads, new InMemorySlotOfferClaimRepository(), new InMemoryLeadStatusHistoryRepository(), new FakeLogger());
    const lead = await makeLead(leads, { status: "QUALIFIED_A" });
    const now = new Date("2026-03-02T12:00:00.000Z");

    await expect(service.getOrCreateOffer({ lead, conversationId: randomUUID(), now })).rejects.toThrow("OFFERED_SLOT_DB_DOWN");
    const reloaded = await leads.findById(lead.id);
    expect(reloaded?.status).toBe("QUALIFIED_A");
  });

  it("P: a lead already carrying bookingStartedAt is never overwritten", async () => {
    const { service, leads } = makeService();
    const original = new Date("2026-02-20T00:00:00.000Z");
    const lead = await makeLead(leads, { status: "QUALIFIED_A", bookingStartedAt: original });
    const now = new Date("2026-03-02T12:00:00.000Z");

    const outcome = await service.getOrCreateOffer({ lead, conversationId: randomUUID(), now });

    expect(outcome.type).toBe("CREATED");
    if (outcome.type !== "CREATED") throw new Error("unreachable");
    expect(outcome.lead.bookingStartedAt).toEqual(original);
  });

  it("Q: an existing BOOKED appointment -- ALREADY_BOOKED, no Calendar call, no new offered_slots", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const { service, leads, appointments, offeredSlots } = makeService({ calendar });
    const lead = await makeLead(leads, { status: "QUALIFIED_A" });
    const appt = await appointments.create({
      leadId: lead.id, status: "BOOKED",
      startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"),
      timezone: "America/Mexico_City",
    });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    const outcome = await service.getOrCreateOffer({ lead, conversationId, now });

    expect(outcome).toEqual({ type: "ALREADY_BOOKED", appointment: appt });
    expect(calendar.calls).toBe(0);
    expect(await offeredSlots.listActiveByConversationId(conversationId, now)).toHaveLength(0);
  });

  it("R: Calendar has no availability -- NO_AVAILABILITY, lead unchanged, no round created", async () => {
    const { service, leads, offeredSlots } = makeService({ calendar: emptyCalendar });
    const lead = await makeLead(leads, { status: "QUALIFIED_A" });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    const outcome = await service.getOrCreateOffer({ lead, conversationId, now });

    expect(outcome).toEqual({ type: "NO_AVAILABILITY" });
    const reloaded = await leads.findById(lead.id);
    expect(reloaded?.status).toBe("QUALIFIED_A");
    expect(await offeredSlots.listActiveByConversationId(conversationId, now)).toHaveLength(0);
    expect(await offeredSlots.listRoundIdsByConversationId(conversationId)).toHaveLength(0);
  });

  it.each<LeadStatus>(["HUMAN_HANDOFF", "DO_NOT_CONTACT"])(
    "a lead with status %s is never offered slots -- throws LeadNotOfferableError, no Calendar call, no offered_slots",
    async (status) => {
      const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
      const { service, leads, offeredSlots } = makeService({ calendar });
      const lead = await makeLead(leads, { status });
      const conversationId = randomUUID();
      const now = new Date("2026-03-02T12:00:00.000Z");

      await expect(service.getOrCreateOffer({ lead, conversationId, now })).rejects.toThrow(LeadNotOfferableError);
      expect(calendar.calls).toBe(0);
      expect(await offeredSlots.listActiveByConversationId(conversationId, now)).toHaveLength(0);
    },
  );

  it("pre-launch hardening: a lead with status NURTURE_C IS now offerable -- lets a lead who abandoned a prior BOOKING_PENDING round (landing on NURTURE_C) resume booking, same mechanism as QUALIFIED_A/B", async () => {
    const { service, leads } = makeService({ calendar: new FakeCalendarProvider() });
    const lead = await makeLead(leads, { status: "NURTURE_C", scoreClass: "C" });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    const outcome = await service.getOrCreateOffer({ lead, conversationId, now });

    expect(outcome.type).toBe("CREATED");
    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKING_PENDING");
  });

  it("pre-launch hardening: a BOOKED lead with NO existing appointment IS now offerable -- lets a stale-BOOKED lead (see WhatsAppPastBookedRecoveryHandler) start a brand-new booking", async () => {
    const { service, leads } = makeService({ calendar: new FakeCalendarProvider() });
    const lead = await makeLead(leads, { status: "BOOKED" });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    const outcome = await service.getOrCreateOffer({ lead, conversationId, now });

    expect(outcome.type).toBe("CREATED");
    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKING_PENDING");
  });

  it("pre-launch hardening: a BOOKED lead whose appointment is PAST (endsAt <= now) is also offerable -- the stale appointment never blocks a new offer", async () => {
    const { service, leads, appointments } = makeService({ calendar: new FakeCalendarProvider() });
    const lead = await makeLead(leads, { status: "BOOKED" });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");
    await appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-01T15:00:00.000Z"), endsAt: new Date("2026-03-01T15:30:00.000Z"), timezone: "America/Mexico_City" });

    const outcome = await service.getOrCreateOffer({ lead, conversationId, now });

    expect(outcome.type).toBe("CREATED");
    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKING_PENDING");
  });

  it("pre-launch hardening: a BOOKED lead whose appointment is genuinely UPCOMING (endsAt > now) is NEVER offered a second, competing future booking -- ALREADY_BOOKED, no Calendar call, no new offered_slots", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const { service, leads, appointments, offeredSlots } = makeService({ calendar });
    const lead = await makeLead(leads, { status: "BOOKED" });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");
    const upcoming = await appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-05T15:00:00.000Z"), endsAt: new Date("2026-03-05T15:30:00.000Z"), timezone: "America/Mexico_City" });

    const outcome = await service.getOrCreateOffer({ lead, conversationId, now });

    expect(outcome).toEqual({ type: "ALREADY_BOOKED", appointment: upcoming });
    expect(calendar.calls).toBe(0);
    expect(await offeredSlots.listActiveByConversationId(conversationId, now)).toHaveLength(0);
    expect((await leads.findById(lead.id))?.status).toBe("BOOKED"); // never touched
  });

  it("caps at MAX_OFFERED_SLOTS (3) even when the calendar provider returns more, all sharing one roundId", async () => {
    const { service, leads } = makeService({ calendar: fiveSlotCalendar });
    const lead = await makeLead(leads, { status: "QUALIFIED_A" });
    const now = new Date("2026-03-02T12:00:00.000Z");

    const outcome = await service.getOrCreateOffer({ lead, conversationId: randomUUID(), now });

    expect(outcome.type).toBe("CREATED");
    if (outcome.type !== "CREATED") throw new Error("unreachable");
    expect(outcome.slots).toHaveLength(MAX_OFFERED_SLOTS);
    expect(outcome.slots.map((s) => s.position)).toEqual([1, 2, 3]);
    expect(new Set(outcome.slots.map((s) => s.roundId)).size).toBe(1);
  });

  it("persisted slots' expiresAt is exactly now + OFFERED_SLOT_TTL_MS", async () => {
    const { service, leads } = makeService();
    const lead = await makeLead(leads, { status: "QUALIFIED_A" });
    const now = new Date("2026-03-02T12:00:00.000Z");

    const outcome = await service.getOrCreateOffer({ lead, conversationId: randomUUID(), now });

    expect(outcome.type).toBe("CREATED");
    if (outcome.type !== "CREATED") throw new Error("unreachable");
    const expected = new Date(now.getTime() + OFFERED_SLOT_TTL_MS);
    for (const s of outcome.slots) expect(s.expiresAt).toEqual(expected);
  });
});

describe("SlotOfferingService.replaceOffer", () => {
  it("M: replaceOffer expires the current round and consumes one round toward the limit", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const { service, leads, offeredSlots } = makeService({ calendar });
    const lead = await makeLead(leads, { status: "BOOKING_PENDING", bookingStartedAt: new Date("2026-03-01T00:00:00.000Z") });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");
    const [old1] = await offeredSlots.createMany([
      { conversationId, leadId: lead.id, roundId: randomUUID(), slotStart: new Date("2026-03-03T15:00:00.000Z"), slotEnd: new Date("2026-03-03T15:30:00.000Z"), position: 1, expiresAt: new Date(now.getTime() + 600_000), selected: false },
    ]);

    const outcome = await service.replaceOffer({ lead, conversationId, now });

    expect(outcome.type).toBe("CREATED");
    if (outcome.type !== "CREATED") throw new Error("unreachable");
    expect(outcome.slots.map((s) => s.id)).not.toContain(old1.id);
    expect(outcome.slots[0].roundId).not.toBe(old1.roundId);
    expect(calendar.calls).toBe(1);

    const stillActive = await offeredSlots.listActiveByConversationId(conversationId, now);
    expect(stillActive.map((s) => s.id).sort()).toEqual(outcome.slots.map((s) => s.id).sort());
    expect(await offeredSlots.listRoundIdsByConversationId(conversationId)).toHaveLength(2); // old + new -- one round consumed
  });

  it("honors the ALREADY_BOOKED guard, without expiring or creating anything", async () => {
    const { service, leads, appointments, offeredSlots } = makeService();
    const lead = await makeLead(leads, { status: "BOOKING_PENDING", bookingStartedAt: new Date("2026-03-01T00:00:00.000Z") });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");
    const [active] = await offeredSlots.createMany([
      { conversationId, leadId: lead.id, roundId: randomUUID(), slotStart: new Date("2026-03-03T15:00:00.000Z"), slotEnd: new Date("2026-03-03T15:30:00.000Z"), position: 1, expiresAt: new Date(now.getTime() + 600_000), selected: false },
    ]);
    await appointments.create({
      leadId: lead.id, status: "BOOKED",
      startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"),
      timezone: "America/Mexico_City",
    });

    const outcome = await service.replaceOffer({ lead, conversationId, now });

    expect(outcome.type).toBe("ALREADY_BOOKED");
    const stillActive = await offeredSlots.listActiveByConversationId(conversationId, now);
    expect(stillActive.map((s) => s.id)).toEqual([active.id]);
    expect(await offeredSlots.listRoundIdsByConversationId(conversationId)).toHaveLength(1); // untouched
  });

  it("when the round limit is already reached, refuses before touching Calendar or the current offer", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const { service, leads, offeredSlots } = makeService({ calendar });
    const lead = await makeLead(leads, { status: "BOOKING_PENDING", bookingStartedAt: new Date("2026-03-01T00:00:00.000Z") });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");
    const [active] = await offeredSlots.createMany([
      { conversationId, leadId: lead.id, roundId: "r1", slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() + 600_000), selected: false },
    ]);
    // Two more historical (expired) rounds, so the conversation already has 3 distinct rounds.
    await offeredSlots.createMany([{ conversationId, leadId: lead.id, roundId: "r2", slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() - 1_000), selected: false }]);
    await offeredSlots.createMany([{ conversationId, leadId: lead.id, roundId: "r3", slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() - 1_000), selected: false }]);

    const outcome = await service.replaceOffer({ lead, conversationId, now });

    expect(outcome).toEqual({ type: "MAX_ROUNDS_REACHED" });
    expect(calendar.calls).toBe(0);
    const stillActive = await offeredSlots.listActiveByConversationId(conversationId, now);
    expect(stillActive.map((s) => s.id)).toEqual([active.id]); // untouched -- refused before expiring anything
  });

  it("NO_AVAILABILITY leaves the current round untouched (old offer stays recoverable)", async () => {
    const { service, leads, offeredSlots } = makeService({ calendar: emptyCalendar });
    const lead = await makeLead(leads, { status: "BOOKING_PENDING", bookingStartedAt: new Date("2026-03-01T00:00:00.000Z") });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");
    const [active] = await offeredSlots.createMany([
      { conversationId, leadId: lead.id, roundId: randomUUID(), slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() + 600_000), selected: false },
    ]);

    const outcome = await service.replaceOffer({ lead, conversationId, now });

    expect(outcome).toEqual({ type: "NO_AVAILABILITY" });
    const stillActive = await offeredSlots.listActiveByConversationId(conversationId, now);
    expect(stillActive.map((s) => s.id)).toEqual([active.id]); // Calendar failed to produce a substitute -- old offer preserved
  });
});
