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
import type { HandoffAlertTurnService } from "../src/application/whatsapp-inbound-service.js";

/**
 * Fase 7K.1 -- pre-deploy consistency review, closing three coverage gaps identified by that
 * review (never a re-test of what tests/whatsapp-sandler-booking-flow.test.ts already covers):
 *
 *  1. section 5/23 -- a mid-round DAYPART SWITCH ("mejor por la tarde" while a MORNING round is
 *     still active). The existing suite only covers a DAY-only change that keeps the same
 *     daypart (section 34 test 5) -- the inverse (daypart itself changing) was untested.
 *  2. section 8/17 -- a reschedule whose newly-selected slot becomes genuinely Calendar-
 *     unavailable between selection and the Sandler commitment confirmation (a real race, not an
 *     OBSTACLE reply) -- the existing reschedule suite covers OBSTACLE (never books) but not this
 *     distinct "slot lost" case specifically for RESCHEDULE mode (the booking-mode equivalent is
 *     covered).
 *  3. section 10/28 -- the Fase 7J.2 advisor alert actually firing (a live handoffAlertService)
 *     when the escalation originates specifically from the new AWAITING_DAYPART_PREFERENCE /
 *     AWAITING_BOOKING_COMMITMENT states, plus confirmation a normal completed booking triggers
 *     zero alerts. The existing suite proves the code path is shared (escalateToHuman) but
 *     deliberately never wires a real alert service through it; whatsapp-human-handoff-alert-e2e
 *     wires a real one but only for the pre-7K BOOKING_PENDING classifier path.
 */

const NOW = new Date("2026-03-02T12:00:00.000Z"); // Monday
const WHATSAPP_USER_ID = "5214770000099";

function fakeHandoffAlertService(): HandoffAlertTurnService & { calls: Array<{ leadId: string; handoffReason: string }> } {
  const calls: Array<{ leadId: string; handoffReason: string }> = [];
  return {
    calls,
    async alertAdvisorOfHandoff(params) {
      calls.push({ leadId: params.leadId, handoffReason: params.handoffReason });
    },
  };
}

function makeBookingHandler(handoffAlertService?: HandoffAlertTurnService) {
  const calendar = new FakeCalendarProvider();
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
    { leads, conversations, appointments, offeredSlots, slotOffering, appointmentService, messaging, messages, leadStatusHistory, logger, handoffAlertService },
    "America/Mexico_City",
  );
  return { handler, leads, conversations, appointments, offeredSlots, messaging, leadStatusHistory, calendar, slotOffering };
}

async function makeBookingPendingLead(h: ReturnType<typeof makeBookingHandler>) {
  const lead = await h.leads.create({
    country: "MX", productVertical: "PATRIMONIAL", status: "BOOKING_PENDING",
    score: 80, assignedAdvisor: "Hector Herrera", consentContact: true, bookingStartedAt: NOW, firstName: "Ana",
  });
  const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead, conversation };
}

function makeRescheduleHandler() {
  const calendar = new FakeCalendarProvider();
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
  return { handler, leads, conversations, appointments, offeredSlots, messaging, calendar };
}

async function makeBookedLeadWithAppointment(h: ReturnType<typeof makeRescheduleHandler>) {
  const lead = await h.leads.create({
    country: "MX", productVertical: "GMM", status: "BOOKED", score: 71,
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: WHATSAPP_USER_ID, firstName: "Ana",
    bookedAt: new Date("2026-02-20T10:00:00.000Z"), meetingAt: new Date("2026-03-02T15:00:00.000Z"),
  });
  const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  const appointment = await h.appointments.create({
    leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"),
    endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-old",
  });
  return { lead, conversation, appointment };
}

describe("Fase 7K.1 gap 1 -- mid-round DAYPART switch (never just a day-only change)", () => {
  it("'mejor por la tarde' while a MORNING round is active replaces it with an AFTERNOON round, never re-asks, never mixes windows", async () => {
    const h = makeBookingHandler();
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });
    const morningRound = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(morningRound.length).toBeGreaterThan(0);
    for (const s of morningRound) expect(s.slotStart.getUTCHours()).toBeLessThan(18); // sanity: morning-ish local window
    pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "mejor por la tarde", now: NOW });

    // Never re-asks the daypart question -- "mejor por la tarde" already IS a full daypart answer.
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).not.toContain("por la mañana o por la tarde");
    expect(lastMessage.body).toContain("Tengo estos horarios disponibles");

    const afternoonRound = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW);
    expect(afternoonRound.length).toBeGreaterThan(0);
    // A genuinely NEW, distinct round -- the morning round's own slots are gone from "active".
    const morningIds = new Set(morningRound.map((s) => s.id));
    expect(afternoonRound.every((s) => !morningIds.has(s.id))).toBe(true);
    // FakeCalendarProvider ignores daypart filtering itself, but the round IS genuinely a
    // replacement (distinct round_id) -- the real-provider version of this exact scenario is
    // already covered end-to-end by availability.test.ts + slot-diversity.test.ts's own
    // daypart-window unit coverage; this test's job is only the HANDLER-level "switch, don't
    // re-ask, don't merge" behavior.
    expect(new Set(afternoonRound.map((s) => s.roundId)).size).toBe(1);
    expect(new Set(morningRound.map((s) => s.roundId)).size).toBe(1);
    expect([...new Set(afternoonRound.map((s) => s.roundId))][0]).not.toBe([...new Set(morningRound.map((s) => s.roundId))][0]);

    // Lead stays BOOKING_PENDING throughout -- a preference switch is never itself an escalation
    // or a round-cap violation (still well under MAX_OFFER_ROUNDS=3: 1 morning + 1 afternoon = 2).
    expect((await h.leads.findById(lead.id))?.status).toBe("BOOKING_PENDING");
  });
});

describe("Fase 7K.1 gap 2 -- reschedule: the newly-selected slot becomes genuinely unavailable before commitment confirms", () => {
  it("a real Calendar race (not an OBSTACLE reply) between reschedule slot-selection and commitment CONFIRMED leaves the OLD appointment untouched and offers a fresh round", async () => {
    const h = makeRescheduleHandler();
    const { lead, conversation, appointment } = await makeBookedLeadWithAppointment(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "quiero reagendar", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });
    pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW }); // asks the commitment question
    pending = (await h.leads.findById(lead.id))!;
    const activeSlots = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW, appointment.id);
    const targetSlot = activeSlots.find((s) => s.position === 1)!;

    // Race: something else takes that exact slot on the real calendar between selection and the
    // commitment reply -- the same mechanism whatsapp-booking-handler.test.ts's own "E" test uses
    // for the booking-mode equivalent.
    await h.calendar.createEvent({ title: "other", description: "", start: targetSlot.slotStart, end: targetSlot.slotEnd });

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no", now: NOW }); // CONFIRMED -> revalidates, finds it taken

    // The OLD appointment is NEVER touched by a failed reschedule attempt -- still BOOKED, never
    // RESCHEDULED, no new appointment created.
    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED");
    const all = await h.appointments.listAllByLeadId(lead.id);
    expect(all).toHaveLength(1); // no new appointment
    expect((await h.leads.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED"); // never forced to BOOKED

    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).toContain("Ese horario acaba de dejar de estar disponible");
    // A fresh, real round replaces it -- never silence, never a stale/lost offer.
    const freshRound = await h.offeredSlots.listActiveByConversationId(conversation.id, NOW, appointment.id);
    expect(freshRound.length).toBeGreaterThan(0);
  });
});

describe("Fase 7K.1 gap 3 -- Fase 7J.2 advisor alert actually fires from the new 7K escalation points", () => {
  it("an UNKNOWN_INTENT_HANDOFF escalation from AWAITING_DAYPART_PREFERENCE triggers exactly one advisor alert", async () => {
    const alertService = fakeHandoffAlertService();
    const h = makeBookingHandler(alertService);
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    const pending = (await h.leads.findById(lead.id))!;

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "¿también manejan seguros de auto?", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(alertService.calls).toHaveLength(1);
    expect(alertService.calls[0]).toMatchObject({ leadId: lead.id, handoffReason: "UNKNOWN_INTENT_HANDOFF" });
  });

  it("an UNKNOWN_INTENT_HANDOFF escalation from AWAITING_BOOKING_COMMITMENT (second AMBIGUOUS reply) triggers exactly one advisor alert", async () => {
    const alertService = fakeHandoffAlertService();
    const h = makeBookingHandler(alertService);
    const { lead, conversation } = await makeBookingPendingLead(h);
    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });
    pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW }); // commitment question
    pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no sé qué decirte", now: NOW }); // 1st AMBIGUOUS -> clarify once
    pending = (await h.leads.findById(lead.id))!;
    expect((await h.leads.findById(lead.id))?.status).toBe("BOOKING_PENDING"); // not escalated yet
    expect(alertService.calls).toHaveLength(0);

    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "mmm no sé", now: NOW }); // 2nd AMBIGUOUS -> escalates

    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(alertService.calls).toHaveLength(1); // exactly one -- never one per AMBIGUOUS attempt
    expect(alertService.calls[0]).toMatchObject({ leadId: lead.id, handoffReason: "UNKNOWN_INTENT_HANDOFF" });
  });

  it("a normal, fully-completed booking (daypart -> offer -> selection -> CONFIRMED -> BOOKED) triggers zero advisor alerts", async () => {
    const alertService = fakeHandoffAlertService();
    const h = makeBookingHandler(alertService);
    const { lead, conversation } = await makeBookingPendingLead(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "hola", now: NOW });
    let pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "por la mañana", now: NOW });
    pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "1", now: NOW });
    pending = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pending, conversationId: conversation.id, whatsappUserId: WHATSAPP_USER_ID, inboundText: "no", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("BOOKED");
    expect(alertService.calls).toHaveLength(0);
  });
});
