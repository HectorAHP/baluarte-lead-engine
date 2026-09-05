import { describe, it, expect } from "vitest";
import { WhatsAppAppointmentConfirmationHandler } from "../src/application/whatsapp-appointment-confirmation-handler.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryAppointmentRepository,
  InMemoryMessageRepository, InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { appointmentConfirmationMetadata } from "../src/domain/appointment-confirmation-state.js";

function makeHandler() {
  const leads = new InMemoryLeadRepository();
  const conversations = new InMemoryConversationRepository();
  const appointments = new InMemoryAppointmentRepository();
  const messages = new InMemoryMessageRepository();
  const messaging = new FakeMessagingProvider();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const appointmentStatusHistory = new InMemoryAppointmentStatusHistoryRepository();
  const logger = new FakeLogger();
  const handler = new WhatsAppAppointmentConfirmationHandler({
    leads, conversations, appointments, appointmentStatusHistory, messaging, messages, leadStatusHistory, logger,
  });
  return { leads, conversations, appointments, messages, messaging, leadStatusHistory, appointmentStatusHistory, logger, handler };
}

async function makeBookedLeadWithReminderSent(h: ReturnType<typeof makeHandler>) {
  const lead = await h.leads.create({
    firstName: "Juan", country: "MX", productVertical: "GMM", status: "BOOKED", score: 71,
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214771234567",
  });
  const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  const appointment = await h.appointments.create({
    leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"),
    endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-1",
  });
  // Simulates AppointmentReminderService having already sent the 24h reminder on this conversation
  // -- the ONE outbound message a real pending-confirmation turn always has behind it.
  await h.messages.create({
    conversationId: conversation.id, leadId: lead.id, direction: "OUTBOUND", channel: "WHATSAPP",
    body: "Hola, Juan. Te recuerdo tu asesoría...", aiGenerated: false, metadata: appointmentConfirmationMetadata(),
  });
  return { lead, conversation, appointment };
}

const NOW = new Date("2026-03-01T09:00:00.000Z");

describe("WhatsAppAppointmentConfirmationHandler", () => {
  it("item 7: 'sí' confirms the appointment (BOOKED -> CONFIRMED, appointment BOOKED -> CONFIRMED)", async () => {
    const h = makeHandler();
    const { lead, conversation, appointment } = await makeBookedLeadWithReminderSent(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "sí", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("CONFIRMED");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("CONFIRMED");
    expect(h.messaging.sentTexts).toHaveLength(1);
    expect(h.messaging.sentTexts[0].body).toContain("Perfecto, Juan");
    expect(h.messaging.sentTexts[0].body).toContain("confirmada");
  });

  it("item 8: 'confirmo' also confirms the appointment", async () => {
    const h = makeHandler();
    const { lead, conversation, appointment } = await makeBookedLeadWithReminderSent(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "confirmo", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("CONFIRMED");
    expect((await h.appointments.findById(appointment.id))?.status).toBe("CONFIRMED");
  });

  it("item 9: appointment_status_history / lead_status_history rows are written exactly once for the real transition", async () => {
    const h = makeHandler();
    const { lead, conversation, appointment } = await makeBookedLeadWithReminderSent(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "sí", now: NOW });

    const leadHistory = await h.leadStatusHistory.listByLeadId(lead.id);
    expect(leadHistory).toHaveLength(1);
    expect(leadHistory[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "CONFIRMED", eventType: "APPOINTMENT_ATTENDANCE_CONFIRMED" });

    const apptHistory = await h.appointmentStatusHistory.listByAppointmentId(appointment.id);
    expect(apptHistory).toHaveLength(1);
    expect(apptHistory[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "CONFIRMED", eventType: "APPOINTMENT_ATTENDANCE_CONFIRMED" });
  });

  it("a duplicate 'sí' after confirmation is idempotent -- no second history row, no second message sent by a second handleTurn call", async () => {
    const h = makeHandler();
    const { lead, conversation } = await makeBookedLeadWithReminderSent(h);

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "sí", now: NOW });
    const confirmedLead = (await h.leads.findById(lead.id))!;
    await h.handler.handleTurn({ lead: confirmedLead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "sí", now: NOW });

    // Guard: handleTurn only ever acts for lead.status === "BOOKED" -- a caller passing an
    // already-CONFIRMED lead snapshot (exactly what whatsapp-inbound-service.ts would do on a
    // genuinely separate second inbound, since IT re-fetches the lead before dispatching) is a
    // pure no-op here, matching WhatsAppCancellationHandler's own guard.
    expect(await h.leadStatusHistory.listByLeadId(lead.id)).toHaveLength(1);
    expect(h.messaging.sentTexts).toHaveLength(1);
  });

  it("no appointment at all -> escalates to HUMAN_HANDOFF, never silently no-ops", async () => {
    const h = makeHandler();
    const lead = await h.leads.create({ country: "MX", productVertical: "GMM", status: "BOOKED", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214771234567" });
    const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
    await h.messages.create({ conversationId: conversation.id, leadId: lead.id, direction: "OUTBOUND", channel: "WHATSAPP", body: "reminder", aiGenerated: false, metadata: appointmentConfirmationMetadata() });

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "sí", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect((await h.conversations.findById(conversation.id))?.status).toBe("HUMAN_HANDOFF");
  });

  it("more than one active appointment -> escalates to HUMAN_HANDOFF (inconsistency, never picks one)", async () => {
    const h = makeHandler();
    const { lead, conversation } = await makeBookedLeadWithReminderSent(h);
    await h.appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-03T15:00:00.000Z"), endsAt: new Date("2026-03-03T15:30:00.000Z"), timezone: "America/Mexico_City" });

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "sí", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
  });

  it("lead.status !== BOOKED -> pure no-op guard (defensive, mirrors WhatsAppCancellationHandler)", async () => {
    const h = makeHandler();
    const lead = await h.leads.create({ country: "MX", productVertical: "GMM", status: "QUALIFIED_A", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214771234567" });
    const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });

    await h.handler.handleTurn({ lead, conversationId: conversation.id, whatsappUserId: "5214771234567", inboundText: "sí", now: NOW });

    expect((await h.leads.findById(lead.id))?.status).toBe("QUALIFIED_A");
    expect(h.messaging.sentTexts).toHaveLength(0);
  });
});
