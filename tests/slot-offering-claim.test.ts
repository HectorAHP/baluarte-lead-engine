import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { SlotOfferingService, OFFERED_SLOT_TTL_MS } from "../src/application/slot-offering-service.js";
import {
  InMemoryLeadRepository, InMemoryAppointmentRepository, InMemoryOfferedSlotRepository,
  InMemorySlotOfferClaimRepository, InMemorySlotOfferClaimStore, InMemoryLeadStatusHistoryRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { SlotOfferClaimInProgressError } from "../src/domain/errors.js";
import type { Lead } from "../src/domain/lead.js";
import type { CalendarProvider, CalendarEventInput, LeadRepository, OfferedSlotRepository, SlotOfferClaimRepository } from "../src/application/ports.js";
import type { SlotOfferClaim } from "../src/domain/slot-offer-claim.js";

// NOTE on test L (Phase 3B/3C regression): the definitive proof is the full existing suite
// staying green (`npm test`) -- this file adds one direct, minimal confirmation that ordinary
// non-concurrent behavior is byte-for-byte unaffected by the claim layer, without re-running the
// entire Phase 3B/3C test surface here.

/** Counts getAvailableSlots calls. */
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

async function makeLead(leads: LeadRepository, overrides: Partial<Omit<Lead, "id" | "createdAt" | "updatedAt">> = {}): Promise<Lead> {
  return leads.create({
    country: "MX", productVertical: "PATRIMONIAL", status: "QUALIFIED_A",
    score: 80, assignedAdvisor: "Hector Herrera", consentContact: true,
    ...overrides,
  });
}

/** A shared mutable "clock" + matching sleepFn: sleeping just advances the SAME clock instead of
 * waiting real wall-clock time, so polling-loop tests run instantly but still exercise the exact
 * same control flow (same number of iterations, same deadline arithmetic) as production. */
function makeAdvancingClock(startMs: number) {
  let current = startMs;
  return {
    now: () => new Date(current),
    sleepFn: async (ms: number) => {
      current += ms;
    },
  };
}

function makeService(overrides: {
  calendar?: CalendarProvider;
  offeredSlots?: OfferedSlotRepository;
  appointments?: InMemoryAppointmentRepository;
  leads?: LeadRepository;
  slotOfferClaims?: SlotOfferClaimRepository;
  clock?: () => Date;
  sleepFn?: (ms: number) => Promise<void>;
  roundIdFactory?: () => string;
  ownerTokenFactory?: () => string;
} = {}) {
  const calendar = overrides.calendar ?? new FakeCalendarProvider();
  const offeredSlots = overrides.offeredSlots ?? new InMemoryOfferedSlotRepository();
  const appointments = overrides.appointments ?? new InMemoryAppointmentRepository();
  const leads = overrides.leads ?? new InMemoryLeadRepository();
  const slotOfferClaims = overrides.slotOfferClaims ?? new InMemorySlotOfferClaimRepository();
  const logger = new FakeLogger();
  const service = new SlotOfferingService(calendar, offeredSlots, appointments, leads, slotOfferClaims, new InMemoryLeadStatusHistoryRepository(), logger, {
    clock: overrides.clock,
    sleepFn: overrides.sleepFn,
    roundIdFactory: overrides.roundIdFactory,
    ownerTokenFactory: overrides.ownerTokenFactory,
  });
  return { service, calendar, offeredSlots, appointments, leads, slotOfferClaims, logger };
}

function seedClaim(store: InMemorySlotOfferClaimStore, claim: SlotOfferClaim) {
  store.data.set(claim.conversationId, claim);
}

describe("SlotOfferingService -- claim-protected concurrency (A-D, Q, S)", () => {
  it("A: two concurrent getOrCreateOffer calls -- exactly one roundId persisted", async () => {
    const { service, leads, offeredSlots } = makeService();
    const lead = await makeLead(leads);
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    await Promise.all([
      service.getOrCreateOffer({ lead, conversationId, now }),
      service.getOrCreateOffer({ lead, conversationId, now }),
    ]);

    expect(await offeredSlots.listRoundIdsByConversationId(conversationId)).toHaveLength(1);
  });

  it("B: exactly 3 slots are persisted, never 6", async () => {
    const { service, leads, offeredSlots } = makeService();
    const lead = await makeLead(leads);
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    await Promise.all([
      service.getOrCreateOffer({ lead, conversationId, now }),
      service.getOrCreateOffer({ lead, conversationId, now }),
    ]);

    expect(await offeredSlots.listActiveByConversationId(conversationId, now)).toHaveLength(3);
  });

  it("C: the second caller resolves REUSED", async () => {
    const { service, leads } = makeService();
    const lead = await makeLead(leads);
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    const [r1, r2] = await Promise.all([
      service.getOrCreateOffer({ lead, conversationId, now }),
      service.getOrCreateOffer({ lead, conversationId, now }),
    ]);

    expect([r1.type, r2.type].sort()).toEqual(["CREATED", "REUSED"]);
  });

  it("D: at most one Calendar getAvailableSlots call in the happy concurrent case", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const { service, leads } = makeService({ calendar });
    const lead = await makeLead(leads);
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    await Promise.all([
      service.getOrCreateOffer({ lead, conversationId, now }),
      service.getOrCreateOffer({ lead, conversationId, now }),
    ]);

    expect(calendar.calls).toBe(1);
  });

  it("Q: the persisted round's round_id is exactly the claim's intendedRoundId, never freshly generated inside createRound", async () => {
    const { service, leads } = makeService({ roundIdFactory: () => "fixed-round-id", ownerTokenFactory: () => "fixed-owner-token" });
    const lead = await makeLead(leads);
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    const outcome = await service.getOrCreateOffer({ lead, conversationId, now });

    expect(outcome.type).toBe("CREATED");
    if (outcome.type !== "CREATED") throw new Error("unreachable");
    expect(outcome.slots.every((s) => s.roundId === "fixed-round-id")).toBe(true);
  });

  it("S: staleness is judged by the injected clock, never by the frozen `now` business-time argument", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const claimTime = new Date("2026-01-01T00:00:00.000Z");
    seedClaim(store, { conversationId: "conv-1", ownerToken: "owner-dead", intendedRoundId: "round-dead", claimedAt: claimTime, updatedAt: claimTime });
    // clock() starts 3 minutes after the claim (already stale relative to the 2-minute threshold)
    // and ADVANCES as the loser polls -- a clock that never advances would never let the bounded
    // poll loop's own deadline elapse, so this must still be a real (if simulated) ticking clock,
    // not a single frozen Date.
    const { now: clock, sleepFn } = makeAdvancingClock(claimTime.getTime() + 3 * 60_000);
    const slotOfferClaims = new InMemorySlotOfferClaimRepository(store);
    const { service, leads } = makeService({ slotOfferClaims, clock, sleepFn });
    const lead = await makeLead(leads);
    // Business `now` is deliberately unrelated to clock's timeline -- proves staleness never reads it.
    const businessNow = new Date("2030-01-01T00:00:00.000Z");

    const outcome = await service.getOrCreateOffer({ lead, conversationId: "conv-1", now: businessNow });

    expect(outcome.type).toBe("CREATED"); // reclaim succeeded -- staleness used clock(), not `now`
    if (outcome.type !== "CREATED") throw new Error("unreachable");
    // `now` still governs business time (TTL), completely independently of ownership staleness.
    expect(outcome.slots[0].expiresAt.getTime()).toBe(businessNow.getTime() + OFFERED_SLOT_TTL_MS);
  });
});

describe("SlotOfferingService -- fresh claim is never stolen (E, N)", () => {
  it("E: a fresh claim -- the second caller never takes ownership (SlotOfferClaimInProgressError)", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const startMs = new Date("2026-03-02T12:00:00.000Z").getTime();
    seedClaim(store, { conversationId: "conv-1", ownerToken: "owner-A", intendedRoundId: "round-A", claimedAt: new Date(startMs), updatedAt: new Date(startMs) });
    const { now: clock, sleepFn } = makeAdvancingClock(startMs);
    const slotOfferClaims = new InMemorySlotOfferClaimRepository(store);
    const { service, leads } = makeService({ slotOfferClaims, clock, sleepFn });
    const lead = await makeLead(leads);

    await expect(service.getOrCreateOffer({ lead, conversationId: "conv-1", now: new Date(startMs) })).rejects.toThrow(SlotOfferClaimInProgressError);

    const stillA = await slotOfferClaims.findByConversationId("conv-1");
    expect(stillA?.ownerToken).toBe("owner-A"); // never stolen
  });

  it("N: an owner working longer than the poll window but well under the stale threshold is never stolen from", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const startMs = new Date("2026-03-02T12:00:00.000Z").getTime();
    const claimAge = 60_000; // 60s old -- longer than the ~2.5s poll budget, well under the 2min stale threshold
    const claimedAt = new Date(startMs - claimAge);
    seedClaim(store, { conversationId: "conv-1", ownerToken: "owner-A", intendedRoundId: "round-A", claimedAt, updatedAt: claimedAt });
    const { now: clock, sleepFn } = makeAdvancingClock(startMs);
    const slotOfferClaims = new InMemorySlotOfferClaimRepository(store);
    const { service, leads } = makeService({ slotOfferClaims, clock, sleepFn });
    const lead = await makeLead(leads);

    await expect(service.getOrCreateOffer({ lead, conversationId: "conv-1", now: new Date(startMs) })).rejects.toThrow(SlotOfferClaimInProgressError);

    const stillA = await slotOfferClaims.findByConversationId("conv-1");
    expect(stillA?.ownerToken).toBe("owner-A");
  });
});

describe("SlotOfferingService -- stale-claim recovery (F, G, H)", () => {
  it("F: a stale claim can be reclaimed by the next request", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const startMs = new Date("2026-03-02T12:00:00.000Z").getTime();
    const staleClaimedAt = new Date(startMs - 3 * 60_000); // 3 minutes old -- past the 2-minute threshold
    seedClaim(store, { conversationId: "conv-1", ownerToken: "owner-dead", intendedRoundId: "round-dead", claimedAt: staleClaimedAt, updatedAt: staleClaimedAt });
    const { now: clock, sleepFn } = makeAdvancingClock(startMs);
    const slotOfferClaims = new InMemorySlotOfferClaimRepository(store);
    const { service, leads, offeredSlots } = makeService({ slotOfferClaims, clock, sleepFn });
    const lead = await makeLead(leads);

    const outcome = await service.getOrCreateOffer({ lead, conversationId: "conv-1", now: new Date(startMs) });

    expect(outcome.type).toBe("CREATED");
    expect(await slotOfferClaims.findByConversationId("conv-1")).toBeNull(); // released after successful persist
    const rounds = await offeredSlots.listRoundIdsByConversationId("conv-1");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).not.toBe("round-dead"); // fresh roundId, never the dead owner's
  });

  it("G: two concurrent recoveries over the same stale claim -- exactly one wins the reclaim; the loser gets SlotOfferClaimInProgressError, never a second round", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const startMs = new Date("2026-03-02T12:00:00.000Z").getTime();
    const staleClaimedAt = new Date(startMs - 3 * 60_000);
    seedClaim(store, { conversationId: "conv-1", ownerToken: "owner-dead", intendedRoundId: "round-dead", claimedAt: staleClaimedAt, updatedAt: staleClaimedAt });
    const { now: clock, sleepFn } = makeAdvancingClock(startMs);
    const slotOfferClaims = new InMemorySlotOfferClaimRepository(store);
    const { service, leads, offeredSlots } = makeService({ slotOfferClaims, clock, sleepFn });
    const lead = await makeLead(leads);

    // Both calls lose the initial tryCreate (a claim already exists), both poll and find nothing
    // persisted yet, and both attempt the stale reclaim once the poll budget is exhausted -- per
    // the approved design (section 12), losing that single reclaim attempt is
    // SlotOfferClaimInProgressError, not a fallback to REUSED (there is no re-poll after losing
    // a reclaim). Using allSettled since one of the two calls is expected to reject.
    const [r1, r2] = await Promise.allSettled([
      service.getOrCreateOffer({ lead, conversationId: "conv-1", now: new Date(startMs) }),
      service.getOrCreateOffer({ lead, conversationId: "conv-1", now: new Date(startMs) }),
    ]);

    expect(await offeredSlots.listRoundIdsByConversationId("conv-1")).toHaveLength(1); // exactly one round, never two
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(["fulfilled", "rejected"]);
    const rejected = [r1, r2].find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(SlotOfferClaimInProgressError);
    const fulfilled = [r1, r2].find((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof service.getOrCreateOffer>>>;
    expect(fulfilled.value.type).toBe("CREATED");
  });

  it("H: the owner dying before ever persisting anything -- recovery starts from zero rows and ends with exactly one round", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const startMs = new Date("2026-03-02T12:00:00.000Z").getTime();
    const staleClaimedAt = new Date(startMs - 3 * 60_000);
    seedClaim(store, { conversationId: "conv-1", ownerToken: "owner-dead", intendedRoundId: "round-dead", claimedAt: staleClaimedAt, updatedAt: staleClaimedAt });
    const { now: clock, sleepFn } = makeAdvancingClock(startMs);
    const slotOfferClaims = new InMemorySlotOfferClaimRepository(store);
    const { service, leads, offeredSlots } = makeService({ slotOfferClaims, clock, sleepFn });
    const lead = await makeLead(leads);

    expect(await offeredSlots.listActiveByConversationId("conv-1", new Date(startMs))).toHaveLength(0); // nothing ever persisted by the dead owner

    const outcome = await service.getOrCreateOffer({ lead, conversationId: "conv-1", now: new Date(startMs) });

    expect(outcome.type).toBe("CREATED");
    expect(await offeredSlots.listActiveByConversationId("conv-1", new Date(startMs))).toHaveLength(3);
  });
});

describe("SlotOfferingService -- persisted-but-not-released claims never cause a duplicate round (I, R)", () => {
  it("I: owner persisted a round but never released the claim -- REUSED, no new round, claim untouched", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const now = new Date("2026-03-02T12:00:00.000Z");
    const slotOfferClaims = new InMemorySlotOfferClaimRepository(store);
    const { service, leads, offeredSlots } = makeService({ slotOfferClaims });
    const lead = await makeLead(leads, { status: "BOOKING_PENDING", bookingStartedAt: now });
    const conversationId = randomUUID();
    const roundId = randomUUID();
    await offeredSlots.createMany([
      { conversationId, leadId: lead.id, roundId, slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() + 600_000), selected: false },
    ]);
    seedClaim(store, { conversationId, ownerToken: "owner-orphan", intendedRoundId: roundId, claimedAt: now, updatedAt: now });

    const outcome = await service.getOrCreateOffer({ lead, conversationId, now });

    expect(outcome.type).toBe("REUSED");
    expect(await offeredSlots.listRoundIdsByConversationId(conversationId)).toHaveLength(1); // no new round
    const claimStillThere = await slotOfferClaims.findByConversationId(conversationId);
    expect(claimStillThere?.ownerToken).toBe("owner-orphan"); // untouched -- the active-slots check short-circuits before the claim is ever consulted
  });

  it("R: active slots already persisted with a FRESH claim still present -- REUSED, claim never consulted for reclaim logic", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const now = new Date("2026-03-02T12:00:00.000Z");
    const slotOfferClaims = new InMemorySlotOfferClaimRepository(store);
    const { service, leads, offeredSlots } = makeService({ slotOfferClaims });
    const lead = await makeLead(leads, { status: "BOOKING_PENDING", bookingStartedAt: now });
    const conversationId = randomUUID();
    const roundId = randomUUID();
    await offeredSlots.createMany([
      { conversationId, leadId: lead.id, roundId, slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() + 600_000), selected: false },
    ]);
    seedClaim(store, { conversationId, ownerToken: "owner-still-working", intendedRoundId: roundId, claimedAt: now, updatedAt: now }); // fresh, not stale

    const outcome = await service.getOrCreateOffer({ lead, conversationId, now });

    expect(outcome.type).toBe("REUSED");
    const claimStillThere = await slotOfferClaims.findByConversationId(conversationId);
    expect(claimStillThere?.ownerToken).toBe("owner-still-working");
  });
});

describe("SlotOfferingService -- existing recovery paths unaffected by the claim layer (J, L)", () => {
  it("J: transition fails after the round is persisted -- the claim still releases, and existing recovery still works", async () => {
    const offeredSlots = new InMemoryOfferedSlotRepository();
    const appointments = new InMemoryAppointmentRepository();
    const realLeads = new InMemoryLeadRepository();
    const slotOfferClaims = new InMemorySlotOfferClaimRepository();
    let failNextUpdate = true;
    const flakyLeads: LeadRepository = {
      create: (input) => realLeads.create(input),
      findById: (id) => realLeads.findById(id),
      findByDedupKey: (key) => realLeads.findByDedupKey(key),
      findByEmail: (email) => realLeads.findByEmail(email),
      findByPhoneE164: (phoneE164) => realLeads.findByPhoneE164(phoneE164),
      update: (id, patch) => {
        if (failNextUpdate) {
          failNextUpdate = false;
          return Promise.reject(new Error("LEAD_UPDATE_DOWN"));
        }
        return realLeads.update(id, patch);
      },
    };
    const { service } = makeService({ offeredSlots, appointments, leads: flakyLeads, slotOfferClaims });
    const lead = await realLeads.create({
      country: "MX", productVertical: "PATRIMONIAL", status: "QUALIFIED_A",
      score: 80, assignedAdvisor: "Hector Herrera", consentContact: true,
    });
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    await expect(service.getOrCreateOffer({ lead, conversationId, now })).rejects.toThrow("LEAD_UPDATE_DOWN");
    expect(await slotOfferClaims.findByConversationId(conversationId)).toBeNull(); // released despite the transition failure (finally block)

    const stillQualified = await realLeads.findById(lead.id);
    const outcome = await service.getOrCreateOffer({ lead: stillQualified!, conversationId, now: new Date(now.getTime() + 1_000) });
    expect(outcome.type).toBe("REUSED");
  });

  it("L: normal, non-concurrent Phase 3B/3C behavior is unaffected by the claim layer", async () => {
    const { service, leads } = makeService();
    const lead = await makeLead(leads);
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    const created = await service.getOrCreateOffer({ lead, conversationId, now });
    expect(created.type).toBe("CREATED");
    if (created.type !== "CREATED") throw new Error("unreachable");

    const reused = await service.getOrCreateOffer({ lead: created.lead, conversationId, now });
    expect(reused.type).toBe("REUSED");
  });
});

describe("SlotOfferingService -- multi-instance semantics (K, M)", () => {
  it("K: two separate repository/service instances sharing one backing store -- exclusion still holds", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const offeredSlots = new InMemoryOfferedSlotRepository();
    const appointments = new InMemoryAppointmentRepository();
    const leads = new InMemoryLeadRepository();
    const calendar = new FakeCalendarProvider();
    const lead = await makeLead(leads);
    const conversationId = randomUUID();
    const now = new Date("2026-03-02T12:00:00.000Z");

    // Two structurally independent SlotOfferingService instances (as if in two separate app
    // processes), each with its OWN SlotOfferClaimRepository wrapper -- but both wrappers point
    // at the SAME backing store, simulating "the same Postgres table" rather than two unrelated
    // in-memory tables that would trivially never conflict.
    const instanceA = new SlotOfferingService(calendar, offeredSlots, appointments, leads, new InMemorySlotOfferClaimRepository(store), new InMemoryLeadStatusHistoryRepository(), new FakeLogger());
    const instanceB = new SlotOfferingService(calendar, offeredSlots, appointments, leads, new InMemorySlotOfferClaimRepository(store), new InMemoryLeadStatusHistoryRepository(), new FakeLogger());

    const [r1, r2] = await Promise.all([
      instanceA.getOrCreateOffer({ lead, conversationId, now }),
      instanceB.getOrCreateOffer({ lead, conversationId, now }),
    ]);

    expect(await offeredSlots.listRoundIdsByConversationId(conversationId)).toHaveLength(1);
    expect([r1.type, r2.type].sort()).toEqual(["CREATED", "REUSED"]);
  });

  it("M: an old owner's release after being stale-reclaimed by a DIFFERENT instance affects 0 rows and never deletes the new owner's claim", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const startMs = new Date("2026-03-02T12:00:00.000Z").getTime();
    const staleClaimedAt = new Date(startMs - 3 * 60_000);
    seedClaim(store, { conversationId: "conv-1", ownerToken: "owner-A", intendedRoundId: "round-A", claimedAt: staleClaimedAt, updatedAt: staleClaimedAt });

    // Instance B reclaims (simulating a different process recovering the abandoned claim).
    const repoB = new InMemorySlotOfferClaimRepository(store);
    const reclaimed = await repoB.tryReclaim({
      conversationId: "conv-1", expectedOwnerToken: "owner-A", newOwnerToken: "owner-B",
      intendedRoundId: "round-B", staleBefore: new Date(startMs - 2 * 60_000), now: new Date(startMs),
    });
    expect(reclaimed?.ownerToken).toBe("owner-B");

    // Instance A "wakes up" (its own repo wrapper, same backing store) and tries to release
    // using its now-stale ownerToken.
    const repoA = new InMemorySlotOfferClaimRepository(store);
    const releasedByA = await repoA.release("conv-1", "owner-A");

    expect(releasedByA).toBe(false);
    const stillB = await repoA.findByConversationId("conv-1");
    expect(stillB?.ownerToken).toBe("owner-B"); // B's claim is never touched by A's stale release
  });
});
