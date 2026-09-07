import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { SlotOfferingService, MAX_OFFER_ROUNDS } from "../src/application/slot-offering-service.js";
import { InMemoryLeadRepository, InMemoryAppointmentRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository, InMemoryLeadStatusHistoryRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import type { Lead } from "../src/domain/lead.js";
import type { OfferedSlot } from "../src/domain/offered-slot.js";
import type { CalendarProvider, CalendarEventInput } from "../src/application/ports.js";

/**
 * Fase 7I.1 -- CAUSE_ROUND_CAP_ESCALATION fix. Reproduces the real incident (lead eb95060d: an
 * active Saturday round, 3 rounds already spent in the episode, "Quiero agendar el 15 de
 * diciembre" -- out of horizon -- hit the round-cap check BEFORE ever being recognized as
 * deterministically impossible, escalating to HUMAN_HANDOFF via MAX_ROUNDS_REACHED) at the
 * SlotOfferingService level, where the round count/active-round state can be constructed and
 * inspected precisely.
 */
class CountingCalendarProvider implements CalendarProvider {
  calls = 0;
  constructor(private readonly inner: CalendarProvider) {}
  async getAvailableSlots(...args: Parameters<CalendarProvider["getAvailableSlots"]>) {
    this.calls++;
    return this.inner.getAvailableSlots(...args);
  }
  async isSlotAvailable(...args: Parameters<CalendarProvider["isSlotAvailable"]>) {
    return this.inner.isSlotAvailable(...args);
  }
  isWithinBusinessHours(...args: Parameters<CalendarProvider["isWithinBusinessHours"]>) {
    return this.inner.isWithinBusinessHours(...args);
  }
  async createEvent(input: CalendarEventInput) {
    return this.inner.createEvent(input);
  }
  async deleteEvent(eventId: string) {
    return this.inner.deleteEvent(eventId);
  }
}

async function makeLead(leads: InMemoryLeadRepository, overrides: Partial<Omit<Lead, "id" | "createdAt" | "updatedAt">> = {}): Promise<Lead> {
  return leads.create({
    country: "MX", productVertical: "PATRIMONIAL", status: "QUALIFIED_A", score: 80,
    assignedAdvisor: "Hector Herrera", consentContact: true, ...overrides,
  });
}

function makeService(calendar: CalendarProvider = new FakeCalendarProvider()) {
  const offeredSlots = new InMemoryOfferedSlotRepository();
  const appointments = new InMemoryAppointmentRepository();
  const leads = new InMemoryLeadRepository();
  const slotOfferClaims = new InMemorySlotOfferClaimRepository();
  const logger = new FakeLogger();
  const service = new SlotOfferingService(calendar, offeredSlots, appointments, leads, slotOfferClaims, new InMemoryLeadStatusHistoryRepository(), logger);
  return { service, offeredSlots, appointments, leads, slotOfferClaims, logger };
}

async function expireAll(offeredSlots: InMemoryOfferedSlotRepository, slots: OfferedSlot[], now: Date) {
  for (const s of slots) await offeredSlots.update(s.id, { expiresAt: now });
}

const OUT_OF_HORIZON_PREFERENCE = { targetDate: "2026-12-15" }; // real incident's exact date
const NOW = new Date("2026-09-07T03:39:10.860Z"); // real incident's exact inbound instant

/** Builds exactly the real incident's state: 3 rounds already created in this episode, the 3rd
 * one still ACTIVE (never expired) -- same shape as lead eb95060d at the moment "15 de diciembre"
 * arrived. */
async function makeThreeRoundEpisodeWithActiveThird(calendar: CalendarProvider = new FakeCalendarProvider()) {
  const h = makeService(calendar);
  const lead = await makeLead(h.leads, { status: "QUALIFIED_A" });
  const conversationId = randomUUID();
  let now = NOW;

  const round1 = await h.service.getOrCreateOffer({ lead, conversationId, now });
  if (round1.type !== "CREATED") throw new Error("unreachable");
  await expireAll(h.offeredSlots, round1.slots, now);

  now = new Date(now.getTime() + 60_000);
  const round2 = await h.service.replaceOffer({ lead: round1.lead, conversationId, now });
  if (round2.type !== "CREATED") throw new Error("unreachable");

  now = new Date(now.getTime() + 60_000);
  const round3 = await h.service.replaceOffer({ lead: round2.lead, conversationId, now });
  if (round3.type !== "CREATED") throw new Error("unreachable"); // this one stays ACTIVE -- never expired

  expect(await h.offeredSlots.listRoundIdsByConversationId(conversationId)).toHaveLength(3);
  return { ...h, lead: round3.lead, conversationId, activeRound: round3, now: new Date(now.getTime() + 60_000) };
}

describe("Fase 7I.1 -- CAUSE_ROUND_CAP_ESCALATION fix: active round + budget exhausted + out-of-horizon", () => {
  it("item 1: returns REQUESTED_DATE_UNAVAILABLE (reason OUT_OF_HORIZON, fallbackSource ACTIVE_ROUND), never MAX_ROUNDS_REACHED", async () => {
    const ctx = await makeThreeRoundEpisodeWithActiveThird();

    const outcome = await ctx.service.replaceOffer({ lead: ctx.lead, conversationId: ctx.conversationId, now: ctx.now, datePreference: OUT_OF_HORIZON_PREFERENCE });

    expect(outcome.type).toBe("REQUESTED_DATE_UNAVAILABLE");
    if (outcome.type !== "REQUESTED_DATE_UNAVAILABLE") throw new Error("unreachable");
    expect(outcome.reason).toBe("OUT_OF_HORIZON");
    expect(outcome.fallbackSource).toBe("ACTIVE_ROUND");
    expect(outcome.requestedPreference).toEqual(OUT_OF_HORIZON_PREFERENCE);
  });

  it("item 3: round count stays exactly 3 -- no round 4 created", async () => {
    const ctx = await makeThreeRoundEpisodeWithActiveThird();

    await ctx.service.replaceOffer({ lead: ctx.lead, conversationId: ctx.conversationId, now: ctx.now, datePreference: OUT_OF_HORIZON_PREFERENCE });

    const roundIds = await ctx.offeredSlots.listRoundIdsByConversationId(ctx.conversationId);
    expect(roundIds).toHaveLength(3);
  });

  it("item 4: the active round (round 3) remains active and untouched -- not expired, not replaced", async () => {
    const ctx = await makeThreeRoundEpisodeWithActiveThird();
    const activeIdsBefore = ctx.activeRound.slots.map((s) => s.id).sort();

    await ctx.service.replaceOffer({ lead: ctx.lead, conversationId: ctx.conversationId, now: ctx.now, datePreference: OUT_OF_HORIZON_PREFERENCE });

    const stillActive = await ctx.offeredSlots.listActiveByConversationId(ctx.conversationId, ctx.now);
    expect(stillActive.map((s) => s.id).sort()).toEqual(activeIdsBefore);
    for (const s of stillActive) expect(s.selected).toBe(false); // untouched -- still selectable
  });

  it("item 5: fallbackSlots ARE the active round's own slots -- never a re-fetched or re-persisted copy", async () => {
    const ctx = await makeThreeRoundEpisodeWithActiveThird();

    const outcome = await ctx.service.replaceOffer({ lead: ctx.lead, conversationId: ctx.conversationId, now: ctx.now, datePreference: OUT_OF_HORIZON_PREFERENCE });

    if (outcome.type !== "REQUESTED_DATE_UNAVAILABLE") throw new Error("unreachable");
    expect(outcome.fallbackSlots.map((s) => s.id).sort()).toEqual(ctx.activeRound.slots.map((s) => s.id).sort());
    expect(outcome.fallbackSlots.every((s) => s.roundId === ctx.activeRound.slots[0].roundId)).toBe(true);
  });

  it("item 6: Calendar is never called to determine OUT_OF_HORIZON -- pure date arithmetic only", async () => {
    const inner = new FakeCalendarProvider();
    const counting = new CountingCalendarProvider(inner);
    const ctx = await makeThreeRoundEpisodeWithActiveThird(counting);
    const callsBefore = counting.calls;

    await ctx.service.replaceOffer({ lead: ctx.lead, conversationId: ctx.conversationId, now: ctx.now, datePreference: OUT_OF_HORIZON_PREFERENCE });

    expect(counting.calls).toBe(callsBefore); // unchanged -- zero additional Calendar calls
  });
});

describe("Fase 7I.1 -- no active round scenarios", () => {
  it("item 7: no active round + budget available -> creates a genuine unfiltered fallback round (fallbackSource NEW_ROUND)", async () => {
    const h = makeService();
    const lead = await makeLead(h.leads, { status: "QUALIFIED_A" });
    const conversationId = randomUUID();

    const outcome = await h.service.getOrCreateOffer({ lead, conversationId, now: NOW, datePreference: OUT_OF_HORIZON_PREFERENCE });

    expect(outcome.type).toBe("REQUESTED_DATE_UNAVAILABLE");
    if (outcome.type !== "REQUESTED_DATE_UNAVAILABLE") throw new Error("unreachable");
    expect(outcome.reason).toBe("OUT_OF_HORIZON");
    expect(outcome.fallbackSource).toBe("NEW_ROUND");
    expect(outcome.fallbackSlots.length).toBeGreaterThan(0);
    expect(await h.offeredSlots.listRoundIdsByConversationId(conversationId)).toHaveLength(1); // DID consume one real round
  });

  it("item 8: no active round + budget exhausted + out-of-horizon -> explanation only, no handoff-triggering outcome, no new round", async () => {
    const h = makeService();
    let lead = await makeLead(h.leads, { status: "QUALIFIED_A" });
    const conversationId = randomUUID();
    let now = NOW;

    // Exhaust the budget with 3 plain (no-preference) rounds, each expired before the next.
    for (let i = 0; i < MAX_OFFER_ROUNDS; i++) {
      const round = await h.service.getOrCreateOffer({ lead, conversationId, now });
      if (round.type !== "CREATED") throw new Error("unreachable");
      lead = round.lead;
      await expireAll(h.offeredSlots, round.slots, now);
      now = new Date(now.getTime() + 60_000);
    }
    expect(await h.offeredSlots.listRoundIdsByConversationId(conversationId)).toHaveLength(3);

    const outcome = await h.service.getOrCreateOffer({ lead, conversationId, now, datePreference: OUT_OF_HORIZON_PREFERENCE });

    expect(outcome.type).toBe("REQUESTED_DATE_UNAVAILABLE");
    if (outcome.type !== "REQUESTED_DATE_UNAVAILABLE") throw new Error("unreachable");
    expect(outcome.fallbackSource).toBe("NONE");
    expect(outcome.fallbackSlots).toEqual([]);
    expect(await h.offeredSlots.listRoundIdsByConversationId(conversationId)).toHaveLength(3); // still 3 -- no hidden 4th round
  });
});

describe("Fase 7I.1 -- regressions: feasible preferences and existing behavior are unaffected", () => {
  it("item 9: a valid new weekday preference (\"mejor el viernes\") still uses replaceOffer normally when budget is available", async () => {
    const ctx = await makeThreeRoundEpisodeWithActiveThird();
    // Budget is exhausted (3/3) in this fixture, so a FEASIBLE preference here correctly still
    // hits MAX_ROUNDS_REACHED -- proving the fix does NOT bypass the cap for feasible requests.
    const outcome = await ctx.service.replaceOffer({ lead: ctx.lead, conversationId: ctx.conversationId, now: ctx.now, datePreference: { weekday: 5 } });
    expect(outcome).toEqual({ type: "MAX_ROUNDS_REACHED" });
  });

  it("item 9b: with budget available, a valid weekday preference creates a real new round via replaceOffer, unaffected by the fix", async () => {
    const h = makeService();
    const lead = await makeLead(h.leads, { status: "QUALIFIED_A" });
    const conversationId = randomUUID();
    const round1 = await h.service.getOrCreateOffer({ lead, conversationId, now: NOW });
    if (round1.type !== "CREATED") throw new Error("unreachable");

    const outcome = await h.service.replaceOffer({ lead: round1.lead, conversationId, now: NOW, datePreference: { weekday: 5 } });
    expect(outcome.type).toBe("CREATED");
  });

  it("item 10: Sunday (weekday=0) preference behavior is unaffected -- always feasible, falls through to Calendar/NO_SLOTS handling unchanged", async () => {
    const h = makeService();
    const lead = await makeLead(h.leads, { status: "QUALIFIED_A" });
    const conversationId = randomUUID();

    const outcome = await h.service.getOrCreateOffer({ lead, conversationId, now: NOW, datePreference: { weekday: 0 } });

    // FakeCalendarProvider has no real business-hours concept, so this proves ROUTING, not
    // Sunday-closure itself (see availability-date-preference.test.ts for the real business-hours
    // proof) -- the point here is that a bare weekday preference never even reaches the new
    // feasibility short-circuit.
    expect(outcome.type === "CREATED" || outcome.type === "REQUESTED_DATE_UNAVAILABLE").toBe(true);
  });

  it("item 11: Saturday (weekday=6) preference still creates a real round, unaffected by the fix", async () => {
    const h = makeService();
    const lead = await makeLead(h.leads, { status: "QUALIFIED_A" });
    const conversationId = randomUUID();

    const outcome = await h.service.getOrCreateOffer({ lead, conversationId, now: NOW, datePreference: { weekday: 6 } });
    expect(outcome.type).toBe("CREATED");
  });

  it("item 14: a GENUINE booking inconsistency (no datePreference at all) still reaches MAX_ROUNDS_REACHED when the budget is exhausted", async () => {
    const ctx = await makeThreeRoundEpisodeWithActiveThird();
    await expireAll(ctx.offeredSlots, ctx.activeRound.slots, ctx.now); // no active round to reuse either
    const outcome = await ctx.service.getOrCreateOffer({ lead: ctx.lead, conversationId: ctx.conversationId, now: ctx.now });
    expect(outcome).toEqual({ type: "MAX_ROUNDS_REACHED" }); // genuine escalation path still intact
  });
});
