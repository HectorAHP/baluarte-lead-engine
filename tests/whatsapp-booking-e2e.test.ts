import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it, vi, afterEach } from "vitest";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryQualificationAnswerRepository, InMemoryLeadScoreRepository, InMemoryAppointmentRepository,
  InMemoryBookingAttemptRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
  InMemoryLeadStatusHistoryRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { AppointmentService } from "../src/application/services.js";
import { SlotOfferingService } from "../src/application/slot-offering-service.js";
import { WhatsAppBookingHandler } from "../src/application/whatsapp-booking-handler.js";
import { QUALIFICATION_COMPLETE_AB_MESSAGE, NURTURE_C_MESSAGE, SLOT_OFFER_CLAIM_IN_PROGRESS_MESSAGE } from "../src/domain/message-templates.js";
import { SlotOfferClaimInProgressError } from "../src/domain/errors.js";
import type { CalendarProvider, CalendarEventInput, MessagingProvider, SendMessageResult } from "../src/application/ports.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";

// ---------------------------------------------------------------------------------------------
// helpers -- deliberately local to this file (same convention as the other E2E test files).
// ---------------------------------------------------------------------------------------------

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function textWebhookBody(overrides: { from?: string; id?: string; body?: string; name?: string } = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ profile: { name: overrides.name ?? "Ana" }, wa_id: overrides.from ?? "5214771234567" }],
              messages: [{ from: overrides.from ?? "5214771234567", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
            },
          },
        ],
      },
    ],
  });
}

function buildRepos() {
  return {
    leadsRepo: new InMemoryLeadRepository(),
    conversationsRepo: new InMemoryConversationRepository(),
    messagesRepo: new InMemoryMessageRepository(),
    qualificationAnswersRepo: new InMemoryQualificationAnswerRepository(),
    leadScoresRepo: new InMemoryLeadScoreRepository(),
    appointmentsRepo: new InMemoryAppointmentRepository(),
    bookingAttemptsRepo: new InMemoryBookingAttemptRepository(),
    offeredSlotsRepo: new InMemoryOfferedSlotRepository(),
    slotOfferClaimsRepo: new InMemorySlotOfferClaimRepository(),
    leadStatusHistoryRepo: new InMemoryLeadStatusHistoryRepository(),
    calendar: new FakeCalendarProvider(),
  };
}

async function send(app: Awaited<ReturnType<typeof buildTestApp>>, from: string, id: string, body: string) {
  const payload = textWebhookBody({ from, id, body });
  return app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    payload,
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET) },
  });
}

/** Directly constructs a lead already sitting at a given lifecycle status with an ACTIVE
 * conversation, bypassing the normal transition flow (mirrors the identical helper already used
 * in whatsapp-qualification-e2e.test.ts). */
async function createLeadAtStatus(
  repos: ReturnType<typeof buildRepos>,
  whatsappUserId: string,
  status: LeadStatus,
  overrides: Partial<Lead> = {},
) {
  const lead = await repos.leadsRepo.create({
    country: "MX", productVertical: "PATRIMONIAL", status: "NEW", score: 80,
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId,
    ...overrides,
  });
  await repos.leadsRepo.update(lead.id, { status, ...overrides });
  const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead: (await repos.leadsRepo.findById(lead.id))!, conversation };
}

/** A CalendarProvider wrapper counting createEvent calls -- used for the concurrency tests to
 * prove at most one Google event is ever created for a given race. */
class CountingCreateEventCalendar implements CalendarProvider {
  createEventCalls = 0;
  constructor(private readonly inner: CalendarProvider) {}
  async getAvailableSlots(from: Date, to: Date, durationMinutes: number) {
    return this.inner.getAvailableSlots(from, to, durationMinutes);
  }
  async isSlotAvailable(start: Date, end: Date) {
    return this.inner.isSlotAvailable(start, end);
  }
  async createEvent(input: CalendarEventInput) {
    this.createEventCalls++;
    return this.inner.createEvent(input);
  }
  async deleteEvent(eventId: string) {
    return this.inner.deleteEvent(eventId);
  }
}

/** Always fails to send -- used for the K/L "outbound fails after persistence" recovery tests. */
class AlwaysFailingMessaging implements MessagingProvider {
  async sendText(): Promise<SendMessageResult> {
    throw new Error("WHATSAPP_SEND_DOWN");
  }
  async sendTemplate(): Promise<SendMessageResult> {
    throw new Error("WHATSAPP_SEND_DOWN");
  }
  async markRead(): Promise<void> {}
}

function makeBookingHarness(overrides: { calendar?: CalendarProvider } = {}) {
  const calendar = overrides.calendar ?? new FakeCalendarProvider();
  const repos = buildRepos();
  const bookingAttempts = repos.bookingAttemptsRepo;
  const logger = new FakeLogger();
  const appointmentService = new AppointmentService(calendar, repos.appointmentsRepo, bookingAttempts, repos.leadsRepo, logger);
  const slotOffering = new SlotOfferingService(calendar, repos.offeredSlotsRepo, repos.appointmentsRepo, repos.leadsRepo, repos.slotOfferClaimsRepo, repos.leadStatusHistoryRepo, new FakeLogger());
  const messaging = new FakeMessagingProvider();
  const handler = new WhatsAppBookingHandler(
    {
      leads: repos.leadsRepo, conversations: repos.conversationsRepo, appointments: repos.appointmentsRepo,
      offeredSlots: repos.offeredSlotsRepo, slotOffering, appointmentService, messaging, messages: repos.messagesRepo,
      leadStatusHistory: repos.leadStatusHistoryRepo, logger,
    },
    "America/Mexico_City",
  );
  return { repos, calendar, appointmentService, slotOffering, messaging, logger, handler };
}

const GMM_TO_QUALIFIED_B_TURNS = ["Hola", "seguro médico", "3", "2", "León, Guanajuato, 37150", "4", "sí", "3"];
const SAVINGS_TO_NURTURE_C_TURNS = ["Hola", "quiero ahorrar", "5", "2", "1", "sí", "3"];
const SAVINGS_TO_QUALIFIED_A_TURNS = ["Hola", "1", "1", "1", "5", "sí", "1"];

// ---------------------------------------------------------------------------------------------
// 7. Feature flag matrix
// ---------------------------------------------------------------------------------------------

describe("Phase 3C -- feature flag matrix", () => {
  it("A: QUALIFICATION_ENGINE_ENABLED=false, WHATSAPP_BOOKING_ENABLED=false -- Phase 2 intact", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: false, whatsappBookingEnabled: false, ...repos });
    const from = "5214776000001";
    await send(app, from, "wamid.a1", "Hola");
    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("CONTACTED");
    expect(messaging.sentTexts).toHaveLength(1);
    expect(messaging.sentTexts[0].body).toContain("Baluarte Capital");
  });

  it("B: qualification=true, booking=false -- Phase 3B intact (QUALIFIED_A, no offer)", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, whatsappBookingEnabled: false, ...repos });
    const from = "5214776000002";
    for (const [i, t] of SAVINGS_TO_QUALIFIED_A_TURNS.entries()) await send(app, from, `wamid.b.${i}`, t);
    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("QUALIFIED_A");
    expect(messaging.sentTexts.at(-1)?.body).toBe(QUALIFICATION_COMPLETE_AB_MESSAGE);
  });

  it("C: qualification=true, booking=true -- A/B offers slots and moves to BOOKING_PENDING", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, whatsappBookingEnabled: true, ...repos });
    const from = "5214776000003";
    for (const [i, t] of SAVINGS_TO_QUALIFIED_A_TURNS.entries()) await send(app, from, `wamid.c.${i}`, t);
    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("BOOKING_PENDING");
    expect(messaging.sentTexts.at(-1)?.body).toContain("Tengo estas opciones disponibles");
  });

  it("D: qualification=true, booking=true -- NURTURE_C never offers slots", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, whatsappBookingEnabled: true, ...repos });
    const from = "5214776000004";
    for (const [i, t] of SAVINGS_TO_NURTURE_C_TURNS.entries()) await send(app, from, `wamid.d.${i}`, t);
    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("NURTURE_C");
    expect(messaging.sentTexts.at(-1)?.body).toBe(NURTURE_C_MESSAGE);
    expect(await repos.offeredSlotsRepo.listRoundIdsByConversationId((await repos.conversationsRepo.findActiveByLeadId(lead!.id))!.id)).toHaveLength(0);
  });

  it("E: qualification=false, booking=true -- booking never activates for a new lead that never qualifies", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: false, whatsappBookingEnabled: true, ...repos });
    const from = "5214776000005";
    await send(app, from, "wamid.e1", "Hola");
    await send(app, from, "wamid.e2", "1");
    await send(app, from, "wamid.e3", "otra vez 1");
    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    // No qualifier running -- lead stays CONTACTED forever from here, exactly Phase 2. Booking
    // flag alone can never move a lead to BOOKING_PENDING; only completing qualification can.
    expect(lead?.status).toBe("CONTACTED");
    expect(messaging.sentTexts).toHaveLength(1); // only the welcome message -- no qualifier, no booking
  });
});

// ---------------------------------------------------------------------------------------------
// 8. Full in-memory E2E
// ---------------------------------------------------------------------------------------------

describe("Phase 3C -- full E2E (in-memory, no real network)", () => {
  it("A: SAVINGS -> QUALIFIED_A -> offer -> BOOKING_PENDING -> \"1\" -> BOOKED, selected=true, exactly one confirmation", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, whatsappBookingEnabled: true, ...repos });
    const from = "5214777000001";
    for (const [i, t] of SAVINGS_TO_QUALIFIED_A_TURNS.entries()) await send(app, from, `wamid.e2ea.${i}`, t);
    const beforeSelection = messaging.sentTexts.length;

    await send(app, from, "wamid.e2ea.select", "1");

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("BOOKED");
    const appointment = await repos.appointmentsRepo.findActiveByLeadId(lead!.id);
    expect(appointment).toBeTruthy();
    expect(messaging.sentTexts).toHaveLength(beforeSelection + 1); // exactly one confirmation
    expect(messaging.sentTexts.at(-1)?.body).toContain("Listo, tu cita quedó agendada");
  });

  it("B: GMM -> QUALIFIED_B -> offer -> BOOKING_PENDING -> \"1\" -> BOOKED", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, whatsappBookingEnabled: true, ...repos });
    const from = "5214777000002";
    for (const [i, t] of GMM_TO_QUALIFIED_B_TURNS.entries()) await send(app, from, `wamid.e2eb.${i}`, t);
    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.scoreClass).toBe("B");
    expect(lead?.status).toBe("BOOKING_PENDING");

    await send(app, from, "wamid.e2eb.select", "1");

    const reloaded = await repos.leadsRepo.findById(lead!.id);
    expect(reloaded?.status).toBe("BOOKED");
    expect(await repos.appointmentsRepo.findActiveByLeadId(lead!.id)).toBeTruthy();
  });

  it("D: INVALID -- resends the same active options, no new round", async () => {
    const { repos, handler, calendar } = makeBookingHarness();
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778000004", "BOOKING_PENDING", { bookingStartedAt: new Date() });
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await new SlotOfferingService(calendar, repos.offeredSlotsRepo, repos.appointmentsRepo, repos.leadsRepo, repos.slotOfferClaimsRepo, repos.leadStatusHistoryRepo, new FakeLogger()).getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: "5214778000004", inboundText: "no se", now });

    expect(await repos.offeredSlotsRepo.listRoundIdsByConversationId(conversation.id)).toHaveLength(1);
  });

  it("E: DECLINED -- a new round is created", async () => {
    const { repos, handler, calendar } = makeBookingHarness();
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778000005", "BOOKING_PENDING", { bookingStartedAt: new Date() });
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await new SlotOfferingService(calendar, repos.offeredSlotsRepo, repos.appointmentsRepo, repos.leadsRepo, repos.slotOfferClaimsRepo, repos.leadStatusHistoryRepo, new FakeLogger()).getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: "5214778000005", inboundText: "ninguno", now });

    expect(await repos.offeredSlotsRepo.listRoundIdsByConversationId(conversation.id)).toHaveLength(2);
  });

  it("F: a 3rd round is allowed; a 4th request escalates to HUMAN_HANDOFF", async () => {
    const { repos, handler } = makeBookingHarness();
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778000006", "BOOKING_PENDING", { bookingStartedAt: new Date() });
    const now = new Date("2026-03-02T12:00:00.000Z");
    for (const roundId of ["r1", "r2", "r3"]) {
      await repos.offeredSlotsRepo.createMany([
        { conversationId: conversation.id, leadId: lead.id, roundId, slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() - 1_000), selected: false },
      ]);
    }

    await handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214778000006", inboundText: "hola", now });

    const reloaded = await repos.leadsRepo.findById(lead.id);
    expect(reloaded?.status).toBe("HUMAN_HANDOFF");
    const reloadedConversation = await repos.conversationsRepo.findById(conversation.id);
    expect(reloadedConversation?.status).toBe("HUMAN_HANDOFF");
    // Score/scoreClass untouched by the handoff.
    expect(reloaded?.score).toBe(lead.score);
    expect(reloaded?.scoreClass).toBe(lead.scoreClass);
  });

  it("G: a slot occupied between offer and selection triggers exactly one replaceOffer", async () => {
    const { repos, handler, calendar } = makeBookingHarness();
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778000007", "BOOKING_PENDING", { bookingStartedAt: new Date() });
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await new SlotOfferingService(calendar, repos.offeredSlotsRepo, repos.appointmentsRepo, repos.leadsRepo, repos.slotOfferClaimsRepo, repos.leadStatusHistoryRepo, new FakeLogger()).getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");
    await calendar.createEvent({ title: "other", description: "", start: offer.slots[0].slotStart, end: offer.slots[0].slotEnd });

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: "5214778000007", inboundText: "1", now });

    expect(await repos.appointmentsRepo.findActiveByLeadId(lead.id)).toBeNull();
    expect(await repos.offeredSlotsRepo.listRoundIdsByConversationId(conversation.id)).toHaveLength(2);
  });

  it("H: an existing appointment -- no second appointment is ever created", async () => {
    const { repos, handler, calendar } = makeBookingHarness();
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778000008", "BOOKING_PENDING", { bookingStartedAt: new Date() });
    const now = new Date("2026-03-02T12:00:00.000Z");
    const appt = await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-03T15:00:00.000Z"), endsAt: new Date("2026-03-03T15:30:00.000Z"),
      timezone: "America/Mexico_City", meetingUrl: "https://meet.google.com/existing",
    });

    await handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214778000008", inboundText: "1", now });

    const active = await repos.appointmentsRepo.findActiveByLeadId(lead.id);
    expect(active?.id).toBe(appt.id);
    expect(calendar).toBeTruthy(); // no Calendar-based creation attempted -- guard short-circuits before any Calendar call
  });

  it("I: a duplicate inbound (same provider_message_id) never reaches the booking handler twice", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, whatsappBookingEnabled: true, ...repos });
    const from = "5214777000009";
    for (const [i, t] of SAVINGS_TO_QUALIFIED_A_TURNS.entries()) await send(app, from, `wamid.dup.${i}`, t);
    const beforeSelection = messaging.sentTexts.length;

    // Same providerMessageId sent twice -- the existing dedup (messages.findByProviderMessageId,
    // checked before any handler ever runs) must short-circuit the second delivery entirely.
    await send(app, from, "wamid.dup.select", "1");
    await send(app, from, "wamid.dup.select", "1");

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    const appointment = await repos.appointmentsRepo.findActiveByLeadId(lead!.id);
    expect(appointment).toBeTruthy();
    expect(messaging.sentTexts).toHaveLength(beforeSelection + 1); // not +2 -- the duplicate never ran
  });

  it("J: two near-simultaneous inbounds selecting the same slot -- at most one Calendar event, at most one appointment", async () => {
    const innerCalendar = new FakeCalendarProvider();
    const calendar = new CountingCreateEventCalendar(innerCalendar);
    const { repos, handler } = makeBookingHarness({ calendar });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778000010", "BOOKING_PENDING", { bookingStartedAt: new Date() });
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await new SlotOfferingService(calendar, repos.offeredSlotsRepo, repos.appointmentsRepo, repos.leadsRepo, repos.slotOfferClaimsRepo, repos.leadStatusHistoryRepo, new FakeLogger()).getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");

    await Promise.all([
      handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: "5214778000010", inboundText: "1", now }),
      handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: "5214778000010", inboundText: "1", now }),
    ]);

    expect(calendar.createEventCalls).toBe(1); // the booking_attempts CAS foundation makes this safe
    const active = await repos.appointmentsRepo.findActiveByLeadId(lead.id);
    expect(active).toBeTruthy();
    // No inconsistent/racy write on the lead either -- exactly one consistent meetingAt, matching
    // the single appointment that actually won the race.
    const reloadedLead = await repos.leadsRepo.findById(lead.id);
    expect(reloadedLead?.meetingAt).toEqual(active?.startsAt);
    expect(reloadedLead?.status).toBe("BOOKED");
  });

  it("K: the offer outbound fails after persistence -- BOOKING_PENDING and slots persist; the next inbound recovers", async () => {
    const { repos, calendar } = makeBookingHarness();
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778000011", "QUALIFIED_A");
    const now = new Date("2026-03-02T12:00:00.000Z");
    const failingMessaging = new AlwaysFailingMessaging();
    const slotOffering = new SlotOfferingService(calendar, repos.offeredSlotsRepo, repos.appointmentsRepo, repos.leadsRepo, repos.slotOfferClaimsRepo, repos.leadStatusHistoryRepo, new FakeLogger());
    const appointmentService = new AppointmentService(calendar, repos.appointmentsRepo, repos.bookingAttemptsRepo, repos.leadsRepo, new FakeLogger());
    const failingHandler = new WhatsAppBookingHandler(
      { leads: repos.leadsRepo, conversations: repos.conversationsRepo, appointments: repos.appointmentsRepo, offeredSlots: repos.offeredSlotsRepo, slotOffering, appointmentService, messaging: failingMessaging, messages: repos.messagesRepo, leadStatusHistory: repos.leadStatusHistoryRepo, logger: new FakeLogger() },
      "America/Mexico_City",
    );

    // First offer, via getOrCreateOffer directly (mirrors what the qualification-complete wiring
    // does) -- persistence succeeds, the send fails and is swallowed internally by
    // sendAndPersistReply (never thrown), so the lead correctly reaches BOOKING_PENDING anyway.
    const outcome = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (outcome.type !== "CREATED") throw new Error("unreachable");
    expect(outcome.lead.status).toBe("BOOKING_PENDING");
    const persisted = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, now);
    expect(persisted).toHaveLength(3);
    expect(await repos.messagesRepo.listByConversationId(conversation.id)).toHaveLength(0); // send failed -- nothing persisted as outbound

    // Next inbound: a working messaging provider now -- recovers the SAME persisted offer.
    const workingMessaging = new FakeMessagingProvider();
    const recoveredHandler = new WhatsAppBookingHandler(
      { leads: repos.leadsRepo, conversations: repos.conversationsRepo, appointments: repos.appointmentsRepo, offeredSlots: repos.offeredSlotsRepo, slotOffering, appointmentService, messaging: workingMessaging, messages: repos.messagesRepo, leadStatusHistory: repos.leadStatusHistoryRepo, logger: new FakeLogger() },
      "America/Mexico_City",
    );
    // Active slots already exist, so this inbound is interpreted against them (INVALID, since
    // "hola" isn't a selection) rather than re-triggering getOrCreateOffer -- the recovery goal
    // (the lead sees the SAME persisted options again) is met either way; this just proves which
    // code path actually delivers it.
    await recoveredHandler.handleTurn({ lead: outcome.lead, conversationId: conversation.id, whatsappUserId: "5214778000011", inboundText: "hola", now });
    expect(workingMessaging.sentTexts).toHaveLength(1);
    // Pre-launch hardening: no longer the terse "Por favor responde 1, 2 o 3" nag -- see
    // buildBookingPendingFallbackMessage; still restates the SAME persisted options either way.
    expect(workingMessaging.sentTexts[0].body).toContain("Estamos en el proceso de agendar tu cita");
    expect(workingMessaging.sentTexts[0].body).toContain(persisted[0].position.toString());
    expect(await repos.offeredSlotsRepo.listRoundIdsByConversationId(conversation.id)).toHaveLength(1); // still the same round -- no duplicate
  });

  it("L: the confirmation outbound fails after the appointment is created -- the appointment stays BOOKED; a retry never creates a second one", async () => {
    const { repos, calendar } = makeBookingHarness();
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778000012", "BOOKING_PENDING", { bookingStartedAt: new Date() });
    const now = new Date("2026-03-02T12:00:00.000Z");
    const slotOffering = new SlotOfferingService(calendar, repos.offeredSlotsRepo, repos.appointmentsRepo, repos.leadsRepo, repos.slotOfferClaimsRepo, repos.leadStatusHistoryRepo, new FakeLogger());
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");

    const appointmentService = new AppointmentService(calendar, repos.appointmentsRepo, repos.bookingAttemptsRepo, repos.leadsRepo, new FakeLogger());
    const failingMessaging = new AlwaysFailingMessaging();
    const failingHandler = new WhatsAppBookingHandler(
      { leads: repos.leadsRepo, conversations: repos.conversationsRepo, appointments: repos.appointmentsRepo, offeredSlots: repos.offeredSlotsRepo, slotOffering, appointmentService, messaging: failingMessaging, messages: repos.messagesRepo, leadStatusHistory: repos.leadStatusHistoryRepo, logger: new FakeLogger() },
      "America/Mexico_City",
    );

    // Booking itself (appointment creation, slot selected, lead BOOKED) all happen BEFORE the
    // confirmation send -- the send failing afterward must never roll any of that back. There is
    // no automatic outbound retry for a delivery failure: recovery here means the appointment
    // remains correctly BOOKED and discoverable, never that the confirmation is resent
    // automatically -- an operator/future feature can resend from the persisted appointment data,
    // but this handler never recreates an appointment to "retry" a confirmation.
    await failingHandler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: "5214778000012", inboundText: "1", now });

    const afterFirst = await repos.appointmentsRepo.findActiveByLeadId(lead.id);
    expect(afterFirst).toBeTruthy();
    const leadAfterFirst = await repos.leadsRepo.findById(lead.id);
    expect(leadAfterFirst?.status).toBe("BOOKED");
    // The confirmation SEND failing (AlwaysFailingMessaging) never reverts what completeBooking
    // already durably wrote -- bookedAt/meetingAt are set before the send is ever attempted.
    expect(leadAfterFirst?.bookedAt).toBeInstanceOf(Date);
    expect(leadAfterFirst?.meetingAt).toEqual(afterFirst?.startsAt);

    // A later inbound with a working provider -- appointment guard catches it immediately,
    // replies idempotently, never books again. Uses a stale BOOKING_PENDING lead snapshot to
    // exercise this (once lead.status is really BOOKED, whatsapp-inbound-service.ts's own
    // routing guard -- lead.status === "BOOKING_PENDING" -- would never dispatch here again at
    // all, per section 6's "no re-entry once BOOKED" requirement; the appointment guard inside
    // the handler is the second, independent layer of that same safety).
    const workingMessaging = new FakeMessagingProvider();
    const recoveredHandler = new WhatsAppBookingHandler(
      { leads: repos.leadsRepo, conversations: repos.conversationsRepo, appointments: repos.appointmentsRepo, offeredSlots: repos.offeredSlotsRepo, slotOffering, appointmentService, messaging: workingMessaging, messages: repos.messagesRepo, leadStatusHistory: repos.leadStatusHistoryRepo, logger: new FakeLogger() },
      "America/Mexico_City",
    );
    const staleLead = { ...leadAfterFirst!, status: "BOOKING_PENDING" as const };
    await recoveredHandler.handleTurn({ lead: staleLead, conversationId: conversation.id, whatsappUserId: "5214778000012", inboundText: "hola", now });

    const afterRetry = await repos.appointmentsRepo.findActiveByLeadId(lead.id);
    expect(afterRetry?.id).toBe(afterFirst?.id); // same appointment -- never a second one
    const leadAfterRetry = await repos.leadsRepo.findById(lead.id);
    expect(leadAfterRetry?.meetingAt).toEqual(afterFirst?.startsAt); // unchanged by the retry -- markLeadBooked's backfill guard is a no-op once already set
    expect(workingMessaging.sentTexts).toHaveLength(1);
    expect(workingMessaging.sentTexts[0].body).toContain("Ya tienes una cita agendada");
  });
});

// ---------------------------------------------------------------------------------------------
// 9. Slot-offering concurrency at qualification-completion time
// ---------------------------------------------------------------------------------------------
//
// The race this section used to document ("two near-simultaneous getOrCreateOffer calls with no
// pre-existing offer can both create a round") is now closed by the slot_offer_claims ownership
// mechanism -- see tests/slot-offering-claim.test.ts (tests A-S) for the exhaustive concurrency
// suite. This file keeps one end-to-end confirmation that the fix is actually wired into the
// real getOrCreateOffer entrypoint used by qualification-completion, not just unit-tested in
// isolation.

describe("Phase 3C -- slot-offering concurrency (fixed by slot_offer_claims)", () => {
  it("two near-simultaneous getOrCreateOffer calls with no pre-existing offer -- exactly one round persisted, the loser is REUSED", async () => {
    const calendar = new FakeCalendarProvider();
    const repos = buildRepos();
    const slotOffering = new SlotOfferingService(calendar, repos.offeredSlotsRepo, repos.appointmentsRepo, repos.leadsRepo, repos.slotOfferClaimsRepo, repos.leadStatusHistoryRepo, new FakeLogger());
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778000099", "QUALIFIED_A");
    const now = new Date("2026-03-02T12:00:00.000Z");

    const [r1, r2] = await Promise.all([
      slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now }),
      slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now }),
    ]);

    const roundIds = await repos.offeredSlotsRepo.listRoundIdsByConversationId(conversation.id);
    expect(roundIds).toHaveLength(1); // exactly one round -- never two, regardless of interleaving
    const outcomeTypes = [r1.type, r2.type].sort();
    expect(outcomeTypes).toEqual(["CREATED", "REUSED"]); // one winner, one reused -- never two CREATED
  });
});

// ---------------------------------------------------------------------------------------------
// Hardening: SlotOfferClaimInProgressError right after qualification completes must never be
// conflated with a data-consistency problem -- see WhatsAppQualificationHandler's dedicated
// catch branch. D and E (ActiveOfferInconsistentError / BookingAttemptInconsistentError still
// escalate to HUMAN_HANDOFF) are unchanged regressions, already covered by the existing
// "I"/"J" tests in tests/whatsapp-booking-handler.test.ts -- not duplicated here.
// ---------------------------------------------------------------------------------------------

describe("Phase 3C hardening -- SlotOfferClaimInProgressError right after qualification completes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("B: QUALIFIED_A completion with the offer claim busy -- qualification is preserved, no HUMAN_HANDOFF, recoverable message", async () => {
    vi.spyOn(SlotOfferingService.prototype, "getOrCreateOffer").mockRejectedValueOnce(new SlotOfferClaimInProgressError("conv-busy"));
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, whatsappBookingEnabled: true, ...repos });
    const from = "5214779000001";
    for (const [i, t] of SAVINGS_TO_QUALIFIED_A_TURNS.entries()) await send(app, from, `wamid.hard.b.${i}`, t);

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    // Preserved exactly as computed -- never reverted, and never advanced to BOOKING_PENDING
    // either (the offer step that would do that never completed).
    expect(lead?.status).toBe("QUALIFIED_A");
    expect(lead?.scoreClass).toBe("A");
    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead!.id);
    expect(conversation?.status).toBe("ACTIVE"); // no handoff
    expect(messaging.sentTexts.at(-2)?.body).toBe(QUALIFICATION_COMPLETE_AB_MESSAGE);
    expect(messaging.sentTexts.at(-1)?.body).toBe(SLOT_OFFER_CLAIM_IN_PROGRESS_MESSAGE);
  });

  it("C: QUALIFIED_B completion with the offer claim busy -- same guarantees", async () => {
    vi.spyOn(SlotOfferingService.prototype, "getOrCreateOffer").mockRejectedValueOnce(new SlotOfferClaimInProgressError("conv-busy"));
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, whatsappBookingEnabled: true, ...repos });
    const from = "5214779000002";
    for (const [i, t] of GMM_TO_QUALIFIED_B_TURNS.entries()) await send(app, from, `wamid.hard.c.${i}`, t);

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("QUALIFIED_B");
    expect(lead?.scoreClass).toBe("B");
    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead!.id);
    expect(conversation?.status).toBe("ACTIVE");
    expect(messaging.sentTexts.at(-1)?.body).toBe(SLOT_OFFER_CLAIM_IN_PROGRESS_MESSAGE);
  });

  it("G: score/scoreClass are identical to a normal completion -- the claim-in-progress condition never touches them", async () => {
    const baselineMessaging = new FakeMessagingProvider();
    const baselineRepos = buildRepos();
    const baselineApp = await buildTestApp({ messaging: baselineMessaging, qualificationEngineEnabled: true, whatsappBookingEnabled: false, ...baselineRepos });
    const baselineFrom = "5214779000003";
    for (const [i, t] of SAVINGS_TO_QUALIFIED_A_TURNS.entries()) await send(baselineApp, baselineFrom, `wamid.hard.g.base.${i}`, t);
    const baselineLead = await baselineRepos.leadsRepo.findByDedupKey({ whatsappUserId: baselineFrom });

    vi.spyOn(SlotOfferingService.prototype, "getOrCreateOffer").mockRejectedValueOnce(new SlotOfferClaimInProgressError("conv-busy"));
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, whatsappBookingEnabled: true, ...repos });
    const from = "5214779000004";
    for (const [i, t] of SAVINGS_TO_QUALIFIED_A_TURNS.entries()) await send(app, from, `wamid.hard.g.${i}`, t);
    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });

    expect(lead?.score).toBe(baselineLead?.score);
    expect(lead?.scoreClass).toBe(baselineLead?.scoreClass);
  });
});
