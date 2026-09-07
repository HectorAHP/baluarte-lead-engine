import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryAppointmentRepository, InMemoryLeadScoreRepository, InMemoryQualificationAnswerRepository,
  InMemoryBookingAttemptRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository, InMemoryAppointmentCancellationRepository,
  InMemoryAppointmentRescheduleRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import type { CalendarProvider, CalendarEventInput } from "../src/application/ports.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";

/**
 * Fase 7J.2 -- end-to-end coverage of the advisor WhatsApp alert, driven through the real webhook
 * route (buildTestApp), for both call sites (BOOKED and BOOKING_PENDING). Covers the spec's own
 * "13. TESTS" list items 1, 5, 6, 7, 10, and 13-20 (11/12 are covered directly against
 * escalateToHuman in booking-outcome-dispatch-handoff-alert.test.ts; 2/3/4/8/9 are covered at the
 * HumanHandoffAlertService unit level in human-handoff-alert-service.test.ts).
 */

const ADVISOR_PHONE_RAW = "5215500000003"; // obviously-fake test number, wa_id-shaped MX
const ADVISOR_PHONE_E164 = "+525500000003";

class CountingCalendarProvider implements CalendarProvider {
  getAvailableSlotsCalls = 0;
  createEventCalls = 0;
  constructor(private readonly inner: CalendarProvider) {}
  async getAvailableSlots(...args: Parameters<CalendarProvider["getAvailableSlots"]>) { this.getAvailableSlotsCalls++; return this.inner.getAvailableSlots(...args); }
  async isSlotAvailable(start: Date, end: Date) { return this.inner.isSlotAvailable(start, end); }
  isWithinBusinessHours(start: Date, end: Date) { return this.inner.isWithinBusinessHours(start, end); }
  async createEvent(input: CalendarEventInput) { this.createEventCalls++; return this.inner.createEvent(input); }
  async deleteEvent(eventId: string) { return this.inner.deleteEvent(eventId); }
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function textWebhookBody(overrides: { from?: string; id?: string; body?: string; name?: string } = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          contacts: [{ profile: { name: overrides.name ?? "Ana" }, wa_id: overrides.from ?? "5214778880001" }],
          messages: [{ from: overrides.from ?? "5214778880001", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
        },
      }],
    }],
  });
}

function buildRepos(calendar: CalendarProvider = new FakeCalendarProvider()) {
  return {
    leadsRepo: new InMemoryLeadRepository(),
    conversationsRepo: new InMemoryConversationRepository(),
    messagesRepo: new InMemoryMessageRepository(),
    appointmentsRepo: new InMemoryAppointmentRepository(),
    leadScoresRepo: new InMemoryLeadScoreRepository(),
    qualificationAnswersRepo: new InMemoryQualificationAnswerRepository(),
    bookingAttemptsRepo: new InMemoryBookingAttemptRepository(),
    offeredSlotsRepo: new InMemoryOfferedSlotRepository(),
    slotOfferClaimsRepo: new InMemorySlotOfferClaimRepository(),
    leadStatusHistoryRepo: new InMemoryLeadStatusHistoryRepository(),
    appointmentStatusHistoryRepo: new InMemoryAppointmentStatusHistoryRepository(),
    appointmentCancellationsRepo: new InMemoryAppointmentCancellationRepository(),
    appointmentReschedulesRepo: new InMemoryAppointmentRescheduleRepository(),
    calendar,
  };
}

async function send(app: Awaited<ReturnType<typeof buildTestApp>>, from: string, id: string, body: string) {
  const payload = textWebhookBody({ from, id, body });
  return app.inject({
    method: "POST", url: "/webhooks/whatsapp", payload,
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET) },
  });
}

async function createLeadAtStatus(repos: ReturnType<typeof buildRepos>, whatsappUserId: string, status: LeadStatus, overrides: Partial<Lead> = {}) {
  const lead = await repos.leadsRepo.create({
    country: "MX", productVertical: "GMM", productInterest: "GMM", status: "NEW", score: 81, scoreClass: "B",
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId,
    bookedAt: new Date("2026-08-20T10:00:00.000Z"), meetingAt: new Date("2030-06-15T15:30:00.000Z"),
    ...overrides,
  });
  await repos.leadsRepo.update(lead.id, { status, ...overrides });
  const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead: (await repos.leadsRepo.findById(lead.id))!, conversation };
}

async function seedActiveRound(repos: ReturnType<typeof buildRepos>, leadId: string, conversationId: string) {
  const roundId = `round-${leadId}`;
  const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
  return repos.offeredSlotsRepo.createMany([
    { conversationId, leadId, roundId, slotStart: new Date("2030-06-15T15:00:00.000Z"), slotEnd: new Date("2030-06-15T15:30:00.000Z"), position: 1, expiresAt, selected: false },
  ]);
}

describe("Fase 7J.2 -- advisor WhatsApp alert on UNKNOWN_INTENT_HANDOFF (E2E)", () => {
  it("1: BOOKED + unsupported real question, alerts enabled -> exactly one alert to the advisor", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead } = await createLeadAtStatus(repos, "5214779992001", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214779992001", "wamid.1a", "¿también me pueden ayudar con el seguro de mi empresa?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(messaging.sentTemplates).toHaveLength(1);
    expect(messaging.sentTemplates[0].to).toBe(ADVISOR_PHONE_E164);
    expect(messaging.sentTemplates[0].templateName).toBe("handoff_asesor");
    // Never the lead's own number, never the raw inbound text, anywhere in the sent template.
    expect(messaging.sentTemplates[0].params!.join(" ")).not.toContain("seguro de mi empresa");
  });

  it("1b: BOOKING_PENDING + unsupported real question, alerts enabled -> exactly one alert to the advisor (the OTHER call site)", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappBookingEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779992002", "BOOKING_PENDING");
    await seedActiveRound(repos, lead.id, conversation.id);

    await send(app, "5214779992002", "wamid.1b", "¿Cuáles son los servicios?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(messaging.sentTemplates).toHaveLength(1);
    expect(messaging.sentTemplates[0].to).toBe(ADVISOR_PHONE_E164);
  });

  it("5: alerts flag false (default) -> no alert attempted at all", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214779992005", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214779992005", "wamid.5a", "¿también me pueden ayudar con el seguro de mi empresa?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF"); // the handoff itself is Fase 7J/7J.1, unaffected by this flag
    expect(messaging.sentTemplates).toHaveLength(0);
  });

  it("6: duplicate webhook delivery (same provider_message_id) -> one handoff, one alert total", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead } = await createLeadAtStatus(repos, "5214779992006", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214779992006", "wamid.6a", "¿también me pueden ayudar con el seguro de mi empresa?");
    await send(app, "5214779992006", "wamid.6a", "¿también me pueden ayudar con el seguro de mi empresa?"); // exact same provider_message_id

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(messaging.sentTemplates).toHaveLength(1);
  });

  it("7: a second, DISTINCT inbound while already HUMAN_HANDOFF -> no second alert (terminal suppression, unaffected by the alert flag)", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead } = await createLeadAtStatus(repos, "5214779992007", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214779992007", "wamid.7a", "¿también me pueden ayudar con el seguro de mi empresa?");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(messaging.sentTemplates).toHaveLength(1);

    await send(app, "5214779992007", "wamid.7b", "hola, siguen ahi?"); // genuinely different message

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF"); // unchanged
    expect(messaging.sentTemplates).toHaveLength(1); // still just one
  });

  it("10: HUMAN_HANDOFF_ALERTS_ENABLED true but an invalid advisor phone override -> alerts effectively disabled, handoff itself unaffected", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: "not-a-real-phone" });
    const { lead } = await createLeadAtStatus(repos, "5214779992010", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214779992010", "wamid.10a", "¿también me pueden ayudar con el seguro de mi empresa?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF"); // still escalates
    expect(messaging.sentTemplates).toHaveLength(0); // but never sent -- fail-safe, never to an invalid destination
  });

  it("13: DO_NOT_CONTACT (opt-out) unchanged with alerts enabled -- never treated as a handoff, never alerted", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead } = await createLeadAtStatus(repos, "5214779992013", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214779992013", "wamid.13a", "no me escriban mas");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("DO_NOT_CONTACT");
    expect(messaging.sentTemplates).toHaveLength(0);
  });

  it("14/15: BOOKED known intent (cancelar) unchanged with alerts enabled -- no alert", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead } = await createLeadAtStatus(repos, "5214779992014", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214779992014", "wamid.14a", "cancelar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING"); // never HUMAN_HANDOFF
    expect(messaging.sentTemplates).toHaveLength(0);
  });

  it("14b: known booking flow (numeric slot selection) unchanged with alerts enabled -- no alert", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappBookingEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779992114", "BOOKING_PENDING");
    await seedActiveRound(repos, lead.id, conversation.id);

    await send(app, "5214779992114", "wamid.14c", "1");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED"); // never HUMAN_HANDOFF
    expect(messaging.sentTemplates).toHaveLength(0);
  });

  it("16: cancellation flow (BOOKED + cancelar + confirm) unchanged with alerts enabled", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead } = await createLeadAtStatus(repos, "5214779992016", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-08-28T15:30:00.000Z"), endsAt: new Date("2026-08-28T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214779992016", "wamid.16a", "Quiero cancelar");
    await send(app, "5214779992016", "wamid.16b", "1");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCELLED"); // never HUMAN_HANDOFF
    expect(messaging.sentTemplates).toHaveLength(0);
  });

  it("17: reschedule flow (BOOKED + reagendar) unchanged with alerts enabled", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead } = await createLeadAtStatus(repos, "5214779992017", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214779992017", "wamid.17a", "reagendar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED"); // never HUMAN_HANDOFF
    expect(messaging.sentTemplates).toHaveLength(0);
  });

  it("18: a bare date-preference mention on BOOKED (item 8 of Fase 7J.1) unchanged with alerts enabled", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead } = await createLeadAtStatus(repos, "5214779992018", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214779992018", "wamid.18a", "¿Mi cita es el sábado?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED"); // never HUMAN_HANDOFF, never RESCHEDULE_REQUESTED
    expect(messaging.sentTemplates).toHaveLength(0);
  });

  it("19: contextual reschedule ('Mejor el domingo') unchanged with alerts enabled", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead } = await createLeadAtStatus(repos, "5214779992019", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214779992019", "wamid.19a", "Mejor el domingo");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED"); // never HUMAN_HANDOFF
    expect(messaging.sentTemplates).toHaveLength(0);
  });

  it("20: the alert path never causes a Calendar write -- an UNKNOWN_INTENT_HANDOFF escalation makes zero Calendar calls", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const repos = buildRepos(calendar);
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead } = await createLeadAtStatus(repos, "5214779992020", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214779992020", "wamid.20a", "¿también me pueden ayudar con el seguro de mi empresa?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(calendar.getAvailableSlotsCalls).toBe(0);
    expect(calendar.createEventCalls).toBe(0);
  });
});
