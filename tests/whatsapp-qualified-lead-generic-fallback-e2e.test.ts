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
import { QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE } from "../src/domain/message-templates.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";

/**
 * PRE-LAUNCH FIX -- silence for already-qualified leads (confirmed against real production logs:
 * leadStatusBefore="QUALIFIED_A", branch="qualified-or-nurture-booking-intent-check",
 * willReply=false, no outbound attempt, HTTP 200).
 *
 * Root cause: for QUALIFIED_A/QUALIFIED_B/NURTURE_C, whatsapp-inbound-service.ts dispatched
 * UNCONDITIONALLY to WhatsAppBookingHandler.handleTurn, whose own internal contract is "only ever
 * acts on genuine new-booking intent (isNewBookingRequest), silently no-ops otherwise" -- correct
 * for THAT handler's own narrow concern, but nothing downstream ever got a chance to reply once
 * its routing condition matched, so a normal message like "Hola, quiero información" produced zero
 * automated reply.
 *
 * Fix: WhatsAppBookingHandler.handleTurn now returns whether it actually acted (see its own doc
 * comment) -- the handler itself is NOT turned into a generic conversational handler, it still
 * only ever knows about booking. When it reports it did nothing, whatsapp-inbound-service.ts sends
 * a SEPARATE, generic fallback (QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE) -- exactly one reply
 * either way, never both, never silence.
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

describe("Pre-launch fix -- qualified/nurture lead generic conversational fallback", () => {
  it("1: QUALIFIED_A + 'Hola, quiero información' -> no booking intent, exactly one reply with a useful option, provider called exactly once", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779991001", "QUALIFIED_A", { scoreClass: "A" });

    await send(app, "5214779991001", "wamid.q1a", "Hola, quiero información");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("QUALIFIED_A"); // no state change
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1); // exactly one reply == provider.sendText called exactly once
    expect(outbound[0].body).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
    expect(outbound[0].body).toContain("3. Agendar una asesoría"); // a useful, actionable option
    expect(await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date())).toEqual([]); // no offer started
  });

  it("2: QUALIFIED_B + 'Tengo una duda' -> fallback responds", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214779991002", "QUALIFIED_B", { scoreClass: "B" });

    await send(app, "5214779991002", "wamid.q2a", "Tengo una duda");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
  });

  it("3: NURTURE_C + 'Quiero saber más' -> fallback responds", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214779991003", "NURTURE_C", { scoreClass: "C" });

    await send(app, "5214779991003", "wamid.q3a", "Quiero saber más");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
  });

  it("4: QUALIFIED_A + 'Quiero agendar una asesoría' -> bookingHandler keeps existing behavior, no fallback, no double reply", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779991004", "QUALIFIED_A", { scoreClass: "A" });

    await send(app, "5214779991004", "wamid.q4a", "Quiero agendar una asesoría");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKING_PENDING"); // real booking flow started
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1); // exactly one reply -- never the fallback ADDITIONALLY
    expect(outbound[0].body).toContain("Tengo estos horarios disponibles"); // the real slot offer, not the fallback
    expect(outbound[0].body).not.toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
  });

  it("5: a duplicate provider_message_id never re-replies -- existing dedup is preserved", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214779991005", "QUALIFIED_A", { scoreClass: "A" });

    await send(app, "5214779991005", "wamid.dup5", "Hola, quiero información");
    await send(app, "5214779991005", "wamid.dup5", "Hola, quiero información"); // exact same provider_message_id

    const messages = await repos.messagesRepo.listByConversationId(conversation.id);
    expect(messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1);
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
  });

  it("6: the fallback is persisted as a real OUTBOUND message row", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779991006", "QUALIFIED_A", { scoreClass: "A" });

    await send(app, "5214779991006", "wamid.q6a", "Me puedes ayudar");

    const messages = await repos.messagesRepo.listByConversationId(conversation.id);
    const outbound = messages.filter((m) => m.direction === "OUTBOUND");
    expect(outbound).toHaveLength(1);
    expect(outbound[0].leadId).toBe(lead.id);
    expect(outbound[0].conversationId).toBe(conversation.id);
    expect(outbound[0].channel).toBe("WHATSAPP");
    expect(outbound[0].body).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
    expect(outbound[0].providerMessageId).toBeTruthy();
  });

  it("flag-off fix: with WHATSAPP_BOOKING_ENABLED off, a QUALIFIED_A lead's generic text still gets the fallback reply -- no longer silent", async () => {
    // Production bug (found via a real fiscal-context-linked QUALIFIED_A lead's WhatsApp
    // follow-up going completely unanswered): the QUALIFIED_A/QUALIFIED_B/NURTURE_C branch
    // used to be nested entirely inside `deps.bookingHandler && (...)`, so with booking
    // disabled (bookingHandler absent -- this project's real deployed configuration) the
    // fallback THIS test file exists to prove ("no silence for a qualified lead's valid free
    // text") was itself unreachable. Fixed: status alone decides whether this lead owes a
    // reply; bookingHandler's presence only decides HOW it's produced. Booking itself is never
    // activated by this -- whatsappBookingEnabled stays false throughout this test.
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: false });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779991007", "QUALIFIED_A", { scoreClass: "A" });

    await send(app, "5214779991007", "wamid.q7a", "Hola, quiero información");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("QUALIFIED_A"); // no state change -- still no booking activated
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
  });
});
