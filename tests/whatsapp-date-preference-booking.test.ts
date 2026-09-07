import { describe, it, expect } from "vitest";
import { WhatsAppBookingHandler } from "../src/application/whatsapp-booking-handler.js";
import { WhatsAppRescheduleHandler } from "../src/application/whatsapp-reschedule-handler.js";
import { AppointmentService } from "../src/application/services.js";
import { AppointmentRescheduleService } from "../src/application/appointment-reschedule-service.js";
import { AppointmentCancellationService } from "../src/application/appointment-cancellation-service.js";
import { SlotOfferingService } from "../src/application/slot-offering-service.js";
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

/**
 * Fase 7I -- WhatsApp-level proof that booking/reschedule respect a parsed date preference,
 * filtered BEFORE truncation, using the SAME parser+filter in both flows (item 17 of the spec).
 * `NOW` is fixed to the exact real incident instant reconstructed in Fase 7I-DIAG (item 26):
 * 2026-09-07T01:56:58.311Z = Sunday 2026-09-06 19:56:58 local (America/Mexico_City).
 */
const NOW = new Date("2026-09-07T01:56:58.311Z");
const WHATSAPP_USER_ID = "5214770000001";

const REAL_WEEKLY_RULES: AvailabilityRules = {
  timezone: "America/Mexico_City",
  workdayStart: "09:00",
  workdayEnd: "19:00",
  saturdayWorkdayEnd: "14:00",
  sundayBookingEnabled: false,
  minNoticeHours: 2,
  maxDaysAhead: 14,
  maxSlots: 3, // production's real cap -- not relaxed
};

/** Same "wrap FakeCalendarProvider for free/busy + createEvent, but real business rules for
 * getAvailableSlots/isWithinBusinessHours" pattern already established in Fase 7F/7H's tests
 * (see tests/booking.test.ts's makeRulesEnforcingCalendar). Threads `datePreference` all the way
 * into the REAL computeAvailableSlots, exactly like GoogleCalendarProvider does in production. */
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

function localDow(d: Date): number {
  const p = zonedTimeParts(d, "America/Mexico_City");
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

function makeBookingHandler(calendar: CalendarProvider = makeRulesEnforcingCalendar()) {
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
  return { handler, leads, conversations, appointments, offeredSlots, messaging, leadStatusHistory, calendar };
}

async function makeBookingPendingLead(h: ReturnType<typeof makeBookingHandler>) {
  const lead = await h.leads.create({
    country: "MX", productVertical: "PATRIMONIAL", status: "BOOKING_PENDING",
    score: 80, assignedAdvisor: "Hector Herrera", consentContact: true, bookingStartedAt: NOW,
  });
  const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead, conversation };
}

function makeRescheduleHandler(calendar: CalendarProvider = makeRulesEnforcingCalendar()) {
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
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: WHATSAPP_USER_ID,
    bookedAt: new Date("2026-08-20T10:00:00.000Z"), meetingAt: new Date("2026-09-07T15:00:00.000Z"),
  });
  const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  const appointment = await h.appointments.create({
    leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-09-07T15:00:00.000Z"),
    endsAt: new Date("2026-09-07T15:30:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-old",
  });
  return { lead, conversation, appointment };
}

describe("Fase 7I -- WhatsApp booking: item 1/26 (the real incident, reproduced and fixed)", () => {
  it('item 1/26: "Quiero agendar en sábado" offers ONLY Saturday slots (09:00/09:30/10:00 local), never Monday', async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "Quiero agendar en sábado", now: NOW });

    const activeSlots = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(activeSlots.length).toBeGreaterThan(0);
    for (const s of activeSlots) expect(localDow(s.slotStart)).toBe(6);

    // The exact real incident's expected outcome (Fase 7I-DIAG item 26): next Saturday = 2026-09-12,
    // first three slots 09:00/09:30/10:00 local, never Monday.
    const sorted = [...activeSlots].sort((a, b) => a.position - b.position);
    const localTimes = sorted.map((s) => {
      const p = zonedTimeParts(s.slotStart, "America/Mexico_City");
      return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    });
    expect(localTimes).toEqual(["2026-09-12 09:00", "2026-09-12 09:30", "2026-09-12 10:00"]);

    expect(h.messaging.sentTexts[0].body).not.toContain("Lunes");
  });
});

describe("Fase 7I -- WhatsApp booking: item 3 (active round replaced by a new preference)", () => {
  it('an active Monday-offering round is REPLACED, not repeated, when "mejor el sábado" arrives', async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);

    // First turn: no preference -- bootstraps the default (chronological) round.
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const firstRound = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(firstRound.length).toBeGreaterThan(0);
    expect(localDow(firstRound[0].slotStart)).toBe(1); // Monday, unfiltered default

    // Second turn: "mejor el sábado" -- must REPLACE the round, never fall through to
    // parseSlotSelection's INVALID fallback (which would just repeat the same Monday options).
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "mejor el sábado", now: NOW });

    const stillActive = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(stillActive.length).toBeGreaterThan(0);
    for (const s of stillActive) expect(localDow(s.slotStart)).toBe(6);
    // The OLD Monday round_id must no longer be among the active ones -- a genuine replacement,
    // not a second round coexisting alongside the first.
    expect(stillActive.every((s) => s.roundId !== firstRound[0].roundId)).toBe(true);
  });
});

describe("Fase 7I -- WhatsApp booking: item 4 (Sunday -> explanation + real fallback)", () => {
  it('"quiero agendar el domingo" never offers Sunday, and never silently substitutes Monday without explanation', async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero agendar el domingo", now: NOW });

    const activeSlots = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(activeSlots.length).toBeGreaterThan(0); // a real fallback round WAS created
    for (const s of activeSlots) expect(localDow(s.slotStart)).not.toBe(0); // never Sunday

    const message = h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body;
    expect(message).toContain("no tengo horarios disponibles"); // explanation present
    expect(message).not.toBe(""); // never silence
  });
});

describe("Fase 7I -- WhatsApp booking: item 5 (a specific day with zero availability -> explanation + fallback)", () => {
  it("a fully-booked target day still yields a real fallback round with an explanation, never silence", async () => {
    // A calendar whose free/busy makes EVERY Saturday slot unavailable, while Monday stays free.
    const inner = new FakeCalendarProvider();
    const busyEverySaturday: CalendarProvider = {
      async getAvailableSlots(from, to, durationMinutes, datePreference) {
        const all = computeAvailableSlots(from, to, durationMinutes, [], REAL_WEEKLY_RULES, from, datePreference);
        return all.filter((s) => localDow(s.start) !== 6); // Saturday always excluded, as if fully booked
      },
      isSlotAvailable: (...args) => inner.isSlotAvailable(...args),
      isWithinBusinessHours: (start, end) => isWithinBusinessHours(start, end, REAL_WEEKLY_RULES),
      createEvent: (input) => inner.createEvent(input),
      deleteEvent: (id) => inner.deleteEvent(id),
    };
    const h = makeBookingHandler(busyEverySaturday);
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero agendar en sábado", now: NOW });

    const activeSlots = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(activeSlots.length).toBeGreaterThan(0); // real fallback, not silence
    expect(activeSlots.every((s) => localDow(s.slotStart) !== 6)).toBe(true); // never lies about being Saturday
    expect(h.messaging.sentTexts[0].body).toContain("Para ese día no tengo horarios disponibles");
  });
});

describe("Fase 7I -- WhatsApp booking: item 6 (date beyond BOOKING_MAX_DAYS_AHEAD)", () => {
  it("an explicit date far beyond the 14-day horizon never silently substitutes it -- explains and offers real alternatives", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero agendar el 25 de diciembre", now: NOW });

    const activeSlots = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(activeSlots.length).toBeGreaterThan(0);
    for (const s of activeSlots) {
      const p = zonedTimeParts(s.slotStart, "America/Mexico_City");
      expect(p.month).not.toBe(12); // never actually offers December 25th
    }
    expect(h.messaging.sentTexts[0].body).toContain("fuera de ese rango");
  });
});

describe("Fase 7I -- WhatsApp reschedule: item 2 (reagendar para sábado)", () => {
  it('"reagendar para sábado" offers ONLY Saturday options for a BOOKED lead', async () => {
    const h = makeRescheduleHandler();
    const { lead, conversation } = await makeBookedLeadWithAppointment(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "reagendar para sábado", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    const activeSlots = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW, (await h.appointments.listAllByLeadId(lead.id)).find((a) => a.status === "BOOKED")!.id);
    expect(activeSlots.length).toBeGreaterThan(0);
    for (const s of activeSlots) expect(localDow(s.slotStart)).toBe(6);
  });
});

describe("Fase 7I -- WhatsApp reschedule: item 7 (old appointment untouched until a new slot is confirmed)", () => {
  it("the original appointment stays BOOKED through the entire preference-driven reschedule offer -- only changes on final slot selection", async () => {
    const h = makeRescheduleHandler();
    const { lead, conversation, appointment } = await makeBookedLeadWithAppointment(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "reagendar para sábado", now: NOW });

    const reread = await h.appointments.findById(appointment.id);
    expect(reread?.status).toBe("BOOKED"); // still untouched -- no slot has been SELECTED yet

    // A further preference change ("mejor domingo" -> replaces the round again) must ALSO never
    // touch the old appointment.
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "mejor domingo", now: NOW });
    const rereadAgain = await h.appointments.findById(appointment.id);
    expect(rereadAgain?.status).toBe("BOOKED");
  });
});

describe("Fase 7I.1 -- CAUSE_ROUND_CAP_ESCALATION fix: exact real-incident reproduction (lead eb95060d)", () => {
  it("item 14: 3 rounds consumed by real preference changes + active Saturday round + out-of-horizon date -> stays BOOKING_PENDING, 0 new rounds, Saturday fallback, never HUMAN_HANDOFF", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);

    // The exact real conversation, in order (Fase 7I.1-DIAG item 26/7):
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "Quiero agendar en sábado", now: NOW }); // round 1
    let currentLead = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: currentLead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "Mejor domingo", now: new Date(NOW.getTime() + 31_000) }); // round 2 (fallback)
    currentLead = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: currentLead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "Sábado por la mañana", now: new Date(NOW.getTime() + 50_000) }); // round 3 -- ACTIVE, never expires in this test
    currentLead = (await h.leads.findById(lead.id))!;

    expect(await h.offeredSlots.listRoundIdsByConversationId(conversation.id)).toHaveLength(3);
    const activeBefore = await h.offeredSlots.listActiveByConversationId(conversation.id, new Date(NOW.getTime() + 70_000));
    expect(activeBefore.length).toBeGreaterThan(0);
    for (const s of activeBefore) expect(localDow(s.slotStart)).toBe(6); // Saturday

    // The real trigger.
    await h.handler.handleTurn({ lead: currentLead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "Quiero agendar el 15 de diciembre", now: new Date(NOW.getTime() + 70_000) });

    const finalLead = await h.leads.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKING_PENDING"); // NEVER HUMAN_HANDOFF
    expect(await h.offeredSlots.listRoundIdsByConversationId(conversation.id)).toHaveLength(3); // still 3 -- no round 4

    const activeAfter = await h.offeredSlots.listActiveByConversationId(conversation.id, new Date(NOW.getTime() + 70_000));
    expect(activeAfter.map((s) => s.id).sort()).toEqual(activeBefore.map((s) => s.id).sort()); // the exact same Saturday round, untouched
    for (const s of activeAfter) expect(localDow(s.slotStart)).toBe(6);

    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1].body;
    expect(lastMessage).toContain("fuera de ese rango"); // horizon explanation
    expect(lastMessage).toContain("Sábado"); // the Saturday fallback options, shown alongside the explanation
    expect(lastMessage).not.toContain("orientación adecuada"); // never the HUMAN_HANDOFF copy

    const history = await h.leadStatusHistory.listByLeadId(lead.id);
    expect(history.some((e) => e.toStatus === "HUMAN_HANDOFF")).toBe(false);
  });

  it("item 2/12: after the out-of-horizon message, the lead can still select option \"1\" from the untouched active Saturday round", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "Quiero agendar en sábado", now: NOW });
    let currentLead = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: currentLead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "Mejor domingo", now: new Date(NOW.getTime() + 31_000) });
    currentLead = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: currentLead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "Sábado por la mañana", now: new Date(NOW.getTime() + 50_000) });
    currentLead = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: currentLead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "Quiero agendar el 15 de diciembre", now: new Date(NOW.getTime() + 70_000) });
    currentLead = (await h.leads.findById(lead.id))!;
    expect(currentLead.status).toBe("BOOKING_PENDING");

    await h.handler.handleTurn({ lead: currentLead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: new Date(NOW.getTime() + 90_000) });

    const booked = await h.leads.findById(lead.id);
    expect(booked?.status).toBe("BOOKED");
    const appointment = (await h.appointments.listAllByLeadId(lead.id))[0];
    expect(localDow(appointment.startsAt)).toBe(6); // booked the Saturday slot, exactly as offered
  });
});
