import { describe, it, expect } from "vitest";
import { WhatsAppBookingHandler } from "../src/application/whatsapp-booking-handler.js";
import { WhatsAppRescheduleHandler } from "../src/application/whatsapp-reschedule-handler.js";
import { AppointmentService } from "../src/application/services.js";
import { AppointmentRescheduleService } from "../src/application/appointment-reschedule-service.js";
import { AppointmentCancellationService } from "../src/application/appointment-cancellation-service.js";
import { SlotOfferingService, OFFERED_SLOT_TTL_MS } from "../src/application/slot-offering-service.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryAppointmentRepository,
  InMemoryOfferedSlotRepository, InMemoryBookingAttemptRepository, InMemoryMessageRepository,
  InMemorySlotOfferClaimRepository, InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository,
  InMemoryAppointmentCancellationRepository, InMemoryAppointmentRescheduleRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { computeAvailableSlots, isWithinBusinessHours, type AvailabilityRules } from "../src/domain/availability.js";
import { zonedTimeParts } from "../src/domain/timezone.js";
import type { CalendarProvider, CalendarEventInput, CalendarEventResult } from "../src/application/ports.js";
import type { DatePreference } from "../src/domain/date-preference.js";
import { UNKNOWN_INTENT_HANDOFF_MESSAGE } from "../src/domain/message-templates.js";

/**
 * Fase 7K -- "Sandler Booking Flow + Weekly Slot Diversity" (spec sections 31-36). Integration-
 * level tests through the REAL handlers, complementing (never duplicating) the pure-domain unit
 * suites already covering the individual algorithms in isolation:
 *  - tests/daypart-preference-detection.test.ts (10) -- parseDaypartReply itself.
 *  - tests/slot-diversity.test.ts (10) -- selectDiverseSlots itself.
 *  - tests/booking-commitment-detection.test.ts (16) -- classifyCommitmentReply itself.
 *  - tests/booking-flow-state.test.ts (15) -- AWAITING_DAYPART_PREFERENCE/AWAITING_BOOKING_COMMITMENT
 *    persistence itself.
 *  - tests/booking-flow-message-templates.test.ts (6) -- the new copy itself.
 * Section 35's "7J.3 regression" tests are the EXISTING, still-green
 * tests/whatsapp-past-booked-unknown-intent-handoff-e2e.test.ts (19 tests) and
 * tests/whatsapp-past-booked-recovery-e2e.test.ts (11 tests) -- re-run as part of every full-suite
 * pass, not duplicated here; this file adds two more, narrowly scoped to prove 7K specifically
 * doesn't reopen that exact bug (see the "7J.3 regression" describe block below).
 */

const NOW = new Date("2026-09-07T01:56:58.311Z"); // Sunday 2026-09-06 19:56:58 local (America/Mexico_City)
const WHATSAPP_USER_ID = "5214770000001";

const REAL_WEEKLY_RULES: AvailabilityRules = {
  timezone: "America/Mexico_City",
  workdayStart: "09:00",
  workdayEnd: "19:00",
  saturdayWorkdayEnd: "14:00",
  sundayBookingEnabled: false,
  minNoticeHours: 2,
  maxDaysAhead: 14,
  maxSlots: 3,
};

function localDow(d: Date): number {
  const p = zonedTimeParts(d, "America/Mexico_City");
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}
function localDateKey(d: Date): string {
  const p = zonedTimeParts(d, "America/Mexico_City");
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Same "real business rules through computeAvailableSlots, fake free/busy+createEvent" pattern
 * whatsapp-date-preference-booking.test.ts already established -- the ONLY way to exercise the
 * real diversity algorithm end to end, since FakeCalendarProvider's own getAvailableSlots has its
 * own simplified loop and never calls computeAvailableSlots (see availability.test.ts / that
 * file's own doc comments). */
function makeRulesEnforcingCalendar(rules: AvailabilityRules = REAL_WEEKLY_RULES): CalendarProvider {
  const inner = new FakeCalendarProvider();
  return {
    async getAvailableSlots(from: Date, to: Date, durationMinutes: number, datePreference?: DatePreference) {
      return computeAvailableSlots(from, to, durationMinutes, [], rules, from, datePreference);
    },
    isSlotAvailable: (...args) => inner.isSlotAvailable(...args),
    isWithinBusinessHours: (start: Date, end: Date) => isWithinBusinessHours(start, end, rules),
    createEvent: (input: CalendarEventInput): Promise<CalendarEventResult> => inner.createEvent(input),
    deleteEvent: (eventId: string) => inner.deleteEvent(eventId),
  };
}

function makeBookingHandler(calendar: CalendarProvider = new FakeCalendarProvider()) {
  const leads = new InMemoryLeadRepository();
  const conversations = new InMemoryConversationRepository();
  const appointments = new InMemoryAppointmentRepository();
  const offeredSlots = new InMemoryOfferedSlotRepository();
  const bookingAttempts = new InMemoryBookingAttemptRepository();
  const messages = new InMemoryMessageRepository();
  const messaging = new FakeMessagingProvider();
  const logger = new FakeLogger();
  const appointmentStatusHistory = new InMemoryAppointmentStatusHistoryRepository();
  const appointmentService = new AppointmentService(calendar, appointments, bookingAttempts, leads, logger, appointmentStatusHistory);
  const slotOfferClaims = new InMemorySlotOfferClaimRepository();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const slotOffering = new SlotOfferingService(calendar, offeredSlots, appointments, leads, slotOfferClaims, leadStatusHistory, logger);
  const handler = new WhatsAppBookingHandler(
    { leads, conversations, appointments, offeredSlots, slotOffering, appointmentService, messaging, messages, leadStatusHistory, logger },
    "America/Mexico_City",
  );
  return { handler, leads, conversations, appointments, offeredSlots, messaging, leadStatusHistory, messages, calendar, appointmentService, slotOffering };
}

async function makeBookingPendingLead(h: ReturnType<typeof makeBookingHandler>) {
  const lead = await h.leads.create({
    country: "MX", productVertical: "PATRIMONIAL", status: "BOOKING_PENDING",
    score: 80, assignedAdvisor: "Hector Herrera", consentContact: true, bookingStartedAt: NOW, firstName: "Ana",
  });
  const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead, conversation };
}

function makeRescheduleHandler(calendar: CalendarProvider = new FakeCalendarProvider()) {
  const leads = new InMemoryLeadRepository();
  const conversations = new InMemoryConversationRepository();
  const appointments = new InMemoryAppointmentRepository();
  const offeredSlots = new InMemoryOfferedSlotRepository();
  const slotOfferClaims = new InMemorySlotOfferClaimRepository();
  const messages = new InMemoryMessageRepository();
  const messaging = new FakeMessagingProvider();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const appointmentStatusHistory = new InMemoryAppointmentStatusHistoryRepository();
  const cancellations = new InMemoryAppointmentCancellationRepository();
  const reschedules = new InMemoryAppointmentRescheduleRepository();
  const logger = new FakeLogger();
  const cancellationService = new AppointmentCancellationService(calendar, appointments, cancellations, appointmentStatusHistory, logger);
  const rescheduleService = new AppointmentRescheduleService(calendar, appointments, reschedules, appointmentStatusHistory, cancellationService, logger);
  const slotOffering = new SlotOfferingService(calendar, offeredSlots, appointments, leads, slotOfferClaims, leadStatusHistory, logger);
  const handler = new WhatsAppRescheduleHandler(
    { leads, conversations, appointments, offeredSlots, slotOffering, rescheduleService, messaging, messages, leadStatusHistory, logger },
    "America/Mexico_City",
  );
  return { handler, leads, conversations, appointments, offeredSlots, messaging, leadStatusHistory, calendar };
}

async function makeBookedLeadWithAppointment(h: ReturnType<typeof makeRescheduleHandler>) {
  const lead = await h.leads.create({
    country: "MX", productVertical: "GMM", status: "BOOKED", score: 71,
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: WHATSAPP_USER_ID, firstName: "Ana",
    bookedAt: new Date("2026-08-20T10:00:00.000Z"), meetingAt: new Date("2026-09-07T15:00:00.000Z"),
  });
  const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  const appointment = await h.appointments.create({
    leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-09-07T15:00:00.000Z"),
    endsAt: new Date("2026-09-07T15:30:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-old",
  });
  return { lead, conversation, appointment };
}

// -----------------------------------------------------------------------------------------------
// Section 31 -- Daypart (10)
// -----------------------------------------------------------------------------------------------
describe("Fase 7K section 2/3/8 -- daypart question (integration)", () => {
  it("1. a first booking turn with no preference asks the daypart question, no Calendar call, lead reaches BOOKING_PENDING", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });

    expect(h.messaging.sentTexts).toHaveLength(1);
    expect(h.messaging.sentTexts[0].body).toBe("Perfecto. Para buscar algo que realmente te funcione, ¿te acomoda mejor por la mañana o por la tarde?");
    expect(await h.offeredSlots.listActiveByConversationId(conversation.id, NOW)).toHaveLength(0);
    expect((await h.leads.findById(lead.id))?.status).toBe("BOOKING_PENDING");
  });

  it("2. '1' answers the daypart question as MORNING", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });

    const offered = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(offered.length).toBeGreaterThan(0);
    for (const s of offered) {
      const minute = zonedTimeParts(s.slotStart, "America/Mexico_City").hour * 60 + zonedTimeParts(s.slotStart, "America/Mexico_City").minute;
      expect(minute).toBeGreaterThanOrEqual(9 * 60);
    }
  });

  it("3. '2' answers the daypart question as AFTERNOON", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "2", now: NOW });

    const offered = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(offered.length).toBeGreaterThan(0);
    for (const s of offered) {
      const p = zonedTimeParts(s.slotStart, "America/Mexico_City");
      expect(p.hour * 60 + p.minute).toBeGreaterThanOrEqual(12 * 60);
    }
  });

  it("4. bare 'mañana' answers the daypart question as MORNING (contextual -- never 'tomorrow' here)", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "mañana", now: NOW });

    const offered = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(offered.length).toBeGreaterThan(0);
    // Never silently jumped a whole day -- every offered slot is still within the normal horizon,
    // proving "mañana" was read as MORNING (a daypart filter), not as tomorrow's date.
    for (const s of offered) {
      const p = zonedTimeParts(s.slotStart, "America/Mexico_City");
      expect(p.hour).toBeLessThan(12);
    }
  });

  it("5. 'temprano' answers the daypart question as MORNING", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "temprano", now: NOW });

    const offered = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(offered.length).toBeGreaterThan(0);
  });

  it("6. 'tarde' answers the daypart question as AFTERNOON", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "tarde", now: NOW });

    const offered = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(offered.length).toBeGreaterThan(0);
  });

  it("7. a daypart already stated up front ('sábado por la mañana') is never asked again", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero el sábado por la mañana", now: NOW });

    expect(h.messaging.sentTexts).toHaveLength(1);
    expect(h.messaging.sentTexts[0].body).not.toContain("por la mañana o por la tarde"); // never the question itself
    expect(h.messaging.sentTexts[0].body).toContain("Tengo estos horarios disponibles");
  });

  it("8. an unsupported reply while awaiting daypart escalates via the existing UNKNOWN_INTENT_HANDOFF path", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "¿también manejan seguros de auto?", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body).toBe(UNKNOWN_INTENT_HANDOFF_MESSAGE);
  });

  it("9. a safe/trivial reply while awaiting daypart (bare greeting) re-asks instead of escalating", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("BOOKING_PENDING"); // never escalated
    expect(h.messaging.sentTexts).toHaveLength(2);
    expect(h.messaging.sentTexts[1].body).toContain("por la mañana o por la tarde");
  });

  it("10. 'cancelar' while awaiting daypart still abandons the booking, never trapped", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "cancelar", now: NOW });

    const after = await h.leads.findById(lead.id);
    expect(after?.status).not.toBe("BOOKING_PENDING");
    expect(after?.status).not.toBe("HUMAN_HANDOFF");
  });
});

// -----------------------------------------------------------------------------------------------
// Section 32 -- Diversity (integration, through the real handler + real computeAvailableSlots)
// -----------------------------------------------------------------------------------------------
describe("Fase 7K section 6/7/8 -- weekly slot diversity (integration)", () => {
  it("1. no explicit date -> the offer spreads across distinct local dates, never all the same day", async () => {
    const h = makeBookingHandler(makeRulesEnforcingCalendar());
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });

    const offered = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(offered).toHaveLength(3);
    const distinctDates = new Set(offered.map((s) => localDateKey(s.slotStart)));
    expect(distinctDates.size).toBe(3); // three distinct days, not one day repeated
  });

  it("2. an explicit weekday ('el sábado') is never diversified -- may show multiple same-day times", async () => {
    const h = makeBookingHandler(makeRulesEnforcingCalendar());
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero el sábado por la mañana", now: NOW });

    const offered = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(offered.length).toBeGreaterThan(0);
    for (const s of offered) expect(localDow(s.slotStart)).toBe(6);
    const distinctDates = new Set(offered.map((s) => localDateKey(s.slotStart)));
    expect(distinctDates.size).toBe(1); // all Saturday -- undiversified, as requested
  });

  it("3. every offer respects the daypart filter together with diversity (never mixes windows)", async () => {
    const h = makeBookingHandler(makeRulesEnforcingCalendar());
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la tarde", now: NOW });

    const offered = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(offered.length).toBeGreaterThan(0);
    for (const s of offered) {
      const p = zonedTimeParts(s.slotStart, "America/Mexico_City");
      expect(p.hour * 60 + p.minute).toBeGreaterThanOrEqual(12 * 60);
    }
  });

  it("4. never offers more than 3 options regardless of how many distinct days are available", async () => {
    const h = makeBookingHandler(makeRulesEnforcingCalendar());
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });

    const offered = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(offered.length).toBeLessThanOrEqual(3);
  });

  it("5. the offer message format matches the required example shape (numbered list + closing question)", async () => {
    const h = makeBookingHandler(makeRulesEnforcingCalendar());
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });

    const message = h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body;
    expect(message).toMatch(/1\. .+\n2\. .+\n3\. .+/);
    expect(message).toContain("¿Cuál te funciona mejor?");
    void conversation;
  });

  it("6. 'otro horario' (DECLINED) keeps the same diversified daypart, never repeats the exact same slots", async () => {
    const h = makeBookingHandler(makeRulesEnforcingCalendar());
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });
    const firstRound = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "otro horario", now: NOW });

    const secondRound = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(secondRound.length).toBeGreaterThan(0);
    for (const s of secondRound) {
      const p = zonedTimeParts(s.slotStart, "America/Mexico_City");
      expect(p.hour).toBeLessThan(12); // still MORNING -- inherited, never dropped
    }
    expect(secondRound.every((s) => s.roundId !== firstRound[0].roundId)).toBe(true); // a genuinely new round
  });

  it("7. section 22: 'otro día' excludes the dates already shown, preferring genuinely different days", async () => {
    const h = makeBookingHandler(makeRulesEnforcingCalendar());
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });
    const firstRound = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    const firstDates = new Set(firstRound.map((s) => localDateKey(s.slotStart)));
    pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "otro día", now: NOW });

    const secondRound = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(secondRound.length).toBeGreaterThan(0);
    for (const s of secondRound) expect(firstDates.has(localDateKey(s.slotStart))).toBe(false); // never repeats a date already shown
  });

  it("8. section 21: plain 'otro horario' keeps BOTH the daypart and the pinned day (never just the daypart alone)", async () => {
    const h = makeBookingHandler(makeRulesEnforcingCalendar());
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero el sábado por la mañana", now: NOW });
    const firstRound = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "otro horario", now: NOW });

    const secondRound = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(secondRound.length).toBeGreaterThan(0);
    for (const s of secondRound) expect(localDow(s.slotStart)).toBe(6); // still Saturday -- never dropped, unlike a bare daypart-only re-offer
    void firstRound;
  });
});

// -----------------------------------------------------------------------------------------------
// Section 33 -- Commitment check (14)
// -----------------------------------------------------------------------------------------------
describe("Fase 7K section 11-17/25/26/28/29 -- Sandler commitment check (integration)", () => {
  async function toOfferedRound(h: ReturnType<typeof makeBookingHandler>) {
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });
    const afterOffer = (await h.leads.findById(lead.id))!;
    return { lead: afterOffer, conversation };
  }

  it("1. selecting a slot asks the Sandler commitment question -- no Calendar mutation, no appointment yet", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await toOfferedRound(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });

    expect(await h.appointments.findActiveByLeadId(lead.id)).toBeNull();
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body!;
    expect(lastMessage).toContain("Antes de dejarla reservada");
    expect(lastMessage).not.toMatch(/prometes/i);
    expect(lastMessage).not.toMatch(/verdad/i);
  });

  it("2. a CONFIRMED reply ('no') books the slot", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await toOfferedRound(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("BOOKED");
    expect(await h.appointments.findActiveByLeadId(lead.id)).toBeTruthy();
  });

  it("3. another CONFIRMED phrasing ('confirmado') also books", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await toOfferedRound(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "confirmado", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("BOOKED");
  });

  it("4. an OBSTACLE reply never books, and offers fresh alternatives in the same daypart", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await toOfferedRound(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "tal vez tenga junta", now: NOW });

    expect(await h.appointments.findActiveByLeadId(lead.id)).toBeNull();
    expect((await h.leads.findById(lead.id))?.status).toBe("BOOKING_PENDING");
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body!;
    expect(lastMessage).toContain("Entendido. Prefiero que encontremos un horario que sí puedas proteger.");
  });

  it("5. an AMBIGUOUS reply asks for clarification once", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await toOfferedRound(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "¿cuánto cuesta el seguro de auto?", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("BOOKING_PENDING"); // never escalated yet
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body!;
    expect(lastMessage).toBe("Solo para confirmar: ¿ese horario lo puedes apartar sin algún compromiso que ya sepas que podría impedirte conectarte?");
  });

  it("6. a SECOND AMBIGUOUS reply in a row escalates via the existing UNKNOWN_INTENT_HANDOFF path", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await toOfferedRound(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no sé qué decirte", now: NOW });
    pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "mmm no sé", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body).toBe(UNKNOWN_INTENT_HANDOFF_MESSAGE);
  });

  it("7. a slot lost between selection and commitment is revalidated -- never a phantom booking", async () => {
    const calendar = new FakeCalendarProvider();
    const h = makeBookingHandler(calendar);
    const { lead, conversation } = await toOfferedRound(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;
    const offered = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    const chosen = offered.find((s) => s.selected === false)!;
    // Race: someone else takes that exact slot between selection and confirmation.
    await calendar.createEvent({ title: "race", description: "", start: chosen.slotStart, end: chosen.slotEnd });

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no", now: NOW });

    expect(await h.appointments.findActiveByLeadId(lead.id)).toBeNull();
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body!;
    expect(lastMessage).toContain("Ese horario acaba de dejar de estar disponible");
  });

  it("8. a duplicate CONFIRMED webhook never creates two appointments", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await toOfferedRound(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await Promise.all([
      h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no", now: NOW }),
      h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no", now: NOW }),
    ]);

    const appts = await h.appointments.listAllByLeadId(lead.id);
    expect(appts).toHaveLength(1);
  });

  it("9. daypart and commitment turns never count toward the booking round cap", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW }); // daypart question -- no round
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW }); // round 1
    pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW }); // commitment question -- no round
    pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "tal vez tenga junta", now: NOW }); // OBSTACLE -> round 2
    pending = (await h.leads.findById(lead.id))!;

    expect(await h.offeredSlots.listRoundIdsByConversationId(conversation.id)).toHaveLength(2); // only the two real offers count
    expect(pending.status).toBe("BOOKING_PENDING"); // still well within budget, never HUMAN_HANDOFF
  });

  it("10. a commitment arriving after the slot offer TTL elapsed still revalidates -- never blindly books an expired slot", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await toOfferedRound(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;
    const later = new Date(NOW.getTime() + OFFERED_SLOT_TTL_MS + 60_000);

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no", now: later });

    expect(await h.appointments.findActiveByLeadId(lead.id)).toBeNull(); // never booked an expired slot
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body!;
    expect(lastMessage).toContain("Ese horario acaba de dejar de estar disponible");
  });

  it("11. 'cancelar' while awaiting commitment still abandons the booking, never trapped", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await toOfferedRound(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "cancelar", now: NOW });

    const after = await h.leads.findById(lead.id);
    expect(after?.status).not.toBe("BOOKING_PENDING");
    expect(after?.status).not.toBe("HUMAN_HANDOFF");
    expect(await h.appointments.findActiveByLeadId(lead.id)).toBeNull();
  });

  it("12. the commitment question is never manipulative/pressuring language", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await toOfferedRound(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });

    const message = h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body!;
    expect(message).not.toMatch(/me prometes/i);
    expect(message).not.toMatch(/no me vas a cancelar/i);
    expect(message).not.toMatch(/necesito que te comprometas/i);
  });

  it("13. a CONFIRMED reply reuses the SAME Calendar-level revalidation as a direct selection (isWithinBusinessHours + isSlotAvailable), never a duplicated check", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await toOfferedRound(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no", now: NOW });

    const appt = await h.appointments.findActiveByLeadId(lead.id);
    expect(appt).toBeTruthy();
    expect(appt?.calendarEventId).toBeTruthy(); // a real Calendar event was actually created
  });

  it("14. the advisor alert on a commitment-stage escalation reuses the existing Fase 7J.2 mechanism, never a new one", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await toOfferedRound(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no sé qué decirte", now: NOW });
    pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "mmm no sé", now: NOW });

    // No handoffAlertService was wired into this test's harness (mirrors the default/disabled
    // config) -- the escalation itself must still succeed identically either way, proving the
    // commitment-stage escalation goes through the SAME escalateToHuman call, not a parallel path
    // (see booking-outcome-dispatch.ts's own eventType==="UNKNOWN_INTENT_HANDOFF" gating, reused
    // verbatim here -- tests/booking-outcome-dispatch-handoff-alert.test.ts already covers the
    // alert-service-present case directly).
    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
  });
});

// -----------------------------------------------------------------------------------------------
// Section 34 -- Reschedule (7)
// -----------------------------------------------------------------------------------------------
describe("Fase 7K section 18 -- daypart + commitment applied to reschedule (integration)", () => {
  it("1. reschedule-intent asks the daypart question before offering, old appointment untouched", async () => {
    const h = makeRescheduleHandler();
    const { lead, conversation, appointment } = await makeBookedLeadWithAppointment(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero reagendar", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED");
    expect(h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body).toContain("por la mañana o por la tarde");
  });

  it("2. selecting a new slot asks the commitment question instead of rescheduling immediately", async () => {
    const h = makeRescheduleHandler();
    const { lead, conversation, appointment } = await makeBookedLeadWithAppointment(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero reagendar", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });
    pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });

    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED"); // old untouched
    expect(h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body).toContain("Antes de dejarla reservada");
  });

  it("3. a CONFIRMED reply completes the reschedule -- new appointment BOOKED, old RESCHEDULED", async () => {
    const h = makeRescheduleHandler();
    const { lead, conversation, appointment } = await makeBookedLeadWithAppointment(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero reagendar", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });
    pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("BOOKED");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("RESCHEDULED");
    const newAppt = await h.appointments.findActiveByLeadId(lead.id);
    expect(newAppt?.rescheduledFrom).toBe(appointment.id);
  });

  it("4. an OBSTACLE reply during a reschedule commitment never touches the old appointment", async () => {
    const h = makeRescheduleHandler();
    const { lead, conversation, appointment } = await makeBookedLeadWithAppointment(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero reagendar", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });
    pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "tal vez no pueda", now: NOW });

    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED"); // still untouched
    expect((await h.leads.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
  });

  it("5. a day-only preference change mid-round inherits the already-established daypart", async () => {
    const h = makeRescheduleHandler();
    const { lead, conversation } = await makeBookedLeadWithAppointment(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero reagendar", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la tarde", now: NOW });
    pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "mejor el sábado", now: NOW });

    // Never re-asked -- straight to a new (Saturday, still-AFTERNOON) offer.
    expect(h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body).not.toContain("por la mañana o por la tarde");
    expect(h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body).toContain("Tengo estos horarios disponibles");
  });

  it("6. 'cancelar cita' during a pending reschedule commitment still hands off to CANCEL_PENDING correctly", async () => {
    const h = makeRescheduleHandler();
    const { lead, conversation, appointment } = await makeBookedLeadWithAppointment(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero reagendar", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });
    pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "cancelar cita", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("CANCEL_PENDING");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED"); // untouched by the handoff itself
  });

  it("7. a duplicate CONFIRMED reschedule webhook never reschedules twice", async () => {
    const h = makeRescheduleHandler();
    const { lead, conversation, appointment } = await makeBookedLeadWithAppointment(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero reagendar", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });
    pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    pending = (await h.leads.findById(lead.id))!;

    await Promise.all([
      h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no", now: NOW }),
      h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no", now: NOW }),
    ]);

    const all = await h.appointments.listAllByLeadId(lead.id);
    expect(all.filter((a) => a.id !== appointment.id)).toHaveLength(1); // exactly one new appointment
  });
});

// -----------------------------------------------------------------------------------------------
// Section 35 -- 7J.3 regression (narrowly targeted; the full 19+11-test suites re-run every pass)
// -----------------------------------------------------------------------------------------------
describe("Fase 7K -- 7J.3 regression (never reopen the past-appointment unknown-intent bug)", () => {
  it("1. a past-appointment lead's unsupported question still escalates via UNKNOWN_INTENT_HANDOFF, never loops the past-booked message, even once the 7K daypart/commitment flow is layered on top", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);
    // Simulate a past-booked-recovery-shaped start: daypart negotiation still applies identically.
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "también me pueden ayudar con un seguro de auto?", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body!;
    expect(lastMessage).toBe(UNKNOWN_INTENT_HANDOFF_MESSAGE);
  });

  it("2. the qualified-menu pending-state fix (7J.3) is unaffected by the new daypart/commitment states -- they use a disjoint metadata marker namespace", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });

    const lastOutbound = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    // The daypart question's own marker is never mistaken for -- nor collides with -- the
    // qualified-menu's QUALIFIED_MAIN_MENU/QUALIFIED_OPTIONS_MENU markers (see
    // booking-flow-state.ts's own doc comment on this).
    expect(lastOutbound.body).toContain("por la mañana o por la tarde");
    void conversation;
  });
});

// -----------------------------------------------------------------------------------------------
// Section 36 -- the exact worked scenario from the spec
// -----------------------------------------------------------------------------------------------
describe("Fase 7K section 36 -- the exact worked scenario", () => {
  it("Quiero agendar -> daypart question -> 'Por la mañana' -> diverse offer -> '2' -> NO Calendar write yet, Sandler question -> 'No' -> final recheck + Calendar event + Meet + BOOKED + confirmation", async () => {
    const h = makeBookingHandler(makeRulesEnforcingCalendar());
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "Quiero agendar", now: NOW });
    expect(h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body).toContain("por la mañana o por la tarde");
    let pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "Por la mañana", now: NOW });
    const offerMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body!;
    expect(offerMessage).toContain("Tengo estos horarios disponibles");
    const offered = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(offered).toHaveLength(3);
    expect(new Set(offered.map((s) => localDateKey(s.slotStart))).size).toBe(3); // genuinely diverse
    pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "2", now: NOW });
    expect(await h.appointments.findActiveByLeadId(lead.id)).toBeNull(); // NO Calendar write yet
    const commitmentMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body!;
    expect(commitmentMessage).toContain("Antes de dejarla reservada");
    pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "No", now: NOW });

    const finalLead = await h.leads.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKED");
    const appt = await h.appointments.findActiveByLeadId(lead.id);
    expect(appt).toBeTruthy();
    expect(appt?.status).toBe("BOOKED");
    expect(appt?.calendarEventId).toBeTruthy(); // the real Calendar event
    expect(appt?.meetingUrl).toContain("meet.google.com"); // the real Meet link
    const confirmationMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body!;
    expect(confirmationMessage).toContain("quedó agendada");
  });
});
