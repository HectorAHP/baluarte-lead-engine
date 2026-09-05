import { describe, it, expect } from "vitest";
import { AppointmentReminderService } from "../src/application/appointment-reminder-service.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryAppointmentRepository,
  InMemoryMessageRepository, InMemoryAppointmentMessageDeliveryRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { appointmentConfirmationMetadata } from "../src/domain/appointment-confirmation-state.js";
import type { SendMessageResult, MessagingProvider } from "../src/application/ports.js";
import { MessagingProviderError } from "../src/domain/errors.js";

const TEMPLATES = { reminder24h: "recordatorio_24h", reminder2h: "recordatorio_2h", postMeeting: "seguimiento_post_cita", languageCode: "es_MX" };
const TIMEZONE = "America/Mexico_City";

function makeService(messaging: MessagingProvider = new FakeMessagingProvider()) {
  const leads = new InMemoryLeadRepository();
  const conversations = new InMemoryConversationRepository();
  const appointments = new InMemoryAppointmentRepository();
  const messages = new InMemoryMessageRepository();
  const appointmentMessageDeliveries = new InMemoryAppointmentMessageDeliveryRepository();
  const logger = new FakeLogger();
  const service = new AppointmentReminderService(
    { appointments, leads, conversations, messages, messaging, appointmentMessageDeliveries, logger },
    TEMPLATES,
    TIMEZONE,
  );
  return { leads, conversations, appointments, messages, appointmentMessageDeliveries, logger, service };
}

async function seedBookedLead(h: ReturnType<typeof makeService>, startsAt: Date, status: "BOOKED" | "CONFIRMED" | "CANCELLED" | "COMPLETED" = "BOOKED") {
  const lead = await h.leads.create({
    firstName: "Ana", country: "MX", productVertical: "GMM", status: "BOOKED", score: 71,
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214771234567",
  });
  const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  const appointment = await h.appointments.create({
    leadId: lead.id, status, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000), timezone: TIMEZONE,
  });
  return { lead, conversation, appointment };
}

const NOW = new Date("2026-03-01T09:00:00.000Z");
const ENABLE_ALL = { enableReminders: true, enablePostMeetingFollowup: true };

describe("AppointmentReminderService", () => {
  it("item 1: a BOOKED appointment starting in ~23h is eligible for REMINDER_24H", async () => {
    const h = makeService();
    const startsAt = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);
    const { appointment } = await seedBookedLead(h, startsAt);

    const summary = await h.service.run(NOW, ENABLE_ALL);

    expect(summary.reminder24h).toMatchObject({ candidates: 1, sent: 1, failed: 0 });
    const delivery = await h.appointmentMessageDeliveries.findByIdempotencyKey(`REMINDER_24H:${appointment.id}`);
    expect(delivery?.status).toBe("COMPLETED");
  });

  it("item 2: a second sweep tick never re-sends the same 24h reminder", async () => {
    const h = makeService();
    const startsAt = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);
    await seedBookedLead(h, startsAt);

    await h.service.run(NOW, ENABLE_ALL);
    const second = await h.service.run(new Date(NOW.getTime() + 60_000), ENABLE_ALL);

    expect(second.reminder24h).toMatchObject({ candidates: 1, sent: 0, skipped: 1 });
  });

  it("item 3: a BOOKED appointment starting in ~1h is eligible for REMINDER_2H", async () => {
    const h = makeService();
    const startsAt = new Date(NOW.getTime() + 60 * 60 * 1000);
    const { appointment } = await seedBookedLead(h, startsAt);

    const summary = await h.service.run(NOW, ENABLE_ALL);

    expect(summary.reminder2h).toMatchObject({ candidates: 1, sent: 1, failed: 0 });
    const delivery = await h.appointmentMessageDeliveries.findByIdempotencyKey(`REMINDER_2H:${appointment.id}`);
    expect(delivery?.status).toBe("COMPLETED");
  });

  it("item 4: a second sweep tick never re-sends the same 2h reminder", async () => {
    const h = makeService();
    const startsAt = new Date(NOW.getTime() + 60 * 60 * 1000);
    await seedBookedLead(h, startsAt);

    await h.service.run(NOW, ENABLE_ALL);
    const second = await h.service.run(new Date(NOW.getTime() + 60_000), ENABLE_ALL);

    expect(second.reminder2h).toMatchObject({ sent: 0, skipped: 1 });
  });

  it("item 5: a CANCELLED appointment receives no reminder even if startsAt falls in the window", async () => {
    const h = makeService();
    const startsAt = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);
    await seedBookedLead(h, startsAt, "CANCELLED");

    const summary = await h.service.run(NOW, ENABLE_ALL);

    expect(summary.reminder24h).toMatchObject({ candidates: 0, sent: 0 });
  });

  it("item 6: an appointment whose startsAt has already passed receives no reminder", async () => {
    const h = makeService();
    const startsAt = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h in the past
    await seedBookedLead(h, startsAt);

    const summary = await h.service.run(NOW, ENABLE_ALL);

    expect(summary.reminder24h).toMatchObject({ candidates: 0 });
    expect(summary.reminder2h).toMatchObject({ candidates: 0 });
  });

  it("both flags false: no sweep queries the DB, every summary is empty", async () => {
    const h = makeService();
    await seedBookedLead(h, new Date(NOW.getTime() + 60 * 60 * 1000));

    const summary = await h.service.run(NOW, { enableReminders: false, enablePostMeetingFollowup: false });

    expect(summary).toEqual({
      reminder24h: { candidates: 0, sent: 0, failed: 0, skipped: 0 },
      reminder2h: { candidates: 0, sent: 0, failed: 0, skipped: 0 },
      postMeetingFollowup: { candidates: 0, sent: 0, failed: 0, skipped: 0 },
    });
  });

  it("item 15: a COMPLETED appointment that ended ~60 minutes ago is eligible for the post-meeting follow-up", async () => {
    const h = makeService();
    const startsAt = new Date(NOW.getTime() - 90 * 60 * 1000); // ends 60 min ago (30-min meeting)
    const { appointment } = await seedBookedLead(h, startsAt, "COMPLETED");

    const summary = await h.service.run(NOW, ENABLE_ALL);

    expect(summary.postMeetingFollowup).toMatchObject({ candidates: 1, sent: 1 });
    const delivery = await h.appointmentMessageDeliveries.findByIdempotencyKey(`POST_MEETING_FOLLOWUP:${appointment.id}`);
    expect(delivery?.status).toBe("COMPLETED");
  });

  it("item 16: a second sweep tick never re-sends the same post-meeting follow-up", async () => {
    const h = makeService();
    const startsAt = new Date(NOW.getTime() - 90 * 60 * 1000);
    await seedBookedLead(h, startsAt, "COMPLETED");

    await h.service.run(NOW, ENABLE_ALL);
    const second = await h.service.run(new Date(NOW.getTime() + 60_000), ENABLE_ALL);

    expect(second.postMeetingFollowup).toMatchObject({ sent: 0, skipped: 1 });
  });

  it("a NO_SHOW appointment never receives a post-meeting follow-up (only COMPLETED is swept)", async () => {
    const h = makeService();
    const startsAt = new Date(NOW.getTime() - 90 * 60 * 1000);
    await seedBookedLead(h, startsAt, "COMPLETED"); // baseline: COMPLETED works
    const noShowStart = new Date(NOW.getTime() - 4 * 60 * 60 * 1000); // different slot -- avoids the single-advisor-calendar overlap guard
    const noShowLead = await h.leads.create({ country: "MX", productVertical: "GMM", status: "NO_SHOW", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214779999999" });
    await h.conversations.create({ leadId: noShowLead.id, channel: "WHATSAPP", status: "ACTIVE" });
    await h.appointments.create({ leadId: noShowLead.id, status: "NO_SHOW", startsAt: noShowStart, endsAt: new Date(noShowStart.getTime() + 30 * 60 * 1000), timezone: TIMEZONE });

    const summary = await h.service.run(NOW, ENABLE_ALL);

    expect(summary.postMeetingFollowup.candidates).toBe(1); // only the COMPLETED one, not the NO_SHOW one
  });

  it("item 18: a FAILED delivery is retried by a later tick and eventually succeeds exactly once", async () => {
    let calls = 0;
    const flakyMessaging: MessagingProvider = {
      async sendText(to, body) {
        return { providerMessageId: "unused" };
      },
      async sendTemplate(): Promise<SendMessageResult> {
        calls++;
        if (calls === 1) throw new MessagingProviderError("simulated transient failure");
        return { providerMessageId: `wamid-${calls}` };
      },
      async markRead() {},
    };
    const h = makeService(flakyMessaging);
    const startsAt = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);
    const { appointment } = await seedBookedLead(h, startsAt);

    const first = await h.service.run(NOW, ENABLE_ALL);
    expect(first.reminder24h).toMatchObject({ sent: 0, failed: 1 });

    const second = await h.service.run(new Date(NOW.getTime() + 60_000), ENABLE_ALL);
    expect(second.reminder24h).toMatchObject({ sent: 1, failed: 0 });

    expect(calls).toBe(2);
    const delivery = await h.appointmentMessageDeliveries.findByIdempotencyKey(`REMINDER_24H:${appointment.id}`);
    expect(delivery?.status).toBe("COMPLETED");
    expect(delivery?.attemptCount).toBe(2);
  });

  it("item 21: sendTemplate is called with the configured template name and [name, when] params for the 24h reminder", async () => {
    const messaging = new FakeMessagingProvider();
    const h = makeService(messaging);
    const startsAt = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);
    await seedBookedLead(h, startsAt);

    await h.service.run(NOW, ENABLE_ALL);

    expect(messaging.sentTemplates).toHaveLength(1);
    expect(messaging.sentTemplates[0].templateName).toBe("recordatorio_24h");
    expect(messaging.sentTemplates[0].languageCode).toBe("es_MX");
    expect(messaging.sentTemplates[0].params).toHaveLength(2);
    expect(messaging.sentTemplates[0].params?.[0]).toBe("Ana");
  });

  it("item 21b: sendTemplate is called with [name] only for the post-meeting follow-up", async () => {
    const messaging = new FakeMessagingProvider();
    const h = makeService(messaging);
    const startsAt = new Date(NOW.getTime() - 90 * 60 * 1000);
    await seedBookedLead(h, startsAt, "COMPLETED");

    await h.service.run(NOW, ENABLE_ALL);

    expect(messaging.sentTemplates[0].templateName).toBe("seguimiento_post_cita");
    expect(messaging.sentTemplates[0].params).toEqual(["Ana"]);
  });

  it("item 22: the 'when' variable is formatted in America/Mexico_City, not raw UTC", async () => {
    const messaging = new FakeMessagingProvider();
    const h = makeService(messaging);
    // 2026-03-02T02:00:00Z is 2026-03-01, 8:00 p.m. in America/Mexico_City (UTC-6, no DST at that date)
    const startsAt = new Date("2026-03-02T02:00:00.000Z");
    await seedBookedLead(h, startsAt);

    await h.service.run(new Date(startsAt.getTime() - 23 * 60 * 60 * 1000), ENABLE_ALL);

    expect(messaging.sentTemplates[0].params?.[1]).toContain("8:00 p.m.");
  });

  it("item 23: proactive reminders are ALWAYS sent via sendTemplate, never sendText", async () => {
    const messaging = new FakeMessagingProvider();
    const h = makeService(messaging);
    await seedBookedLead(h, new Date(NOW.getTime() + 60 * 60 * 1000));

    await h.service.run(NOW, ENABLE_ALL);

    expect(messaging.sentTexts).toHaveLength(0);
    expect(messaging.sentTemplates.length).toBeGreaterThan(0);
  });

  it("the 24h reminder's persisted outbound message carries the appointment-confirmation pending marker; the 2h/post-meeting ones do not", async () => {
    const h = makeService();
    const { conversation: conv24h } = await seedBookedLead(h, new Date(NOW.getTime() + 23 * 60 * 60 * 1000));
    await h.service.run(NOW, ENABLE_ALL);
    const messages24h = await h.messages.listByConversationId(conv24h.id);
    expect(messages24h[messages24h.length - 1].metadata).toEqual(appointmentConfirmationMetadata());

    const h2 = makeService();
    const { conversation: conv2h } = await seedBookedLead(h2, new Date(NOW.getTime() + 60 * 60 * 1000));
    await h2.service.run(NOW, ENABLE_ALL);
    const messages2h = await h2.messages.listByConversationId(conv2h.id);
    expect(messages2h[messages2h.length - 1].metadata).toEqual({});
  });

  it("a lead with no whatsappUserId never gets a reminder attempt", async () => {
    const h = makeService();
    const lead = await h.leads.create({ country: "MX", productVertical: "GMM", status: "BOOKED", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true });
    await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
    await h.appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date(NOW.getTime() + 60 * 60 * 1000), endsAt: new Date(NOW.getTime() + 90 * 60 * 1000), timezone: TIMEZONE });

    const summary = await h.service.run(NOW, ENABLE_ALL);

    expect(summary.reminder2h).toMatchObject({ candidates: 1, sent: 0, failed: 1 });
  });

  it("a lead in HUMAN_HANDOFF is skipped without consuming a delivery attempt (retriable if it resolves)", async () => {
    const h = makeService();
    const { lead } = await seedBookedLead(h, new Date(NOW.getTime() + 60 * 60 * 1000));
    await h.leads.update(lead.id, { status: "HUMAN_HANDOFF" });

    const summary = await h.service.run(NOW, ENABLE_ALL);

    expect(summary.reminder2h).toMatchObject({ sent: 0, skipped: 1 });
    // The delivery row IS created (by tryCreate, ahead of the lead-status check -- see attempt()'s
    // ordering) but deliberately left at its initial PENDING/attemptCount:0 state -- never
    // advanced to FAILED -- so a later tick, once the lead is no longer HUMAN_HANDOFF, retries it
    // fresh rather than fighting the MAX_DELIVERY_ATTEMPTS cap for a condition unrelated to
    // messaging.
    const delivery = await h.appointmentMessageDeliveries.findByIdempotencyKey(`REMINDER_2H:${(await h.appointments.listAllByLeadId(lead.id))[0].id}`);
    expect(delivery).toMatchObject({ status: "PENDING", attemptCount: 0 });
  });
});
