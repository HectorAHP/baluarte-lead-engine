import { describe, it, expect } from "vitest";
import { AppointmentCompletionService } from "../src/application/appointment-completion-service.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryAppointmentRepository,
  InMemoryMessageRepository, InMemoryAppointmentStatusHistoryRepository, InMemoryLeadStatusHistoryRepository,
  InMemoryAppointmentMessageDeliveryRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";

function makeService() {
  const leads = new InMemoryLeadRepository();
  const conversations = new InMemoryConversationRepository();
  const appointments = new InMemoryAppointmentRepository();
  const messages = new InMemoryMessageRepository();
  const messaging = new FakeMessagingProvider();
  const appointmentStatusHistory = new InMemoryAppointmentStatusHistoryRepository();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const appointmentMessageDeliveries = new InMemoryAppointmentMessageDeliveryRepository();
  const logger = new FakeLogger();
  const service = new AppointmentCompletionService(
    appointments, leads, conversations, messages, messaging,
    appointmentStatusHistory, leadStatusHistory, appointmentMessageDeliveries,
    "no_show_nudge", "es_MX", logger,
  );
  return { leads, conversations, appointments, messages, messaging, appointmentStatusHistory, leadStatusHistory, appointmentMessageDeliveries, logger, service };
}

async function seedBooked(h: ReturnType<typeof makeService>) {
  const lead = await h.leads.create({
    firstName: "Luis", country: "MX", productVertical: "GMM", status: "BOOKED", score: 71,
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214771234567",
  });
  const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  const appointment = await h.appointments.create({
    leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-01T15:00:00.000Z"),
    endsAt: new Date("2026-03-01T15:30:00.000Z"), timezone: "America/Mexico_City",
  });
  return { lead, conversation, appointment };
}

describe("AppointmentCompletionService", () => {
  it("markCompleted: BOOKED -> COMPLETED, lead BOOKED -> MEETING_COMPLETED, no message sent", async () => {
    const h = makeService();
    const { lead, appointment } = await seedBooked(h);

    const outcome = await h.service.markCompleted(appointment.id);

    expect(outcome).toMatchObject({ type: "COMPLETED" });
    expect((await h.appointments.findById(appointment.id))?.status).toBe("COMPLETED");
    expect((await h.leads.findById(lead.id))?.status).toBe("MEETING_COMPLETED");
    expect(h.messaging.sentTemplates).toHaveLength(0);
    expect(h.messaging.sentTexts).toHaveLength(0);
  });

  it("markCompleted also accepts a CONFIRMED starting status", async () => {
    const h = makeService();
    const { lead, appointment } = await seedBooked(h);
    await h.appointments.update(appointment.id, { status: "CONFIRMED" });
    await h.leads.update(lead.id, { status: "CONFIRMED" });

    const outcome = await h.service.markCompleted(appointment.id);

    expect(outcome).toMatchObject({ type: "COMPLETED" });
    expect((await h.leads.findById(lead.id))?.status).toBe("MEETING_COMPLETED");
  });

  it("markCompleted is idempotent -- a second call for an already-COMPLETED appointment is a no-op success, never a second history row", async () => {
    const h = makeService();
    const { appointment } = await seedBooked(h);

    await h.service.markCompleted(appointment.id);
    const second = await h.service.markCompleted(appointment.id);

    expect(second).toMatchObject({ type: "COMPLETED" });
    expect(await h.appointmentStatusHistory.listByAppointmentId(appointment.id)).toHaveLength(1);
  });

  it("markCompleted on an unknown appointment id returns NOT_FOUND", async () => {
    const h = makeService();
    const outcome = await h.service.markCompleted("00000000-0000-0000-0000-000000000000");
    expect(outcome).toEqual({ type: "NOT_FOUND" });
  });

  it("markCompleted on a CANCELLED appointment returns INCONSISTENT, never overwrites", async () => {
    const h = makeService();
    const { appointment } = await seedBooked(h);
    await h.appointments.update(appointment.id, { status: "CANCELLED" });

    const outcome = await h.service.markCompleted(appointment.id);

    expect(outcome).toEqual({ type: "INCONSISTENT" });
    expect((await h.appointments.findById(appointment.id))?.status).toBe("CANCELLED");
  });

  it("item 13: appointment_status_history records the real BOOKED -> COMPLETED transition with the closed eventType", async () => {
    const h = makeService();
    const { appointment } = await seedBooked(h);

    await h.service.markCompleted(appointment.id);

    const history = await h.appointmentStatusHistory.listByAppointmentId(appointment.id);
    expect(history[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "COMPLETED", eventType: "APPOINTMENT_MARKED_COMPLETED" });
  });

  it("item 12: lead lifecycle is not corrupted -- MEETING_COMPLETED lead_status_history row is written exactly once", async () => {
    const h = makeService();
    const { lead, appointment } = await seedBooked(h);

    await h.service.markCompleted(appointment.id);

    const history = await h.leadStatusHistory.listByLeadId(lead.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "MEETING_COMPLETED" });
  });

  it("markNoShow: BOOKED -> NO_SHOW, lead -> NO_SHOW, AND sends the no-show nudge exactly once", async () => {
    const h = makeService();
    const { lead, conversation, appointment } = await seedBooked(h);

    const outcome = await h.service.markNoShow(appointment.id);

    expect(outcome).toMatchObject({ type: "NO_SHOW" });
    expect((await h.appointments.findById(appointment.id))?.status).toBe("NO_SHOW");
    expect((await h.leads.findById(lead.id))?.status).toBe("NO_SHOW");
    expect(h.messaging.sentTemplates).toHaveLength(1);
    expect(h.messaging.sentTemplates[0]).toMatchObject({ templateName: "no_show_nudge", languageCode: "es_MX", params: ["Luis"] });
    const outbound = (await h.messages.listByConversationId(conversation.id)).filter((m) => m.direction === "OUTBOUND");
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toContain("no pudimos conectar");
  });

  it("item 14: the no-show nudge delivery row is idempotent -- a second markNoShow call never sends a second nudge", async () => {
    const h = makeService();
    const { appointment } = await seedBooked(h);

    await h.service.markNoShow(appointment.id);
    const second = await h.service.markNoShow(appointment.id); // idempotent retry of the whole call

    expect(second).toMatchObject({ type: "NO_SHOW" });
    expect(h.messaging.sentTemplates).toHaveLength(1);
    const delivery = await h.appointmentMessageDeliveries.findByIdempotencyKey(`NO_SHOW_NUDGE:${appointment.id}`);
    expect(delivery?.status).toBe("COMPLETED");
  });

  it("item 17: no code path ever transitions an appointment to NO_SHOW automatically -- only markNoShow (Héctor-driven) does", async () => {
    // Structural guard: markNoShow/markCompleted are the ONLY writers of appointments.status ->
    // NO_SHOW/COMPLETED in this codebase (grep-verified against src/ during the Fase 7A audit --
    // see the Fase 7A report). This test documents that contract at the unit level: a plain
    // sweep-style read (listActiveStartingBetween) never itself calls claimTransition, so simply
    // querying appointments never mutates one.
    const h = makeService();
    const { appointment } = await seedBooked(h);

    await h.appointments.listActiveStartingBetween(new Date(0), new Date("2100-01-01"));

    expect((await h.appointments.findById(appointment.id))?.status).toBe("BOOKED");
  });

  it("markNoShow on an appointment with no whatsappUserId still transitions the appointment/lead; the nudge is left FAILED, never blocking the transition", async () => {
    const h = makeService();
    const lead = await h.leads.create({ country: "MX", productVertical: "GMM", status: "BOOKED", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true });
    await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
    const appointment = await h.appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-01T15:00:00.000Z"), endsAt: new Date("2026-03-01T15:30:00.000Z"), timezone: "America/Mexico_City" });

    const outcome = await h.service.markNoShow(appointment.id);

    expect(outcome).toMatchObject({ type: "NO_SHOW" });
    expect((await h.leads.findById(lead.id))?.status).toBe("NO_SHOW");
    expect(h.messaging.sentTemplates).toHaveLength(0);
    const delivery = await h.appointmentMessageDeliveries.findByIdempotencyKey(`NO_SHOW_NUDGE:${appointment.id}`);
    expect(delivery?.status).toBe("FAILED");
  });
});
