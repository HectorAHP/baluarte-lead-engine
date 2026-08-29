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
import type { Lead, LeadStatus } from "../src/domain/lead.js";

/**
 * PRE-LAUNCH REGRESSION: a real smoke-test lead in BOOKING_PENDING sent "Cancelar" (and a general
 * question) and got the SAME "responde 1, 2 o 3" slot reminder every time -- ANY inbound text that
 * wasn't a valid slot number or an exact DECLINED_PHRASES match was treated as an invalid
 * selection attempt (see slot-selection-parser.ts's parseSlotSelection, called unconditionally by
 * WhatsAppBookingHandler.handleTurnInner for every BOOKING_PENDING turn). Fixed by:
 *  - isBookingAbandonRequest, checked BEFORE parseSlotSelection: "cancelar"/"ya no"/"salir" now
 *    abandons the pending booking (no appointment exists yet, so this is never an appointment
 *    cancellation) and returns the lead to its TRUE prior qualified tier
 *    (targetStatusForScore(lead.scoreClass)), never a blanket NURTURE_C.
 *  - buildBookingPendingFallbackMessage replaces the old terse reminder for any OTHER
 *    unrecognized text -- still restates the active options, but frames it informatively and
 *    names the abandon escape hatch instead of only ever repeating the same instruction.
 *  - QUALIFIED_A/QUALIFIED_B/NURTURE_C leads can resume booking later via an explicit
 *    new-booking-intent message (isNewBookingRequest), reusing/recreating the offer round exactly
 *    like WhatsAppReactivationHandler.startNewBooking does for CANCELLED leads.
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
    country: "MX", productVertical: "GMM", productInterest: "GMM", status: "NEW", score: 71, scoreClass: "B",
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId,
    qualifiedAt: new Date("2026-08-20T10:00:00.000Z"),
    bookingStartedAt: new Date("2026-08-20T10:05:00.000Z"),
    ...overrides,
  });
  await repos.leadsRepo.update(lead.id, { status, ...overrides });
  const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead: (await repos.leadsRepo.findById(lead.id))!, conversation };
}

/** Seeds one active round of 3 offered_slots for the given lead/conversation -- direct seeding
 * (bypassing the full qualification->offer flow) so each test starts from a precise, isolated
 * BOOKING_PENDING state, matching whatsapp-booked-generic-fallback-e2e.test.ts's own convention.
 * expiresAt is computed from the REAL wall clock (Date.now()), not a fixed reference date: the
 * webhook route always calls `new Date()` for its own `now` (not test-injectable in this E2E
 * harness), so a round seeded with a hardcoded expiresAt could already read as expired by the time
 * the handler checks it. */
async function seedActiveRound(repos: ReturnType<typeof buildRepos>, leadId: string, conversationId: string) {
  const roundId = `round-${leadId}`;
  const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
  return repos.offeredSlotsRepo.createMany([
    { conversationId, leadId, roundId, slotStart: new Date("2030-06-15T15:00:00.000Z"), slotEnd: new Date("2030-06-15T15:30:00.000Z"), position: 1, expiresAt, selected: false },
    { conversationId, leadId, roundId, slotStart: new Date("2030-06-15T15:30:00.000Z"), slotEnd: new Date("2030-06-15T16:00:00.000Z"), position: 2, expiresAt, selected: false },
    { conversationId, leadId, roundId, slotStart: new Date("2030-06-15T16:00:00.000Z"), slotEnd: new Date("2030-06-15T16:30:00.000Z"), position: 3, expiresAt, selected: false },
  ]);
}

async function outboundMessages(repos: ReturnType<typeof buildRepos>, conversationId: string) {
  const messages = await repos.messagesRepo.listByConversationId(conversationId);
  return messages.filter((m) => m.direction === "OUTBOUND");
}

describe("Pre-launch hardening -- BOOKING_PENDING conversational trap", () => {
  it("1: BOOKING_PENDING + '1' -> normal booking, appointment created, lead BOOKED", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778891001", "BOOKING_PENDING");
    await seedActiveRound(repos, lead.id, conversation.id);

    await send(app, "5214778891001", "wamid.g1a", "1");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKED");
    const appointments = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    expect(appointments).toHaveLength(1);
    expect(appointments[0]?.status).toBe("BOOKED");
  });

  it("2: BOOKING_PENDING + 'Cancelar' -> abandons the pending booking, no Calendar call, returns to true qualified tier", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778891002", "BOOKING_PENDING", { scoreClass: "A" });
    await seedActiveRound(repos, lead.id, conversation.id);
    const calendarCreateCallsBefore = 0;

    await send(app, "5214778891002", "wamid.g2a", "Cancelar");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("QUALIFIED_A"); // true prior tier (scoreClass "A"), never a blanket NURTURE_C
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toContain('escribe "agendar"');
    expect(await repos.appointmentsRepo.listAllByLeadId(lead.id)).toEqual([]); // no appointment, no Calendar call possible
  });

  it("3: BOOKING_PENDING + 'cancelar' (lowercase) -> same abandon behavior", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778891003", "BOOKING_PENDING", { scoreClass: "B" });
    await seedActiveRound(repos, lead.id, conversation.id);

    await send(app, "5214778891003", "wamid.g3a", "cancelar");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("QUALIFIED_B");
    expect(await repos.appointmentsRepo.listAllByLeadId(lead.id)).toEqual([]);
  });

  it("4: BOOKING_PENDING + '¿Cuáles son los servicios?' -> no slot reminder, lead stays BOOKING_PENDING", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778891004", "BOOKING_PENDING");
    await seedActiveRound(repos, lead.id, conversation.id);

    await send(app, "5214778891004", "wamid.g4a", "¿Cuáles son los servicios?");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKING_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).not.toContain("Por favor responde");
    expect(outbound[0].body).toContain("Estamos en el proceso de agendar tu cita");
  });

  it("5: BOOKING_PENDING + 'Hola quiero información' -> no slot reminder", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778891005", "BOOKING_PENDING");
    await seedActiveRound(repos, lead.id, conversation.id);

    await send(app, "5214778891005", "wamid.g5a", "Hola quiero información");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).not.toContain("Por favor responde");
  });

  it("6: BOOKING_PENDING + texto basura -> recoverable fallback, no dangerous mutation", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778891006", "BOOKING_PENDING", { score: 71, scoreClass: "B", productInterest: "GMM" });
    await seedActiveRound(repos, lead.id, conversation.id);

    await send(app, "5214778891006", "wamid.g6a", "asdkjfh qlwkejr");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKING_PENDING");
    expect(finalLead?.score).toBe(71);
    expect(finalLead?.scoreClass).toBe("B");
    expect(finalLead?.productInterest).toBe("GMM");
    expect(await repos.appointmentsRepo.listAllByLeadId(lead.id)).toEqual([]);
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
  });

  it("7: after abandoning BOOKING_PENDING, 'agendar' resumes and offers slots again", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778891007", "BOOKING_PENDING", { scoreClass: "A" });
    await seedActiveRound(repos, lead.id, conversation.id);
    await send(app, "5214778891007", "wamid.g7a", "Cancelar");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("QUALIFIED_A");

    await send(app, "5214778891007", "wamid.g7b", "quiero agendar");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKING_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(2); // abandon confirmation + slot offer
    expect(outbound[1].body).toContain("Tengo estas opciones disponibles");
  });

  it("8: score/product/qualification_answers/lead_scores remain intact after abandoning BOOKING_PENDING", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778891008", "BOOKING_PENDING", { score: 81, scoreClass: "A", productInterest: "GMM", productVertical: "GMM" });
    await repos.qualificationAnswersRepo.create({ leadId: lead.id, conversationId: conversation.id, vertical: "GMM", fieldName: "coverage_type", fieldValue: "FAMILY", source: "MANUAL" });
    await repos.leadScoresRepo.create({ leadId: lead.id, vertical: "GMM", total: 81, scoreClass: "A", breakdown: {}, rulesVersion: "GMM_QUALIFICATION_V1" });
    await seedActiveRound(repos, lead.id, conversation.id);

    await send(app, "5214778891008", "wamid.g8a", "ya no");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("QUALIFIED_A");
    expect(finalLead?.score).toBe(81);
    expect(finalLead?.scoreClass).toBe("A");
    expect(finalLead?.productInterest).toBe("GMM");
    expect(finalLead?.productVertical).toBe("GMM");
    expect(await repos.qualificationAnswersRepo.listByLeadId(lead.id)).toHaveLength(1);
    expect(await repos.leadScoresRepo.listByLeadId(lead.id)).toHaveLength(1);
  });

  it("9: no appointment is ever created when cancelling BOOKING_PENDING", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778891009", "BOOKING_PENDING", { scoreClass: "C" });
    await seedActiveRound(repos, lead.id, conversation.id);

    await send(app, "5214778891009", "wamid.g9a", "salir");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("NURTURE_C");
    expect(await repos.appointmentsRepo.listAllByLeadId(lead.id)).toEqual([]);
  });

  it("10: provider_message_id dedupe still works for BOOKING_PENDING abandon turns", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778891010", "BOOKING_PENDING", { scoreClass: "B" });
    await seedActiveRound(repos, lead.id, conversation.id);

    await send(app, "5214778891010", "wamid.g10a", "Cancelar");
    await send(app, "5214778891010", "wamid.g10a", "Cancelar"); // exact same provider_message_id -- a real Meta webhook redelivery

    const messages = await repos.messagesRepo.listByConversationId(conversation.id);
    expect(messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1);
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("QUALIFIED_B");
  });

  it("flag-off regression: with WHATSAPP_BOOKING_ENABLED off, BOOKING_PENDING is never reached by this handler (byte-for-byte prior behavior)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: false });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778891011", "BOOKING_PENDING");
    await seedActiveRound(repos, lead.id, conversation.id);

    await send(app, "5214778891011", "wamid.g11a", "Cancelar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKING_PENDING"); // unchanged
    expect(await outboundMessages(repos, conversation.id)).toHaveLength(0);
  });
});
