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
import { BOOKED_GENERIC_INBOUND_MESSAGE, UNKNOWN_INTENT_HANDOFF_MESSAGE } from "../src/domain/message-templates.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";

/**
 * Fase 7J.1 -- extends the Fase 7J UNKNOWN_INTENT_HANDOFF rule (see
 * docs/security/FASE7J-UNKNOWN-INTENT-HANDOFF.md Sec 10, and its own doc comment inside
 * whatsapp-inbound-service.ts's BOOKED-generic-fallback branch) from BOOKING_PENDING to BOOKED: a
 * message that is genuinely unrelated to the active appointment now escalates to HUMAN_HANDOFF
 * instead of hiding behind the generic "ya tienes una cita" reply forever. Covers the phase's own
 * "6. TESTS BOOKED" list, items 1-10, in order.
 */

const FUTURE_STARTS_AT = new Date("2030-06-15T15:30:00.000Z");
const FUTURE_ENDS_AT = new Date("2030-06-15T16:00:00.000Z");

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

async function createBookedLead(repos: ReturnType<typeof buildRepos>, whatsappUserId: string, overrides: Partial<Lead> = {}) {
  const lead = await repos.leadsRepo.create({
    country: "MX", productVertical: "GMM", productInterest: "GMM", status: "NEW", score: 81,
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId,
    bookedAt: new Date("2026-08-20T10:00:00.000Z"), meetingAt: FUTURE_STARTS_AT,
    ...overrides,
  });
  await repos.leadsRepo.update(lead.id, { status: "BOOKED" as LeadStatus, ...overrides });
  const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  await repos.appointmentsRepo.create({
    leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT, timezone: "America/Mexico_City",
  });
  return { lead: (await repos.leadsRepo.findById(lead.id))!, conversation };
}

async function outboundMessages(repos: ReturnType<typeof buildRepos>, conversationId: string) {
  const messages = await repos.messagesRepo.listByConversationId(conversationId);
  return messages.filter((m) => m.direction === "OUTBOUND");
}

describe("Fase 7J.1 -- BOOKED unknown-intent handoff", () => {
  it("1: BOOKED + unsupported real question ('¿también me pueden ayudar con el seguro de mi empresa?') -> HUMAN_HANDOFF", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createBookedLead(repos, "5214779991001");

    await send(app, "5214779991001", "wamid.1a", "¿también me pueden ayudar con el seguro de mi empresa?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(UNKNOWN_INTENT_HANDOFF_MESSAGE);
    // The appointment itself is never touched by an escalation.
    const appointments = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    expect(appointments).toHaveLength(1);
    expect(appointments[0]?.status).toBe("BOOKED");
  });

  it("2: BOOKED + gibberish ('asdkjfh qweoiu') -> HUMAN_HANDOFF", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createBookedLead(repos, "5214779991002");

    await send(app, "5214779991002", "wamid.2a", "asdkjfh qweoiu");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(UNKNOWN_INTENT_HANDOFF_MESSAGE);
  });

  it("3: BOOKED + 'gracias' -> no handoff, stays BOOKED with the generic reply", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createBookedLead(repos, "5214779991003");

    await send(app, "5214779991003", "wamid.3a", "gracias");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(BOOKED_GENERIC_INBOUND_MESSAGE);
  });

  it("4: BOOKED + 'perfecto' -> no handoff, stays BOOKED with the generic reply", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createBookedLead(repos, "5214779991004");

    await send(app, "5214779991004", "wamid.4a", "perfecto");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(BOOKED_GENERIC_INBOUND_MESSAGE);
  });

  it("5: BOOKED + 'cancelar' -> cancellation flow unchanged, never treated as unknown intent", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createBookedLead(repos, "5214779991005");

    await send(app, "5214779991005", "wamid.5a", "cancelar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== UNKNOWN_INTENT_HANDOFF_MESSAGE)).toBe(true);
  });

  it("6: BOOKED + 'reagendar' -> reschedule flow unchanged, never treated as unknown intent", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createBookedLead(repos, "5214779991006");

    await send(app, "5214779991006", "wamid.6a", "reagendar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== UNKNOWN_INTENT_HANDOFF_MESSAGE)).toBe(true);
  });

  it("7: BOOKED + 'Mejor el domingo' -> contextual reschedule unchanged, never treated as unknown intent", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createBookedLead(repos, "5214779991007");

    await send(app, "5214779991007", "wamid.7a", "Mejor el domingo");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== UNKNOWN_INTENT_HANDOFF_MESSAGE)).toBe(true);
  });

  it("8: BOOKED + a bare date mention about the existing appointment ('¿Mi cita es el sábado?') -> generic reply, no accidental handoff", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createBookedLead(repos, "5214779991008");

    await send(app, "5214779991008", "wamid.8a", "¿Mi cita es el sábado?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED"); // never RESCHEDULE_REQUESTED, never HUMAN_HANDOFF
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(BOOKED_GENERIC_INBOUND_MESSAGE);
  });

  it("9: duplicate webhook delivery (same provider_message_id) for an unknown-intent message -> exactly one handoff, never two", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createBookedLead(repos, "5214779991009");

    await send(app, "5214779991009", "wamid.9a", "¿qué pasa si tengo dos patrones?");
    await send(app, "5214779991009", "wamid.9a", "¿qué pasa si tengo dos patrones?"); // exact same provider_message_id -- a real Meta webhook redelivery

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    const messages = await repos.messagesRepo.listByConversationId(conversation.id);
    expect(messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1); // deduped correctly
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1); // never a duplicate escalation/reply
  });

  it("10: after UNKNOWN_INTENT_HANDOFF, a further message stays silent -- terminal suppression, never a repeated escalation or a second message", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createBookedLead(repos, "5214779991010");

    await send(app, "5214779991010", "wamid.10a", "quiero revisar también gastos médicos");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");

    await send(app, "5214779991010", "wamid.10b", "hola, siguen ahi?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF"); // unchanged
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1); // only the original escalation message -- never a second one
  });

  it("flag-off regression: with WHATSAPP_RESCHEDULE_ENABLED or WHATSAPP_CANCELLATION_ENABLED off, an unsupported question stays silent -- byte-for-byte the historical behavior, never escalated by this branch", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: false, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createBookedLead(repos, "5214779991011");

    await send(app, "5214779991011", "wamid.11a", "¿también me pueden ayudar con el seguro de mi empresa?");

    // rescheduleHandler is absent, so the BOOKED-generic-fallback branch (and its new
    // classification) is never taken at all -- same "flag off -> unchanged" guarantee as before
    // this phase. The turn instead reaches cancellationHandler's own BOOKED dispatch (still
    // present), which silently no-ops internally for non-cancellation text (a pre-existing,
    // documented residual gap this phase deliberately does not touch -- see Sec 3 of the doc and
    // whatsapp-cancellation-handler.ts's own handleIntentTurn guard).
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(0);
  });
});
