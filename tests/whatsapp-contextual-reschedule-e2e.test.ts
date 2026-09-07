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
import { BOOKED_GENERIC_INBOUND_MESSAGE } from "../src/domain/message-templates.js";
import { computeAvailableSlots, isWithinBusinessHours, type AvailabilityRules } from "../src/domain/availability.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";
import type { CalendarProvider, CalendarEventInput, CalendarEventResult } from "../src/application/ports.js";
import type { DatePreference } from "../src/domain/date-preference.js";

/** Same "wrap FakeCalendarProvider for free/busy + createEvent, but real business rules for
 * getAvailableSlots/isWithinBusinessHours" pattern already established in Fase 7F/7H/7I's tests
 * (see tests/booking.test.ts's makeRulesEnforcingCalendar). Needed specifically for the Sunday
 * scenario below -- plain FakeCalendarProvider has no real business-hours concept (see its own
 * doc comment) and would happily generate Sunday candidates. */
const REAL_WEEKLY_RULES: AvailabilityRules = {
  timezone: "America/Mexico_City", workdayStart: "09:00", workdayEnd: "19:00",
  saturdayWorkdayEnd: "14:00", sundayBookingEnabled: false, minNoticeHours: 2, maxDaysAhead: 14, maxSlots: 3,
};
function makeRulesEnforcingCalendar(): CalendarProvider {
  const inner = new FakeCalendarProvider();
  return {
    async getAvailableSlots(from: Date, to: Date, durationMinutes: number, datePreference?: DatePreference) {
      return computeAvailableSlots(from, to, durationMinutes, [], REAL_WEEKLY_RULES, from, datePreference);
    },
    isSlotAvailable: (...args) => inner.isSlotAvailable(...args),
    isWithinBusinessHours: (start: Date, end: Date) => isWithinBusinessHours(start, end, REAL_WEEKLY_RULES),
    createEvent: (input: CalendarEventInput): Promise<CalendarEventResult> => inner.createEvent(input),
    deleteEvent: (eventId: string) => inner.deleteEvent(eventId),
  };
}

/**
 * Fase 7I.2 -- CAUSE_CONTEXTUAL_RESCHEDULE_NOT_DETECTED fix, exercised through the REAL webhook
 * router (whatsapp-inbound-service.ts) via buildTestApp + real HTTP injection -- NOT a
 * direct-handler-construction test, since the fix lives entirely in the router's dispatch order,
 * never inside WhatsAppRescheduleHandler itself. Mirrors the exact harness already proven correct
 * in whatsapp-booked-generic-fallback-e2e.test.ts.
 *
 * Appointment dates are all genuinely in the future relative to the real wall clock (this
 * environment's real "now" is 2026-09-07) -- deliberately never past-dated, so
 * WhatsAppPastBookedRecoveryHandler's isUpcomingBooked guard never intercepts these turns before
 * reaching the routing this file actually tests.
 */
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
              contacts: [{ profile: { name: overrides.name ?? "Ana" }, wa_id: overrides.from ?? "5214779990001" }],
              messages: [{ from: overrides.from ?? "5214779990001", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
            },
          },
        ],
      },
    ],
  });
}

function buildRepos() {
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
    calendar: new FakeCalendarProvider(),
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
    country: "MX", productVertical: "PATRIMONIAL", status: "NEW", score: 78, scoreClass: "A",
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId,
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

const FUTURE_APPOINTMENT_START = new Date("2026-09-12T15:00:00.000Z"); // Saturday, genuinely upcoming
const FUTURE_APPOINTMENT_END = new Date("2026-09-12T15:30:00.000Z");

async function makeBookedLeadWithFutureAppointment(repos: ReturnType<typeof buildRepos>, whatsappUserId: string) {
  const { lead, conversation } = await createLeadAtStatus(repos, whatsappUserId, "BOOKED", {
    bookedAt: new Date("2026-09-06T21:59:12.000Z"), meetingAt: FUTURE_APPOINTMENT_START,
  });
  const appointment = await repos.appointmentsRepo.create({
    leadId: lead.id, status: "BOOKED", startsAt: FUTURE_APPOINTMENT_START, endsAt: FUTURE_APPOINTMENT_END,
    timezone: "America/Mexico_City", calendarEventId: "evt-real",
  });
  return { lead, conversation, appointment };
}

describe("Fase 7I.2 -- contextual reschedule: positives (real WhatsApp routing)", () => {
  const positiveCases: Array<{ id: string; text: string }> = [
    { id: "5214779990101", text: "Mejor el domingo" },
    { id: "5214779990102", text: "El sábado mejor" },
    { id: "5214779990103", text: "Prefiero el lunes" },
    { id: "5214779990104", text: "¿Puede ser el martes?" },
    { id: "5214779990105", text: "Por la tarde mejor" },
  ];

  for (const { id, text } of positiveCases) {
    it(`item: BOOKED + "${text}" -> contextual reschedule (RESCHEDULE_REQUESTED, appointment untouched, never the generic fallback)`, async () => {
      const repos = buildRepos();
      const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
      const { lead, appointment, conversation } = await makeBookedLeadWithFutureAppointment(repos, id);

      const res = await send(app, id, "wamid.1", text);

      expect(res.statusCode).toBe(200);
      expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
      const reread = await repos.appointmentsRepo.findById(appointment.id);
      expect(reread?.status).toBe("BOOKED"); // untouched -- item 10
      expect(reread?.startsAt.getTime()).toBe(appointment.startsAt.getTime());
      const outbound = await outboundMessages(repos, conversation.id);
      expect(outbound.every((m) => m.body !== BOOKED_GENERIC_INBOUND_MESSAGE)).toBe(true); // never the generic fallback
      expect(outbound.some((m) => m.body?.includes("puedo ayudarte a cambiar tu cita"))).toBe(true);
    });
  }
});

describe("Fase 7I.2 -- contextual reschedule: negatives (DatePreference alone stays generic)", () => {
  it('item 6: BOOKED + "El 12 de septiembre" -> generic booked response, NO reschedule', async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await makeBookedLeadWithFutureAppointment(repos, "5214779990201");

    await send(app, "5214779990201", "wamid.1", "El 12 de septiembre");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED"); // never RESCHEDULE_REQUESTED
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(BOOKED_GENERIC_INBOUND_MESSAGE);
  });

  it('item 7: BOOKED + "¿Mi cita es el sábado?" -> generic/info path, NO reschedule', async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await makeBookedLeadWithFutureAppointment(repos, "5214779990202");

    await send(app, "5214779990202", "wamid.1", "¿Mi cita es el sábado?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(BOOKED_GENERIC_INBOUND_MESSAGE);
  });
});

describe("Fase 7I.2 -- explicit intents unchanged", () => {
  it('item 8: explicit "reagendar" behavior unchanged', async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await makeBookedLeadWithFutureAppointment(repos, "5214779990301");

    await send(app, "5214779990301", "wamid.1", "Quiero reagendar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.some((m) => m.body?.includes("puedo ayudarte a cambiar tu cita"))).toBe(true);
  });

  it('item 9: explicit "cancelar" behavior unchanged', async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await makeBookedLeadWithFutureAppointment(repos, "5214779990302");

    await send(app, "5214779990302", "wamid.1", "Quiero cancelar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.some((m) => m.body?.includes("1. Sí, cancelar"))).toBe(true);
  });
});

describe("Fase 7I.2 -- item 11/13/12: real-case reproduction (lead eb95060d shape)", () => {
  it('"Mejor el domingo" against a real Saturday appointment: contextual reschedule detected, Sunday closed -> explanatory fallback, appointment preserved, no Calendar mutation, no HUMAN_HANDOFF', async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, calendar: makeRulesEnforcingCalendar(), whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, appointment, conversation } = await makeBookedLeadWithFutureAppointment(repos, "5214779990401");

    const res = await send(app, "5214779990401", "wamid.1", "Mejor el domingo");

    expect(res.statusCode).toBe(200);
    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("RESCHEDULE_REQUESTED"); // contextual reschedule detected
    expect(finalLead?.status).not.toBe("HUMAN_HANDOFF"); // item 12

    const reread = await repos.appointmentsRepo.findById(appointment.id);
    expect(reread?.status).toBe("BOOKED"); // the Saturday appointment is untouched
    expect(reread?.calendarEventId).toBe("evt-real"); // never mutated -- item 13 (no Calendar write before confirmation)

    const outbound = await outboundMessages(repos, conversation.id);
    const lastMessage = outbound[outbound.length - 1].body ?? "";
    expect(lastMessage).toContain("no tengo horarios disponibles"); // Sunday-unavailable explanation (item 5/7 of Fase 7I's own contract)
    expect(lastMessage).not.toContain("Domingo"); // never offers a Sunday slot as if it were valid

    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(history.some((e) => e.toStatus === "HUMAN_HANDOFF")).toBe(false);
  });
});

describe("Fase 7I.2 -- regression: flag-off behavior unchanged", () => {
  it("with WHATSAPP_RESCHEDULE_ENABLED off, a contextual-reschedule-shaped message stays the byte-identical historical fallback (silence)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: false, whatsappCancellationEnabled: true });
    const { lead, conversation } = await makeBookedLeadWithFutureAppointment(repos, "5214779990501");

    await send(app, "5214779990501", "wamid.1", "Mejor el domingo");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED"); // never RESCHEDULE_REQUESTED
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(0); // rescheduleHandler absent -> the new gate is never even evaluated, byte-identical to before
  });
});
