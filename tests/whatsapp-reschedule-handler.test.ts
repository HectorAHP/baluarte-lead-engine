import { describe, it, expect } from "vitest";
import { WhatsAppRescheduleHandler } from "../src/application/whatsapp-reschedule-handler.js";
import { AppointmentRescheduleService } from "../src/application/appointment-reschedule-service.js";
import { AppointmentCancellationService } from "../src/application/appointment-cancellation-service.js";
import { SlotOfferingService } from "../src/application/slot-offering-service.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryAppointmentRepository,
  InMemoryMessageRepository, InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository,
  InMemoryAppointmentCancellationRepository, InMemoryAppointmentRescheduleRepository,
  InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import type { Lead } from "../src/domain/lead.js";

function makeHandler() {
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
  const calendar = new FakeCalendarProvider();
  const logger = new FakeLogger();
  const cancellationService = new AppointmentCancellationService(calendar, appointments, cancellations, appointmentStatusHistory, logger);
  const rescheduleService = new AppointmentRescheduleService(calendar, appointments, reschedules, appointmentStatusHistory, cancellationService, logger);
  const slotOffering = new SlotOfferingService(calendar, offeredSlots, appointments, leads, slotOfferClaims, leadStatusHistory, logger);
  const handler = new WhatsAppRescheduleHandler(
    { leads, conversations, appointments, offeredSlots, slotOffering, rescheduleService, messaging, messages, leadStatusHistory, logger },
    "America/Mexico_City",
  );
  return { leads, conversations, appointments, offeredSlots, messages, messaging, leadStatusHistory, appointmentStatusHistory, cancellations, reschedules, calendar, logger, handler };
}

async function makeBookedLeadWithAppointment(h: ReturnType<typeof makeHandler>) {
  const lead = await h.leads.create({
    country: "MX", productVertical: "GMM", status: "BOOKED", score: 71,
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214771234567",
  });
  const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  const appointment = await h.appointments.create({
    leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"),
    endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-1",
  });
  return { lead, conversation, appointment };
}

const NOW = new Date("2026-03-01T09:00:00.000Z");

describe("WhatsAppRescheduleHandler -- intent turn (BOOKED)", () => {
  it("BOOKED + reschedule-intent turn -> RESCHEDULE_REQUESTED, sends intro + new slot options", async () => {
    const h = makeHandler();
    const { lead, conversation } = await makeBookedLeadWithAppointment(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "quiero reagendar", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    expect(h.messaging.sentTexts.length).toBeGreaterThanOrEqual(2);
    expect(h.messaging.sentTexts[0].body).toContain("puedo ayudarte a cambiar tu cita");
    expect(h.messaging.sentTexts[1].body).toContain("Responde con el número");
    const history = await h.leadStatusHistory.listByLeadId(lead.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "RESCHEDULE_REQUESTED", eventType: "RESCHEDULE_REQUESTED" });
  });

  it("BOOKED with no active appointment -> HUMAN_HANDOFF", async () => {
    const h = makeHandler();
    const lead = await h.leads.create({ country: "MX", productVertical: "GMM", status: "BOOKED", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true });
    const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "quiero reagendar", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
  });

  it("BOOKED with more than one active appointment -> HUMAN_HANDOFF", async () => {
    const h = makeHandler();
    const { lead, conversation } = await makeBookedLeadWithAppointment(h);
    await h.appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-03T15:00:00.000Z"), endsAt: new Date("2026-03-03T15:30:00.000Z"), timezone: "America/Mexico_City" });

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "quiero reagendar", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
  });
});

describe("WhatsAppRescheduleHandler -- RESCHEDULE_REQUESTED turn", () => {
  async function toRescheduleRequested(h: ReturnType<typeof makeHandler>) {
    const ctx = await makeBookedLeadWithAppointment(h);
    await h.handler.handleTurn({ lead: ctx.lead, conversationId: ctx.conversation.id, whatsappUserId: "5214771234567", inboundText: "quiero reagendar", now: NOW });
    const pendingLead = (await h.leads.findById(ctx.lead.id))!;
    const activeSlots = await h.offeredSlots.listActiveByConversationId(ctx.conversation.id, NOW);
    return { ...ctx, pendingLead, activeSlots };
  }

  it("valid slot selection -> new appointment BOOKED (rescheduledFrom = old.id), old -> RESCHEDULED, lead -> BOOKED, confirmation message with the new date", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW });

    const finalLead = await h.leads.findById(pendingLead.id);
    expect(finalLead?.status).toBe("BOOKED");
    const oldAppt = await h.appointments.findById(appointment.id);
    expect(oldAppt?.status).toBe("RESCHEDULED");
    const newAppt = await h.appointments.findActiveByLeadId(pendingLead.id);
    expect(newAppt?.rescheduledFrom).toBe(appointment.id);
    expect(newAppt?.id).not.toBe(appointment.id);

    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).toContain("tu cita fue reagendada");

    const leadHistory = await h.leadStatusHistory.listByLeadId(pendingLead.id);
    expect(leadHistory.map((r) => [r.fromStatus, r.toStatus])).toEqual([
      ["BOOKED", "RESCHEDULE_REQUESTED"],
      ["RESCHEDULE_REQUESTED", "BOOKED"],
    ]);
    const apptHistory = await h.appointmentStatusHistory.listByAppointmentId(appointment.id);
    expect(apptHistory).toHaveLength(1);
    expect(apptHistory[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "RESCHEDULED" });
  });

  it("invalid text never reschedules -- resends the same active slots", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "no se", now: NOW });

    expect((await h.leads.findById(pendingLead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED");
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).toContain("Por favor responde");
  });

  it("'otro horario' (DECLINED) fetches a new round instead of rescheduling", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "otro horario", now: NOW });

    expect((await h.leads.findById(pendingLead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED");
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).toContain("Ese horario acaba de ocuparse");
  });

  it("item 13: 'cancelar cita' while RESCHEDULE_REQUESTED hands off to CANCEL_PENDING with the SAME confirmation prompt cancellation uses from BOOKED", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "cancelar cita", now: NOW });

    expect((await h.leads.findById(pendingLead.id))?.status).toBe("CANCEL_PENDING");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED"); // untouched -- only the lead moved to CANCEL_PENDING
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).toContain("1. Sí, cancelar");
    const history = await h.leadStatusHistory.listByLeadId(pendingLead.id);
    expect(history[history.length - 1]).toMatchObject({ fromStatus: "RESCHEDULE_REQUESTED", toStatus: "CANCEL_PENDING", eventType: "CANCELLATION_REQUESTED" });
  });

  it("duplicate selection (two turns racing the same RESCHEDULE_REQUESTED slot) is idempotent: exactly one reschedule, lead ends BOOKED once, no duplicate appointment history", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toRescheduleRequested(h);

    await Promise.all([
      h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW }),
      h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW }),
    ]);

    expect((await h.leads.findById(pendingLead.id))?.status).toBe("BOOKED");
    const apptHistory = await h.appointmentStatusHistory.listByAppointmentId(appointment.id);
    expect(apptHistory).toHaveLength(1);
    const leadHistory = await h.leadStatusHistory.listByLeadId(pendingLead.id);
    expect(leadHistory.filter((r) => r.toStatus === "BOOKED")).toHaveLength(1);
  });
});

describe("WhatsAppRescheduleHandler -- privacy", () => {
  it("no history row anywhere contains inbound message text or clinical content", async () => {
    const h = makeHandler();
    const { lead, conversation } = await makeBookedLeadWithAppointment(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "quiero reagendar, tengo una cirugía", now: NOW });

    const leadHistory = await h.leadStatusHistory.listByLeadId(lead.id);
    for (const row of leadHistory) {
      expect(JSON.stringify(row.metadata)).not.toContain("cirugía");
      expect(row.eventType).not.toContain("cirugía");
    }
  });
});
