import { describe, it, expect } from "vitest";
import { WhatsAppCancellationHandler } from "../src/application/whatsapp-cancellation-handler.js";
import { AppointmentCancellationService } from "../src/application/appointment-cancellation-service.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryAppointmentRepository,
  InMemoryMessageRepository, InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository,
  InMemoryAppointmentCancellationRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import type { Lead } from "../src/domain/lead.js";

function makeHandler() {
  const leads = new InMemoryLeadRepository();
  const conversations = new InMemoryConversationRepository();
  const appointments = new InMemoryAppointmentRepository();
  const messages = new InMemoryMessageRepository();
  const messaging = new FakeMessagingProvider();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const appointmentStatusHistory = new InMemoryAppointmentStatusHistoryRepository();
  const cancellations = new InMemoryAppointmentCancellationRepository();
  const calendar = new FakeCalendarProvider();
  const logger = new FakeLogger();
  const cancellationService = new AppointmentCancellationService(calendar, appointments, cancellations, appointmentStatusHistory, logger);
  const handler = new WhatsAppCancellationHandler(
    { leads, conversations, appointments, messaging, messages, leadStatusHistory, cancellationService, logger },
    "America/Mexico_City",
  );
  return { leads, conversations, appointments, messages, messaging, leadStatusHistory, appointmentStatusHistory, cancellations, calendar, logger, cancellationService, handler };
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

describe("WhatsAppCancellationHandler -- intent turn (BOOKED)", () => {
  it("BOOKED + 'cancelar cita' -> CANCEL_PENDING, sends the confirmation prompt with date/time", async () => {
    const h = makeHandler();
    const { lead, conversation } = await makeBookedLeadWithAppointment(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "cancelar cita", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("CANCEL_PENDING");
    expect(h.messaging.sentTexts).toHaveLength(1);
    expect(h.messaging.sentTexts[0].body).toContain("1. Sí, cancelar");
    expect(h.messaging.sentTexts[0].body).toContain("2. No, conservar");
    const history = await h.leadStatusHistory.listByLeadId(lead.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "CANCEL_PENDING", eventType: "CANCELLATION_REQUESTED" });
  });

  it("BOOKED + unrelated text -> no-op, no reply, no state change (mirrors the existing 'no automated reply' fallback)", async () => {
    const h = makeHandler();
    const { lead, conversation } = await makeBookedLeadWithAppointment(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "hola, gracias", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("BOOKED");
    expect(h.messaging.sentTexts).toHaveLength(0);
  });

  it("BOOKED with no active appointment -> HUMAN_HANDOFF", async () => {
    const h = makeHandler();
    const lead = await h.leads.create({ country: "MX", productVertical: "GMM", status: "BOOKED", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true });
    const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "cancelar cita", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect((await h.conversations.findById(conversation.id))?.status).toBe("HUMAN_HANDOFF");
  });

  it("BOOKED with more than one active appointment -> HUMAN_HANDOFF (inconsistency, never silently picks one)", async () => {
    const h = makeHandler();
    const { lead, conversation } = await makeBookedLeadWithAppointment(h);
    await h.appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-03T15:00:00.000Z"), endsAt: new Date("2026-03-03T15:30:00.000Z"), timezone: "America/Mexico_City" });

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "cancelar cita", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
  });
});

describe("WhatsAppCancellationHandler -- confirmation turn (CANCEL_PENDING)", () => {
  async function toCancelPending(h: ReturnType<typeof makeHandler>) {
    const ctx = await makeBookedLeadWithAppointment(h);
    await h.handler.handleTurn({ lead: ctx.lead, conversationId: ctx.conversation.id, whatsappUserId: "5214771234567", inboundText: "cancelar cita", now: NOW });
    const pendingLead = (await h.leads.findById(ctx.lead.id))!;
    return { ...ctx, pendingLead };
  }

  it("CANCEL_PENDING + '1' -> CANCELLED, sends the confirmed message, appointment CANCELLED", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toCancelPending(h);

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW });

    expect((await h.leads.findById(pendingLead.id))?.status).toBe("CANCELLED");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("CANCELLED");
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).toContain("Listo, tu cita quedó cancelada");
  });

  it("CANCEL_PENDING + '2' -> BOOKED, sends the aborted message, appointment untouched", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toCancelPending(h);

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "2", now: NOW });

    expect((await h.leads.findById(pendingLead.id))?.status).toBe("BOOKED");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED");
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).toBe("Entendido, tu cita se mantiene sin cambios.");
    const history = await h.leadStatusHistory.listByLeadId(pendingLead.id);
    expect(history[history.length - 1]).toMatchObject({ fromStatus: "CANCEL_PENDING", toStatus: "BOOKED", eventType: "CANCELLATION_ABORTED" });
  });

  it("ambiguous text never cancels -- stays CANCEL_PENDING, re-sends the confirmation prompt", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toCancelPending(h);

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "no se, tal vez", now: NOW });

    expect((await h.leads.findById(pendingLead.id))?.status).toBe("CANCEL_PENDING");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED");
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).toContain("No entendí tu respuesta");
    expect(lastMessage.body).toContain("1. Sí, cancelar");
  });

  it("duplicate '1' (two turns racing the same CANCEL_PENDING confirmation) -- idempotent: appointment cancelled once, lead history has exactly one CANCEL_PENDING->CANCELLED row", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toCancelPending(h);

    // Both turns hold the SAME stale CANCEL_PENDING snapshot -- exactly the race a duplicate
    // webhook delivery or a double-tapped "1" produces.
    await Promise.all([
      h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW }),
      h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW }),
    ]);

    expect((await h.leads.findById(pendingLead.id))?.status).toBe("CANCELLED");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("CANCELLED");
    const leadHistory = await h.leadStatusHistory.listByLeadId(pendingLead.id);
    const cancelledRows = leadHistory.filter((r) => r.toStatus === "CANCELLED");
    expect(cancelledRows).toHaveLength(1);
    const apptHistory = await h.appointmentStatusHistory.listByAppointmentId(appointment.id);
    expect(apptHistory).toHaveLength(1);
  });

  it("CANCEL_PENDING confirmation when the appointment is already CANCELLED (a genuinely separate later inbound) is still idempotent", async () => {
    const h = makeHandler();
    const { pendingLead, conversation } = await toCancelPending(h);
    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW });
    const cancelledLead: Lead = { ...pendingLead, status: "CANCEL_PENDING" }; // stale snapshot, as if a retry carried the pre-confirm state

    await h.handler.handleTurn({ lead: cancelledLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW });

    const leadHistory = await h.leadStatusHistory.listByLeadId(pendingLead.id);
    expect(leadHistory.filter((r) => r.toStatus === "CANCELLED")).toHaveLength(1);
  });

  it("regression: '2' (decline) against an appointment that's ALREADY cancelled (e.g. a crash left the lead stuck in CANCEL_PENDING after a prior CONFIRM completed) never reverts the lead to BOOKED against a lie -- it resolves as cancelled", async () => {
    const h = makeHandler();
    const { pendingLead, conversation, appointment } = await toCancelPending(h);
    // Simulate the crash-recovery scenario precisely: the CONFIRM path already ran to completion
    // at the appointment/DB level (cancellationService.cancel), but the lead itself never made it
    // to CANCELLED (as if the process died right after cancel() returned, before
    // ensureLeadCancelled ran) -- lead.status is still CANCEL_PENDING in reality.
    await h.cancellationService.cancel(appointment, pendingLead.id);

    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "2", now: NOW });

    // Must NOT be BOOKED (that would claim an appointment that no longer exists) -- must resolve
    // to CANCELLED, and the appointment stays CANCELLED throughout.
    expect((await h.leads.findById(pendingLead.id))?.status).toBe("CANCELLED");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("CANCELLED");
    const lastMessage = h.messaging.sentTexts[h.messaging.sentTexts.length - 1];
    expect(lastMessage.body).toContain("Listo, tu cita quedó cancelada");
  });
});

describe("WhatsAppCancellationHandler -- privacy", () => {
  it("no history row, anywhere, contains inbound message text or clinical content", async () => {
    const h = makeHandler();
    const { lead, conversation } = await makeBookedLeadWithAppointment(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "cancelar cita, tengo diabetes y no puedo ir", now: NOW });
    const pendingLead = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: pendingLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "1", now: NOW });

    const leadHistory = await h.leadStatusHistory.listByLeadId(lead.id);
    for (const row of leadHistory) {
      expect(JSON.stringify(row.metadata)).not.toContain("diabetes");
      expect(row.eventType).not.toContain("diabetes");
    }
  });
});
