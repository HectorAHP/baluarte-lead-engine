import { randomUUID, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryAppointmentRepository, InMemoryLeadScoreRepository, InMemoryQualificationAnswerRepository,
  InMemoryBookingAttemptRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository, InMemoryAppointmentCancellationRepository,
  InMemoryAppointmentRescheduleRepository, InMemoryFiscalLeadScoreRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import type { CalendarProvider } from "../src/application/ports.js";
import { QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE } from "../src/domain/message-templates.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";
import type { OfferedSlot } from "../src/domain/offered-slot.js";

/**
 * Fase 6E.3.1 -- scopes MAX_OFFER_ROUNDS to the CURRENT booking episode instead of counting every
 * round ever offered in a conversation, cumulatively, forever.
 *
 * REPRODUCED FIRST (item 1 of the task), confirmed BEFORE any logic change: 3 historical exhausted
 * rounds + a past appointment + "Agendar" (round 1 of a new episode, via skipRoundCap, worked
 * correctly) + "otros horarios" (round 2 of the SAME new episode) landed on HUMAN_HANDOFF, because
 * WhatsAppBookingHandler's replaceOffer() call has no episode scoping at all and counted all 4
 * rounds (3 historical + 1 new) against MAX_OFFER_ROUNDS=3. See the Fase 6E.3.1 report for the
 * exact pre-fix output this test captured.
 *
 * BOOKING EPISODE definition (see SlotOfferingService.episodeScopedSince's doc comment for the
 * full trace): begins at the most recent lead_status_history row with toStatus === "BOOKING_PENDING"
 * (written exactly once per genuine transition, by recordLeadStatusTransition -- Phase 4A,
 * pre-existing, no migration needed); ends whenever the lead next leaves BOOKING_PENDING.
 */

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
          contacts: [{ profile: { name: overrides.name ?? "Juan" }, wa_id: overrides.from ?? "5214779950001" }],
          messages: [{ from: overrides.from ?? "5214779950001", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
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
    fiscalLeadScoresRepo: new InMemoryFiscalLeadScoreRepository(),
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
    country: "MX", productVertical: "PATRIMONIAL", status: "NEW", score: 74, scoreClass: "B",
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId, firstName: "Juan",
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
/**
 * Seeds N DISTINCT, EXPIRED, plain-booking-mode rounds -- simulates a prior, already-concluded
 * episode's history without needing to run real booking turns first.
 *
 * NOTE: InMemoryOfferedSlotRepository.createMany always stamps `createdAt` with a fresh
 * `new Date()` at insert time (never a caller-supplied value -- `past` below only affects the
 * business fields slotStart/slotEnd/expiresAt, matching production's real repository contract).
 * SlotOfferingService.episodeScopedSince (Fase 6E.3.1, hardened Fase 6E.4) scopes the round cap
 * using a 2-second safety margin against real-request timestamp skew -- so these "historical"
 * rows must genuinely be created MORE than 2 seconds before the new episode starts, or they'd be
 * (correctly, by design) still counted as belonging to it. The explicit wait below is what makes
 * that true, mirroring the real-world gap (minutes to days) a genuinely concluded prior episode
 * would always have -- never a workaround, an honest representation of it.
 */
async function seedHistoricalRounds(repos: ReturnType<typeof buildRepos>, conversationId: string, leadId: string, count: number) {
  const past = new Date(Date.now() - 60 * 60 * 1000);
  for (let round = 0; round < count; round++) {
    const roundId = randomUUID();
    const rows: Array<Omit<OfferedSlot, "id" | "createdAt">> = [1, 2, 3].map((position) => ({
      conversationId, leadId, roundId, slotStart: past, slotEnd: past, position, expiresAt: past, selected: false,
    }));
    await repos.offeredSlotsRepo.createMany(rows);
  }
  await new Promise((resolve) => setTimeout(resolve, 2200)); // > episodeScopedSince's 2000ms margin
}
const PAST_STARTS_AT = new Date("2020-01-15T15:00:00.000Z");
const PAST_ENDS_AT = new Date("2020-01-15T15:30:00.000Z");

describe("Fase 6E.3.1 -- scope booking round cap to current episode", () => {
  it("REPRO (now fixed): 3 historical exhausted rounds + past appointment + 'Agendar' (round 1, skipRoundCap) + 'otros horarios' (round 2) succeeds, no HUMAN_HANDOFF", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779950001", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await seedHistoricalRounds(repos, conversation.id, lead.id, 3);

    await send(app, "5214779950001", "wamid.r1", "Agendar");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKING_PENDING");

    await send(app, "5214779950001", "wamid.r2", "otros horarios");

    const after = await repos.leadsRepo.findById(lead.id);
    expect(after?.status).toBe("BOOKING_PENDING"); // NOT HUMAN_HANDOFF -- this was the exact residual bug
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[1]!.body).toContain("Perfecto");
    expect(outbound[1]!.body).not.toContain("orientación adecuada");
  });

  it("A. episode start after past appointment: 3 historical rounds do not block round 1 of the new episode", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779950002", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await seedHistoricalRounds(repos, conversation.id, lead.id, 3);

    await send(app, "5214779950002", "wamid.a1", "Agendar");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0]!.body).toContain("Tengo estos horarios disponibles");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKING_PENDING");
  });

  it("B. same episode, round 2: 'otros horarios' succeeds", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779950003", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await seedHistoricalRounds(repos, conversation.id, lead.id, 3);
    await send(app, "5214779950003", "wamid.b1", "Agendar");

    await send(app, "5214779950003", "wamid.b2", "otros horarios");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKING_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[1]!.body).toContain("horarios");
  });

  it("C. same episode, round 3: 'ninguno' succeeds", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779950004", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await seedHistoricalRounds(repos, conversation.id, lead.id, 3);
    await send(app, "5214779950004", "wamid.c1", "Agendar");
    await send(app, "5214779950004", "wamid.c2", "otros horarios");

    await send(app, "5214779950004", "wamid.c3", "ninguno");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKING_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[2]!.body).toContain("horarios");
  });

  it("D. same episode, round 4: MAX_ROUNDS_REACHED / handoff, correctly scoped to THIS episode's own 3 rounds", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779950005", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await seedHistoricalRounds(repos, conversation.id, lead.id, 3);
    await send(app, "5214779950005", "wamid.d1", "Agendar"); // episode round 1
    await send(app, "5214779950005", "wamid.d2", "otros horarios"); // episode round 2
    await send(app, "5214779950005", "wamid.d3", "ninguno"); // episode round 3

    await send(app, "5214779950005", "wamid.d4", "prefiero otro"); // episode round 4 -- should hit the cap

    const after = await repos.leadsRepo.findById(lead.id);
    expect(after?.status).toBe("HUMAN_HANDOFF"); // the cap DOES still protect within-episode
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[3]!.body).toContain("orientación adecuada");
  });

  it("E. 10 historical rounds from previous episodes never affect the new episode's own count", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779950006", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await seedHistoricalRounds(repos, conversation.id, lead.id, 10);

    await send(app, "5214779950006", "wamid.e1", "Agendar");
    await send(app, "5214779950006", "wamid.e2", "otros horarios");
    await send(app, "5214779950006", "wamid.e3", "ninguno");

    // All 3 rounds of the new episode succeeded despite 10 unrelated historical rounds.
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKING_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(3);
    expect(outbound.every((m) => !m.body?.includes("orientación adecuada"))).toBe(true);
  });

  it("F. a genuine ActiveOfferInconsistentError still escalates to legitimate HUMAN_HANDOFF, unaffected by episode scoping", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779950007", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    const future = new Date(Date.now() + 10 * 60 * 1000);
    for (let i = 0; i < 2; i++) {
      const roundId = randomUUID();
      await repos.offeredSlotsRepo.createMany([1, 2, 3].map((position) => ({
        conversationId: conversation.id, leadId: lead.id, roundId,
        slotStart: future, slotEnd: future, position, expiresAt: future, selected: false,
      })));
    }

    await send(app, "5214779950007", "wamid.f1", "Agendar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
  });

  it("G. a duplicate webhook (same provider_message_id) does not increment the round counter", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779950008", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await seedHistoricalRounds(repos, conversation.id, lead.id, 3);

    await send(app, "5214779950008", "wamid.dup", "Agendar");
    await send(app, "5214779950008", "wamid.dup", "Agendar"); // exact redelivery

    const roundIds = new Set((await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date())).map((s) => s.roundId));
    expect(roundIds.size).toBe(1); // still exactly one round for the new episode
  });

  it("H. slot selection remains visible to WhatsAppBookingHandler -- never repeats the reschedule_context_id mistake", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779950009", "BOOKED");
    const stale = await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await seedHistoricalRounds(repos, conversation.id, lead.id, 3);
    await send(app, "5214779950009", "wamid.h1", "Agendar");

    await send(app, "5214779950009", "wamid.h2", "1"); // select the first offered slot

    const all = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    const newAppt = all.find((a) => a.id !== stale.id);
    expect(newAppt).toBeDefined();
    expect(newAppt?.status).toBe("BOOKED");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
  });

  it("item 8: a stale PPR_FOLLOWUP does not indefinitely capture an unrelated later 'sí' after a genuine topic change", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779950010", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779950010", "wamid.i1", "¿Qué es un PPR?"); // sets PPR_FOLLOWUP
    let outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0]!.metadata).toEqual({ expectedIntent: "PPR_FOLLOWUP" });

    await send(app, "5214779950010", "wamid.i2", "mejor cuéntame de otra cosa, algo distinto"); // unrelated, no keyword match -> clears the pending followup by not re-attaching its marker
    outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[1]!.metadata).not.toEqual({ expectedIntent: "PPR_FOLLOWUP" });

    await send(app, "5214779950010", "wamid.i3", "sí"); // must NOT resolve against the stale PPR_FOLLOWUP

    outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[2]!.body).not.toBe("Claro. ¿Quieres que empecemos por el beneficio fiscal o por cómo se construye el ahorro para el retiro?");
    expect(outbound[2]!.body).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE); // falls to the generic affirmative-with-no-context handling instead
  });
});
