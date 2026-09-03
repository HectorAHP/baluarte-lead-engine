import { describe, it, expect, vi } from "vitest";
import { WhatsAppBookingHandler } from "../src/application/whatsapp-booking-handler.js";
import { AppointmentService } from "../src/application/services.js";
import { SlotOfferingService, OFFERED_SLOT_TTL_MS } from "../src/application/slot-offering-service.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryAppointmentRepository,
  InMemoryOfferedSlotRepository, InMemoryBookingAttemptRepository, InMemoryMessageRepository,
  InMemorySlotOfferClaimRepository, InMemoryLeadStatusHistoryRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { BookingAttemptInconsistentError, BookingInProgressError, CalendarProviderError, SlotOfferClaimInProgressError } from "../src/domain/errors.js";
import type { Lead } from "../src/domain/lead.js";
import type { CalendarProvider, CalendarEventInput, CalendarEventResult } from "../src/application/ports.js";

/** Wraps a real FakeCalendarProvider but forces createEvent() to throw a technical (Calendar
 * infra) error, for testing the recoverable-error path realistically instead of stubbing
 * AppointmentService.book itself. */
class ThrowingCreateEventCalendar implements CalendarProvider {
  private readonly inner = new FakeCalendarProvider();
  async getAvailableSlots(from: Date, to: Date, durationMinutes: number) {
    return this.inner.getAvailableSlots(from, to, durationMinutes);
  }
  async isSlotAvailable(start: Date, end: Date) {
    return this.inner.isSlotAvailable(start, end);
  }
  async createEvent(): Promise<never> {
    throw new CalendarProviderError("Google Calendar is down");
  }
  async deleteEvent(eventId: string) {
    return this.inner.deleteEvent(eventId);
  }
}

/** Wraps a real FakeCalendarProvider but strips meetingUrl from a successful createEvent, so the
 * "no meetingUrl -- safe alternative message" path can be tested realistically. */
class NoMeetingUrlCalendar implements CalendarProvider {
  private readonly inner = new FakeCalendarProvider();
  async getAvailableSlots(from: Date, to: Date, durationMinutes: number) {
    return this.inner.getAvailableSlots(from, to, durationMinutes);
  }
  async isSlotAvailable(start: Date, end: Date) {
    return this.inner.isSlotAvailable(start, end);
  }
  async createEvent(input: CalendarEventInput): Promise<CalendarEventResult> {
    const result = await this.inner.createEvent(input);
    return { eventId: result.eventId };
  }
  async deleteEvent(eventId: string) {
    return this.inner.deleteEvent(eventId);
  }
}

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

function makeHandler(overrides: { calendar?: CalendarProvider } = {}) {
  const calendar = overrides.calendar ?? new FakeCalendarProvider();
  const leads = new InMemoryLeadRepository();
  const conversations = new InMemoryConversationRepository();
  const appointments = new InMemoryAppointmentRepository();
  const offeredSlots = new InMemoryOfferedSlotRepository();
  const bookingAttempts = new InMemoryBookingAttemptRepository();
  const messages = new InMemoryMessageRepository();
  const messaging = new FakeMessagingProvider();
  const logger = new FakeLogger();
  const appointmentService = new AppointmentService(calendar, appointments, bookingAttempts, leads, logger);
  const slotOfferClaims = new InMemorySlotOfferClaimRepository();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const slotOffering = new SlotOfferingService(calendar, offeredSlots, appointments, leads, slotOfferClaims, leadStatusHistory, logger);
  const handler = new WhatsAppBookingHandler(
    { leads, conversations, appointments, offeredSlots, slotOffering, appointmentService, messaging, messages, leadStatusHistory, logger },
    "America/Mexico_City",
  );
  return { handler, leads, conversations, appointments, offeredSlots, bookingAttempts, messages, messaging, logger, calendar, slotOffering, appointmentService, leadStatusHistory };
}

async function makeLeadAndConversation(leads: InMemoryLeadRepository, conversations: InMemoryConversationRepository, overrides: Partial<Lead> = {}) {
  const lead = await leads.create({
    country: "MX", productVertical: "PATRIMONIAL", status: "BOOKING_PENDING",
    score: 80, assignedAdvisor: "Hector Herrera", consentContact: true,
    bookingStartedAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  });
  const conversation = await conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead, conversation };
}

const WHATSAPP_USER_ID = "5214770000001";

describe("WhatsAppBookingHandler -- guard", () => {
  it("a lead not in BOOKING_PENDING is a complete no-op: no Calendar, no message, no state change", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const { handler, leads, conversations, messaging } = makeHandler({ calendar });
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations, { status: "QUALIFIED_A", bookingStartedAt: undefined });
    const now = new Date("2026-03-02T12:00:00.000Z");

    const handled = await handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });

    expect(handled).toBe(false); // pre-launch fix: the caller (whatsapp-inbound-service.ts) relies on this to know it must send its own fallback
    expect(calendar.calls).toBe(0);
    expect(messaging.sentTexts).toHaveLength(0);
    const reloaded = await leads.findById(lead.id);
    expect(reloaded?.status).toBe("QUALIFIED_A");
  });
});

describe("WhatsAppBookingHandler -- success", () => {
  it("A: a valid option books the slot, marks it selected, transitions the lead to BOOKED, and sends exactly one confirmation", async () => {
    const { handler, leads, conversations, offeredSlots, appointments, messaging, slotOffering } = makeHandler();
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");

    const handled = await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });

    expect(handled).toBe(true); // pre-launch fix: BOOKING_PENDING always reports it acted
    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKED");
    const stillActive = await offeredSlots.listActiveByConversationId(conversation.id, now);
    expect(stillActive.find((s) => s.id === offer.slots[0].id)).toBeUndefined(); // no longer active -- selected
    expect(await appointments.findActiveByLeadId(lead.id)).toBeTruthy();
    expect(messaging.sentTexts).toHaveLength(1);
    expect(messaging.sentTexts[0].body).toContain("quedó agendada");
  });

  it("M: the confirmation includes the real meetingUrl when the provider returns one", async () => {
    const { handler, leads, conversations, slotOffering, messaging } = makeHandler();
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });

    expect(messaging.sentTexts[0].body).toContain("meet.google.com");
  });

  it("N: booking success without a meetingUrl -- safe alternative message, never an invented URL", async () => {
    const calendar = new NoMeetingUrlCalendar();
    const { handler, leads, conversations, slotOffering, messaging } = makeHandler({ calendar });
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });

    expect(messaging.sentTexts).toHaveLength(1);
    expect(messaging.sentTexts[0].body).toContain("Te compartiremos el enlace de la videollamada antes de la cita");
    expect(messaging.sentTexts[0].body).not.toContain("http");
  });

  it("books successfully for a lead with no email on file -- attendeeEmail is undefined, never an invented placeholder", async () => {
    const { handler, leads, conversations, slotOffering, appointments } = makeHandler();
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations, { email: undefined });
    expect(lead.email).toBeUndefined();
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });

    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKED");
    expect(await appointments.findActiveByLeadId(lead.id)).toBeTruthy();
  });

  it("Q: conversation.status stays ACTIVE through a successful booking", async () => {
    const { handler, leads, conversations, slotOffering } = makeHandler();
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });

    const reloadedConversation = await conversations.findById(conversation.id);
    expect(reloadedConversation?.status).toBe("ACTIVE");
  });
});

describe("WhatsAppBookingHandler -- existing appointment / idempotency", () => {
  it("B: an existing BOOKED appointment -- no book() call, replies with the existing confirmation", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const { handler, leads, conversations, appointments, messaging } = makeHandler({ calendar });
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    const appt = await appointments.create({
      leadId: lead.id, status: "BOOKED",
      startsAt: new Date("2026-03-03T15:00:00.000Z"), endsAt: new Date("2026-03-03T15:30:00.000Z"),
      timezone: "America/Mexico_City", meetingUrl: "https://meet.google.com/existing",
    });

    await handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });

    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKED");
    // Self-healing backfill (markLeadBooked): the lead had no bookedAt/meetingAt on file at all
    // for this pre-existing appointment (it never went through completeBooking under THIS
    // handler's watch) -- confirming both get backfilled from the real appointment here is the
    // regression test for the exact production drift found in the first real E2E (meeting_at
    // stayed NULL despite a valid, correctly-dated appointment).
    expect(reloadedLead?.bookedAt).toBeInstanceOf(Date);
    expect(reloadedLead?.meetingAt).toEqual(appt.startsAt);
    expect(calendar.calls).toBe(0);
    expect(messaging.sentTexts).toHaveLength(1);
    expect(messaging.sentTexts[0].body).toContain("tienes una asesoría agendada");
    expect(messaging.sentTexts[0].body).toContain(appt.meetingUrl);
  });

  it("self-healing regression: an appointment exists but the lead's meetingAt/bookedAt are still NULL (e.g. completeBooking's own write failed earlier) -- backfilled without creating a second appointment", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const { handler, leads, conversations, appointments, messaging } = makeHandler({ calendar });
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    expect(lead.bookedAt).toBeUndefined();
    expect(lead.meetingAt).toBeUndefined();
    const appt = await appointments.create({
      leadId: lead.id, status: "BOOKED",
      startsAt: new Date("2026-03-05T16:00:00.000Z"), endsAt: new Date("2026-03-05T16:30:00.000Z"),
      timezone: "America/Mexico_City", meetingUrl: "https://meet.google.com/self-heal",
    });
    const now = new Date("2026-03-02T12:00:00.000Z");

    await handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now });

    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKED");
    expect(reloadedLead?.meetingAt).toEqual(appt.startsAt);
    expect(reloadedLead?.bookedAt).toBeInstanceOf(Date);
    expect(calendar.calls).toBe(0); // no Calendar call
    const stillJustOne = await appointments.findActiveByLeadId(lead.id);
    expect(stillJustOne?.id).toBe(appt.id); // never created a second appointment
  });

  it("O/P: a stale BOOKING_PENDING lead snapshot reprocessing the same selection never creates a second appointment or a second round", async () => {
    const { handler, leads, conversations, appointments, offeredSlots, slotOffering, messaging } = makeHandler();
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });
    const firstAppointment = await appointments.findActiveByLeadId(lead.id);

    // Simulate a caller re-dispatching this exact turn with a stale BOOKING_PENDING lead
    // snapshot (e.g. a reprocessed inbound arriving before the caller refreshed lead state from
    // the repository). The top-level status guard alone would not catch this -- it's the
    // appointment guard inside handleTurnInner that makes it safe.
    const staleLead = { ...offer.lead, status: "BOOKING_PENDING" as const };
    await handler.handleTurn({ lead: staleLead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });

    const secondAppointment = await appointments.findActiveByLeadId(lead.id);
    expect(secondAppointment?.id).toBe(firstAppointment?.id); // same appointment, never a duplicate
    expect(await offeredSlots.listRoundIdsByConversationId(conversation.id)).toHaveLength(1); // P: no new round
    expect(messaging.sentTexts).toHaveLength(2);
    expect(messaging.sentTexts[0].body).toContain("quedó agendada");
    expect(messaging.sentTexts[1].body).toContain("tienes una asesoría agendada"); // 2nd turn hits the appointment guard directly
    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKED"); // still BOOKED -- no InvalidLeadTransitionError, no regression
  });
});

describe("WhatsAppBookingHandler -- offer/selection outcomes", () => {
  it("C: INVALID input resends the same active options -- no Calendar call, no booking", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const { handler, leads, conversations, messaging, slotOffering } = makeHandler({ calendar });
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");
    calendar.calls = 0; // reset after setup's own call

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no se", now });

    expect(calendar.calls).toBe(0);
    expect(messaging.sentTexts).toHaveLength(1);
    // Pre-launch hardening: no longer the terse "Por favor responde 1, 2 o 3" nag -- a friendlier
    // fallback that still restates the active options and names the abandon escape hatch.
    expect(messaging.sentTexts[0].body).toContain("Estamos en el proceso de agendar tu cita");
    expect(messaging.sentTexts[0].body).toContain("Responde con el número de la opción que prefieras");
    expect(messaging.sentTexts[0].body).toContain('"cancelar"');
    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKING_PENDING");
  });

  it("D: DECLINED triggers exactly one replaceOffer -- a new round with the plain offer message", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const { handler, leads, conversations, messaging, slotOffering, offeredSlots } = makeHandler({ calendar });
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");
    calendar.calls = 0;

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "ninguno", now });

    expect(calendar.calls).toBe(1);
    expect(messaging.sentTexts).toHaveLength(1);
    expect(messaging.sentTexts[0].body).toContain("Tengo estos horarios disponibles");
    expect(await offeredSlots.listRoundIdsByConversationId(conversation.id)).toHaveLength(2);
  });

  it("E: SlotUnavailableError at booking time triggers exactly one replaceOffer -- new options offered, nothing booked/selected", async () => {
    const calendar = new FakeCalendarProvider();
    const { handler, leads, conversations, appointments, messaging, slotOffering, offeredSlots } = makeHandler({ calendar });
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");
    const targetSlot = offer.slots[0];
    // Simulate another booking landing on this exact slot between the offer and this selection.
    await calendar.createEvent({ title: "other", description: "", start: targetSlot.slotStart, end: targetSlot.slotEnd });

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });

    expect(await appointments.findActiveByLeadId(lead.id)).toBeNull();
    expect(messaging.sentTexts).toHaveLength(1);
    expect(messaging.sentTexts[0].body).toContain("Ese horario acaba de dejar de estar disponible");
    expect(await offeredSlots.listRoundIdsByConversationId(conversation.id)).toHaveLength(2);
  });

  it("F: BookingInProgressError -- no replaceOffer, no new round, just the wait message", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const { handler, leads, conversations, messaging, slotOffering, offeredSlots, appointmentService } = makeHandler({ calendar });
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");
    calendar.calls = 0;
    vi.spyOn(appointmentService, "book").mockRejectedValueOnce(new BookingInProgressError(`whatsapp-booking:${lead.id}:${offer.slots[0].id}`));

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });

    expect(calendar.calls).toBe(0); // no replaceOffer -- no extra Calendar call
    expect(await offeredSlots.listRoundIdsByConversationId(conversation.id)).toHaveLength(1); // no new round
    expect(messaging.sentTexts).toHaveLength(1);
    expect(messaging.sentTexts[0].body).toBe("Estoy confirmando ese horario. Dame un momento e inténtalo nuevamente.");
    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKING_PENDING");
  });

  it("hardening A/F: SlotOfferClaimInProgressError -- recoverable message, lead stays BOOKING_PENDING, no handoff, no appointment, exactly one outbound", async () => {
    const { handler, leads, conversations, appointments, messaging, slotOffering } = makeHandler();
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    vi.spyOn(slotOffering, "getOrCreateOffer").mockRejectedValueOnce(new SlotOfferClaimInProgressError(conversation.id));

    await handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now });

    expect(messaging.sentTexts).toHaveLength(1); // exactly one outbound
    expect(messaging.sentTexts[0].body).toBe("Estoy preparando los horarios disponibles. Inténtalo nuevamente en unos segundos.");
    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKING_PENDING"); // no handoff, no other transition
    const reloadedConversation = await conversations.findById(conversation.id);
    expect(reloadedConversation?.status).toBe("ACTIVE"); // no handoff on the conversation either
    expect(await appointments.findActiveByLeadId(lead.id)).toBeNull(); // no appointment created
  });

  it("G: NO_AVAILABILITY -- recoverable message, lead stays BOOKING_PENDING, no round created", async () => {
    const emptyCalendar: CalendarProvider = {
      async getAvailableSlots() { return []; },
      async isSlotAvailable() { return true; },
      async createEvent(): Promise<never> { throw new Error("not used"); },
      async deleteEvent() {},
    };
    const { handler, leads, conversations, messaging, offeredSlots } = makeHandler({ calendar: emptyCalendar });
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");

    await handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now });

    expect(messaging.sentTexts).toHaveLength(1);
    expect(messaging.sentTexts[0].body).toContain("no tengo horarios disponibles");
    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKING_PENDING");
    expect(await offeredSlots.listRoundIdsByConversationId(conversation.id)).toHaveLength(0);
  });

  it("H: MAX_ROUNDS_REACHED escalates lead+conversation to HUMAN_HANDOFF", async () => {
    const { handler, leads, conversations, offeredSlots, messaging } = makeHandler();
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    for (const roundId of ["r1", "r2", "r3"]) {
      await offeredSlots.createMany([
        { conversationId: conversation.id, leadId: lead.id, roundId, slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() - 1_000), selected: false },
      ]);
    }

    await handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now });

    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("HUMAN_HANDOFF");
    const reloadedConversation = await conversations.findById(conversation.id);
    expect(reloadedConversation?.status).toBe("HUMAN_HANDOFF");
    expect(messaging.sentTexts).toHaveLength(1);
  });

  it("I: multiple active roundIds (data inconsistency) -- HUMAN_HANDOFF, never mixes slots", async () => {
    const { handler, leads, conversations, offeredSlots, messaging } = makeHandler();
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    await offeredSlots.createMany([{ conversationId: conversation.id, leadId: lead.id, roundId: "round-a", slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() + 600_000), selected: false }]);
    await offeredSlots.createMany([{ conversationId: conversation.id, leadId: lead.id, roundId: "round-b", slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date(now.getTime() + 600_000), selected: false }]);

    await handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });

    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("HUMAN_HANDOFF");
    expect(messaging.sentTexts).toHaveLength(1);
  });

  it("J: BookingAttemptInconsistentError from book() -- HUMAN_HANDOFF, sanitized log", async () => {
    const { handler, leads, conversations, slotOffering, appointmentService, messaging, logger } = makeHandler();
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");
    vi.spyOn(appointmentService, "book").mockRejectedValueOnce(new BookingAttemptInconsistentError("attempt-1"));

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });

    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("HUMAN_HANDOFF");
    const warning = logger.warnings.find((w) => w.message.toLowerCase().includes("consistency"));
    expect(warning).toBeTruthy();
    // Sanitized: leadId/conversationId/errorName only -- never the raw error message or any
    // booking-attempt/appointment payload.
    expect(Object.keys(warning!.details).sort()).toEqual(["conversationId", "errorName", "leadId"]);
    expect(messaging.sentTexts).toHaveLength(1);
  });

  it("K: CalendarProviderError from book() -- recoverable message, lead stays BOOKING_PENDING", async () => {
    const calendar = new ThrowingCreateEventCalendar();
    const { handler, leads, conversations, slotOffering, messaging } = makeHandler({ calendar });
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const now = new Date("2026-03-02T12:00:00.000Z");
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now });
    if (offer.type !== "CREATED") throw new Error("unreachable");

    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now });

    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKING_PENDING");
    expect(messaging.sentTexts).toHaveLength(1);
    expect(messaging.sentTexts[0].body).toContain("no pude consultar la agenda");
  });

  it("L: a slot round that expired since the offer -- no booking; the turn falls back to offering a fresh round", async () => {
    const { handler, leads, conversations, appointments, offeredSlots, slotOffering, messaging } = makeHandler();
    const { lead, conversation } = await makeLeadAndConversation(leads, conversations);
    const offerNow = new Date("2026-03-02T12:00:00.000Z");
    const offer = await slotOffering.getOrCreateOffer({ lead, conversationId: conversation.id, now: offerNow });
    if (offer.type !== "CREATED") throw new Error("unreachable");

    const later = new Date(offerNow.getTime() + OFFERED_SLOT_TTL_MS + 60_000); // past the round's TTL
    await handler.handleTurn({ lead: offer.lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: later });

    expect(await appointments.findActiveByLeadId(lead.id)).toBeNull();
    const reloadedLead = await leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKING_PENDING"); // still pending, not BOOKED
    const rounds = await offeredSlots.listRoundIdsByConversationId(conversation.id);
    expect(rounds).toHaveLength(2); // the expired round + a fresh one offered instead
    expect(messaging.sentTexts).toHaveLength(1);
    expect(messaging.sentTexts[0].body).toContain("Tengo estos horarios disponibles");
  });
});
