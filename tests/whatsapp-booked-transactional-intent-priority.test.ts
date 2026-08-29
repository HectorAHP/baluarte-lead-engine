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
import { BOOKED_GENERIC_INBOUND_MESSAGE, CANCELLED_GENERIC_INBOUND_MESSAGE } from "../src/domain/message-templates.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";

/**
 * PRE-LAUNCH REGRESSION: a real smoke-test lead sent the bare word "Reagendar" (no "quiero"
 * prefix, no "cita" suffix) while BOOKED and got the generic fallback instead of the real
 * reschedule flow, twice. Root cause: reschedule-intent-detection.ts's RESCHEDULE_PATTERNS had no
 * standalone-word pattern -- every pattern required an extra word ("quiero" before, or "cita"
 * after) that a bare "Reagendar" doesn't carry. The routing ORDER in whatsapp-inbound-service.ts
 * was already correct (reschedule-intent check runs before the generic-fallback branch); this was
 * purely a detection-vocabulary gap, not a routing-order or case-sensitivity bug. Fixed via a
 * `\breagendar\b` pattern (see reschedule-intent-detection.ts) -- the SAME function used by both
 * the BOOKED routing check here and the CANCELLED-lead reframing check in
 * whatsapp-reactivation-handler.ts, so this is the single source of truth for reschedule intent,
 * never duplicated. cancellation-intent-detection.ts got the identical fix for the identical
 * reason (a bare "Cancelar" had the same gap).
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
              contacts: [{ profile: { name: overrides.name ?? "Ana" }, wa_id: overrides.from ?? "5214778880001" }],
              messages: [{ from: overrides.from ?? "5214778880001", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
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
    country: "MX", productVertical: "GMM", productInterest: "GMM", status: "NEW", score: 81,
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId,
    bookedAt: new Date("2026-08-20T10:00:00.000Z"),
    meetingAt: new Date("2030-06-15T15:30:00.000Z"),
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

describe("Pre-launch hardening -- BOOKED transactional intents must win over the generic fallback, bare-word phrasing included", () => {
  it("A: BOOKED + 'Reagendar' -> reschedule flow, never the generic fallback", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890401", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890401", "wamid.a1", "Reagendar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== BOOKED_GENERIC_INBOUND_MESSAGE)).toBe(true);
  });

  it("B: BOOKED + 'reagendar' (lowercase) -> reschedule flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890402", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890402", "wamid.b1", "reagendar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== BOOKED_GENERIC_INBOUND_MESSAGE)).toBe(true);
  });

  it("C: BOOKED + 'REAGENDAR' (uppercase) -> reschedule flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890403", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890403", "wamid.c1", "REAGENDAR");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== BOOKED_GENERIC_INBOUND_MESSAGE)).toBe(true);
  });

  it("D: BOOKED + '  Reagendar  ' (surrounding whitespace) -> reschedule flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890404", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890404", "wamid.d1", "  Reagendar  ");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== BOOKED_GENERIC_INBOUND_MESSAGE)).toBe(true);
  });

  it("E: BOOKED + 'Quiero reagendar mi cita' -> reschedule flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890405", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890405", "wamid.e1", "Quiero reagendar mi cita");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== BOOKED_GENERIC_INBOUND_MESSAGE)).toBe(true);
  });

  it("F: BOOKED + 'Cancelar' (bare word) -> cancellation flow, never the generic fallback", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890406", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890406", "wamid.f1", "Cancelar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== BOOKED_GENERIC_INBOUND_MESSAGE)).toBe(true);
  });

  it("G: BOOKED + 'Hola tengo una duda' -> generic fallback exactly once, lead/appointment intact", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890407", "BOOKED");
    const appointment = await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890407", "wamid.g1", "Hola tengo una duda");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(BOOKED_GENERIC_INBOUND_MESSAGE);
    const finalAppointment = await repos.appointmentsRepo.findById(appointment.id);
    expect(finalAppointment?.status).toBe("BOOKED");
  });

  it("H: none of the transactional-intent inbounds above ever produced BOOKED_GENERIC_INBOUND_MESSAGE (cross-check across A-F in one pass)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const phrasesAndFrom: Array<[string, string]> = [
      ["Reagendar", "5214778890501"],
      ["reagendar", "5214778890502"],
      ["REAGENDAR", "5214778890503"],
      ["  Reagendar  ", "5214778890504"],
      ["Quiero reagendar mi cita", "5214778890505"],
      ["Cancelar", "5214778890506"],
    ];
    // InMemoryAppointmentRepository.create() checks time-slot overlap GLOBALLY (mirrors the real
    // advisor-calendar exclusion constraint, not scoped per lead) -- each iteration below uses a
    // different day so six different leads' appointments never collide with each other.
    let dayOffset = 0;
    for (const [text, from] of phrasesAndFrom) {
      const { lead, conversation } = await createLeadAtStatus(repos, from, "BOOKED");
      const day = 28 + dayOffset++;
      await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date(`2026-09-${String(day).padStart(2, "0")}T15:30:00.000Z`), endsAt: new Date(`2026-09-${String(day).padStart(2, "0")}T16:00:00.000Z`), timezone: "America/Mexico_City" });
      await send(app, from, `wamid.h.${from}`, text);
      const outbound = await outboundMessages(repos, conversation.id);
      expect(outbound.some((m) => m.body === BOOKED_GENERIC_INBOUND_MESSAGE)).toBe(false);
    }
  });

  it("item 8: CANCELLED + 'Reagendar' (bare word) -> reframed as new-booking intent (BOOKING_PENDING), never the reschedule handler, never the generic CANCELLED fallback", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890601", "CANCELLED");

    await send(app, "5214778890601", "wamid.i1", "Reagendar");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    // BOOKING_PENDING (new-booking reframing), never RESCHEDULE_REQUESTED (that would mean the
    // reschedule handler ran, which requires an active appointment this CANCELLED lead doesn't
    // have).
    expect(finalLead?.status).toBe("BOOKING_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.some((m) => m.body === CANCELLED_GENERIC_INBOUND_MESSAGE)).toBe(false);
    // No appointment was ever restored/reused for this lead.
    expect(await repos.appointmentsRepo.listAllByLeadId(lead.id)).toEqual([]);
  });
});
