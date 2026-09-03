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
import type { CalendarProvider, CalendarEventInput } from "../src/application/ports.js";
import { BOOKED_GENERIC_INBOUND_MESSAGE, PAST_BOOKED_GENERIC_INBOUND_MESSAGE } from "../src/domain/message-templates.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";

/**
 * PRE-LAUNCH HARDENING -- stale/past BOOKED appointment.
 *
 * Root cause: every guard that decides "does this lead have an active appointment to act around"
 * (SlotOfferingService's ALREADY_BOOKED short-circuit, WhatsAppBookingHandler's existingAppointment
 * guards, and -- most visibly -- the whatsapp-inbound-service.ts routing for a BOOKED lead's free
 * text) used `appointments.findActiveByLeadId`/`listActiveByLeadId`, whose repository-level
 * definition is `status === "BOOKED"` alone, with NO comparison against `endsAt`. A BOOKED
 * appointment whose end time has already passed was therefore indistinguishable from a genuinely
 * upcoming one anywhere in the app: "Hola"/"Agendar" hit the misleading BOOKED_GENERIC_INBOUND_MESSAGE
 * ("ya tienes una cita agendada..."), "Cancelar" would have entered the real cancel-confirmation
 * flow for a meeting that already happened, and "Reagendar" would have offered new slots
 * "rescheduling" a stale row instead of starting a genuinely new booking.
 *
 * Fix: `isUpcomingBooked(appointment, now)` (status === "BOOKED" AND endsAt > now) is the new
 * single source of truth for "upcoming active appointment", applied at every guard above. A BOOKED
 * lead whose appointment is NOT upcoming is routed to WhatsAppPastBookedRecoveryHandler instead --
 * never Calendar mutation, never automatic COMPLETED/NO_SHOW inference, never destructive action;
 * only a safe, informative reply, with an explicit new-booking-intent path that starts a real new
 * offer (BOOKED -> BOOKING_PENDING, a new state-machine edge, reusing the exact SlotOfferingService
 * mechanism CANCELLED-reactivation already established).
 */

/** Wraps a CalendarProvider to count createEvent/deleteEvent calls, so tests can assert "Calendar
 * was never touched" for a past appointment handled purely through generic/cancel/reschedule-intent
 * text. */
class CountingCalendarProvider implements CalendarProvider {
  createEventCalls = 0;
  deleteEventCalls = 0;
  constructor(private readonly inner: CalendarProvider) {}
  async getAvailableSlots(from: Date, to: Date, durationMinutes: number) {
    return this.inner.getAvailableSlots(from, to, durationMinutes);
  }
  async isSlotAvailable(start: Date, end: Date) {
    return this.inner.isSlotAvailable(start, end);
  }
  async createEvent(input: CalendarEventInput) {
    this.createEventCalls++;
    return this.inner.createEvent(input);
  }
  async deleteEvent(eventId: string) {
    this.deleteEventCalls++;
    return this.inner.deleteEvent(eventId);
  }
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function textWebhookBody(overrides: { from?: string; id?: string; body?: string; name?: string } = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ profile: { name: overrides.name ?? "Ana" }, wa_id: overrides.from ?? "5214778880001" }],
              messages: [{ from: overrides.from ?? "5214778880001", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
            },
          },
        ],
      },
    ],
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
    method: "POST",
    url: "/webhooks/whatsapp",
    payload,
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET) },
  });
}

async function createLeadAtStatus(repos: ReturnType<typeof buildRepos>, whatsappUserId: string, status: LeadStatus, overrides: Partial<Lead> = {}) {
  const lead = await repos.leadsRepo.create({
    country: "MX", productVertical: "PATRIMONIAL", productInterest: "SAVINGS", status: "NEW", score: 74, scoreClass: "B",
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId,
    qualifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  });
  await repos.leadsRepo.update(lead.id, { status, ...overrides });
  const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead: (await repos.leadsRepo.findById(lead.id))!, conversation };
}

async function outboundMessages(repos: ReturnType<typeof buildRepos>, conversationId: string) {
  const messages = await repos.messagesRepo.listByConversationId(conversationId);
  return messages.filter((m) => m.direction === "OUTBOUND");
}

/** Genuinely far in the future, matching the codebase's own precedent for time-safe test fixtures
 * (see whatsapp-booked-generic-fallback-e2e.test.ts's test D / whatsapp-reactivation-e2e.test.ts's
 * test H). */
const FUTURE_STARTS_AT = new Date("2030-06-15T15:00:00.000Z");
const FUTURE_ENDS_AT = new Date("2030-06-15T15:30:00.000Z");
/** Genuinely in the past relative to any real wall-clock this suite could ever run at. */
const PAST_STARTS_AT = new Date("2020-01-15T15:00:00.000Z");
const PAST_ENDS_AT = new Date("2020-01-15T15:30:00.000Z");

describe("Pre-launch hardening -- stale/past BOOKED appointment recovery", () => {
  it("1: a FUTURE BOOKED appointment still behaves as a genuinely active appointment -- generic text gets BOOKED_GENERIC_INBOUND_MESSAGE, never the past-booked copy", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779990001", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779990001", "wamid.1a", "Hola");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(BOOKED_GENERIC_INBOUND_MESSAGE);
  });

  it("2: a PAST BOOKED appointment does NOT trigger the future-appointment fallback -- generic text gets the past-booked copy instead", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779990002", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779990002", "wamid.2a", "Hola");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED"); // no state change from a generic message
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(PAST_BOOKED_GENERIC_INBOUND_MESSAGE);
    expect(outbound[0].body).not.toBe(BOOKED_GENERIC_INBOUND_MESSAGE);
  });

  it("3: past BOOKED + 'agendar' safely starts a new booking round -- lead reaches BOOKING_PENDING, real new offer sent", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779990003", "BOOKED");
    const staleAppointment = await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779990003", "wamid.3a", "Quiero agendar");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKING_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toContain("Tengo estos horarios disponibles");
    // The stale appointment row itself is never touched.
    const reloadedStale = await repos.appointmentsRepo.findById(staleAppointment.id);
    expect(reloadedStale?.status).toBe("BOOKED");
    expect(reloadedStale?.startsAt.getTime()).toBe(PAST_STARTS_AT.getTime());
  });

  it("4: past BOOKED + 'cancelar' never attempts a retroactive cancellation -- no Calendar call, appointment untouched, safe reply only", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const repos = buildRepos(calendar);
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779990004", "BOOKED");
    const staleAppointment = await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City", calendarEventId: "evt-stale-004" });

    await send(app, "5214779990004", "wamid.4a", "Cancelar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED"); // never CANCEL_PENDING/CANCELLED
    const reloadedStale = await repos.appointmentsRepo.findById(staleAppointment.id);
    expect(reloadedStale?.status).toBe("BOOKED"); // never CANCELLED
    expect(calendar.deleteEventCalls).toBe(0);
    expect(calendar.createEventCalls).toBe(0);
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toContain("ya pasó");
  });

  it("5: past BOOKED + 'reagendar' never treats the stale appointment as a live reschedule -- reframed as a new booking, RESCHEDULE_REQUESTED never reached", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779990005", "BOOKED");
    const staleAppointment = await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779990005", "wamid.5a", "Reagendar");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKING_PENDING"); // NOT RESCHEDULE_REQUESTED
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(2); // acknowledgment + real new offer
    expect(outbound[0].body).toContain("ya pasó");
    expect(outbound[1].body).toContain("Tengo estos horarios disponibles");
    // The old appointment never transitions to RESCHEDULED -- it was never "the" old appointment
    // of a reschedule, just an untouched stale row.
    const reloadedStale = await repos.appointmentsRepo.findById(staleAppointment.id);
    expect(reloadedStale?.status).toBe("BOOKED");
  });

  it("6: past BOOKED + a general question gets a useful, non-repetitive fallback -- never silence, never the future-appointment copy", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779990006", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779990006", "wamid.6a", "¿Cuáles son los servicios?");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(PAST_BOOKED_GENERIC_INBOUND_MESSAGE);
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
  });

  it("7: score/product/qualification remain intact through the full past-booked recovery (generic reply + new booking start)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779990007", "BOOKED", { score: 74, scoreClass: "B", productInterest: "SAVINGS", productVertical: "PATRIMONIAL" });
    await repos.qualificationAnswersRepo.create({ leadId: lead.id, conversationId: conversation.id, vertical: "PATRIMONIAL", fieldName: "goal", fieldValue: "RETIREMENT", source: "MANUAL" });
    await repos.leadScoresRepo.create({ leadId: lead.id, vertical: "PATRIMONIAL", total: 74, scoreClass: "B", breakdown: {}, rulesVersion: "GMM_QUALIFICATION_V1" });
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779990007", "wamid.7a", "Hola");
    await send(app, "5214779990007", "wamid.7b", "Quiero agendar");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.score).toBe(74);
    expect(finalLead?.scoreClass).toBe("B");
    expect(finalLead?.productInterest).toBe("SAVINGS");
    expect(finalLead?.productVertical).toBe("PATRIMONIAL");
    expect(await repos.qualificationAnswersRepo.listByLeadId(lead.id)).toHaveLength(1);
    expect(await repos.leadScoresRepo.listByLeadId(lead.id)).toHaveLength(1);
  });

  it("8: no Calendar mutation for a past appointment through generic-text turns", async () => {
    const calendar = new CountingCalendarProvider(new FakeCalendarProvider());
    const repos = buildRepos(calendar);
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214779990008", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City", calendarEventId: "evt-stale-008" });

    await send(app, "5214779990008", "wamid.8a", "Hola, tengo una duda");
    await send(app, "5214779990008", "wamid.8b", "Cancelar");

    expect(calendar.createEventCalls).toBe(0);
    expect(calendar.deleteEventCalls).toBe(0);
  });

  it("9: no double future booking -- a lead with a genuinely UPCOMING BOOKED appointment is never offered a competing new one, even with new-booking-intent text", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779990009", "BOOKED");
    const upcoming = await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779990009", "wamid.9a", "Quiero agendar");

    // "Quiero agendar" while BOOKED with a genuinely upcoming appointment isn't reschedule- or
    // cancellation-intent, so it falls through to the standard BOOKED generic fallback -- never
    // starts a second booking round.
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    const appointments = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    expect(appointments).toHaveLength(1);
    expect(appointments[0]?.id).toBe(upcoming.id);
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(BOOKED_GENERIC_INBOUND_MESSAGE);
  });

  it("10: provider_message_id dedupe is preserved for past-booked recovery turns", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779990010", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779990010", "wamid.dup10", "Hola");
    await send(app, "5214779990010", "wamid.dup10", "Hola"); // exact same provider_message_id -- a real Meta webhook redelivery

    const messages = await repos.messagesRepo.listByConversationId(conversation.id);
    expect(messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1);
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
  });

  it("flag-off regression: with WHATSAPP_BOOKING_ENABLED off, a past BOOKED appointment is routed exactly as before this hardening pass (no extra read, no new behavior)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: false, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779990011", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779990011", "wamid.11a", "Hola");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(BOOKED_GENERIC_INBOUND_MESSAGE); // unchanged prior behavior
  });
});
