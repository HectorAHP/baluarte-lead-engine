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
import {
  PAST_BOOKED_GENERIC_INBOUND_MESSAGE, QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE, UNKNOWN_INTENT_HANDOFF_MESSAGE,
  buildQualifiedLeadAskQuestionMessage, buildQualifiedLeadOptionsMessage,
} from "../src/domain/message-templates.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";

/**
 * Fase 7J.3 -- fixes CAUSE_PAST_BOOKED_HANDLER_OVERBROAD / CAUSE_UNKNOWN_INTENT_ROUTING_UNREACHABLE
 * / CAUSE_MENU_SELECTION_STATE_MISSING / CAUSE_NUMERIC_SELECTION_UNHANDLED (see
 * docs/security/FASE7J3-DIAG-PAST-APPOINTMENT-UNKNOWN-INTENT.md). Covers the phase's own "12.
 * TESTS" list, items 1-20, in order.
 */

const ADVISOR_PHONE_RAW = "5215500000004"; // obviously-fake test number, wa_id-shaped MX
const ADVISOR_PHONE_E164 = "+525500000004";
const PAST_STARTS_AT = new Date("2020-01-15T15:00:00.000Z");
const PAST_ENDS_AT = new Date("2020-01-15T15:30:00.000Z");

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

async function createPastBookedLead(
  repos: ReturnType<typeof buildRepos>, whatsappUserId: string, overrides: Partial<Lead> = {},
  appointmentTimes: { startsAt: Date; endsAt: Date } = { startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT },
) {
  const lead = await repos.leadsRepo.create({
    country: "MX", productVertical: "GMM", productInterest: "GMM", status: "NEW", score: 81,
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId,
    ...overrides,
  });
  await repos.leadsRepo.update(lead.id, { status: "BOOKED" as LeadStatus, ...overrides });
  const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  await repos.appointmentsRepo.create({
    leadId: lead.id, status: "BOOKED", startsAt: appointmentTimes.startsAt, endsAt: appointmentTimes.endsAt, timezone: "America/Mexico_City",
  });
  return { lead: (await repos.leadsRepo.findById(lead.id))!, conversation };
}

async function outboundMessages(repos: ReturnType<typeof buildRepos>, conversationId: string) {
  const messages = await repos.messagesRepo.listByConversationId(conversationId);
  return messages.filter((m) => m.direction === "OUTBOUND");
}

describe("Fase 7J.3 -- past-appointment unknown-intent handoff + menu fix", () => {
  it("1: past BOOKED + unsupported product question -> HUMAN_HANDOFF", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993001");

    await send(app, "5214779993001", "wamid.1a", "también me ayudan con seguro de auto?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(UNKNOWN_INTENT_HANDOFF_MESSAGE);
  });

  it("2: past BOOKED + gibberish -> HUMAN_HANDOFF", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993002");

    await send(app, "5214779993002", "wamid.2a", "asdkjfh qweoiu");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(UNKNOWN_INTENT_HANDOFF_MESSAGE);
  });

  it("3: past BOOKED + 'reagendar' -> existing flow (new booking round), no handoff", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993003");

    await send(app, "5214779993003", "wamid.3a", "quiero reagendar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKING_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== UNKNOWN_INTENT_HANDOFF_MESSAGE)).toBe(true);
  });

  it("4: past BOOKED + 'quiero otra cita' -> existing booking flow, no handoff", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993004");

    await send(app, "5214779993004", "wamid.4a", "quiero otra cita");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKING_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== UNKNOWN_INTENT_HANDOFF_MESSAGE)).toBe(true);
  });

  it("5: past BOOKED + 'agendar' -> existing booking flow, no handoff", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993005");

    await send(app, "5214779993005", "wamid.5a", "agendar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKING_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== UNKNOWN_INTENT_HANDOFF_MESSAGE)).toBe(true);
  });

  it("6: past BOOKED + a bare date preference ('el sábado por la mañana') -> stays on the existing generic reply, no handoff", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993006");

    await send(app, "5214779993006", "wamid.6a", "el sábado por la mañana");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED"); // never HUMAN_HANDOFF, never auto-booked from a bare date alone
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(PAST_BOOKED_GENERIC_INBOUND_MESSAGE);
  });

  it("7: past BOOKED + 'gracias' -> no handoff, existing behavior", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993007");

    await send(app, "5214779993007", "wamid.7a", "gracias");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== UNKNOWN_INTENT_HANDOFF_MESSAGE)).toBe(true);
  });

  it("8: past BOOKED unknown + alerts enabled -> exactly one advisor alert", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993008");

    await send(app, "5214779993008", "wamid.8a", "también me ayudan con seguro de auto?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(messaging.sentTemplates).toHaveLength(1);
    expect(messaging.sentTemplates[0].to).toBe(ADVISOR_PHONE_E164);
    expect(messaging.sentTemplates[0].templateName).toBe("handoff_asesor");
    void conversation;
  });

  it("9: duplicate inbound (same provider_message_id) -> no duplicate alert", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead } = await createPastBookedLead(repos, "5214779993009");

    await send(app, "5214779993009", "wamid.9a", "también me ayudan con seguro de auto?");
    await send(app, "5214779993009", "wamid.9a", "también me ayudan con seguro de auto?"); // exact same provider_message_id

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(messaging.sentTemplates).toHaveLength(1);
  });

  it("10: a subsequent, DISTINCT inbound while already HUMAN_HANDOFF -> suppressed, no second alert", async () => {
    const repos = buildRepos();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ ...repos, messaging, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true, humanHandoffAlertsEnabled: true, humanHandoffAdvisorPhone: ADVISOR_PHONE_RAW });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993010");

    await send(app, "5214779993010", "wamid.10a", "también me ayudan con seguro de auto?");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");

    await send(app, "5214779993010", "wamid.10b", "hola, siguen ahi?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF"); // unchanged
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1); // only the original escalation message
    expect(messaging.sentTemplates).toHaveLength(1);
  });

  it("11/14/15: menu option '1' (Resolver una duda) resolves via pendingMenu -- MENU_QUESTION, does not repeat the menu", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993011");

    // Turn 1: safe-but-vague ("hola tengo una duda", isVagueInformationRequest) -> past-booked
    // generic (never escalates -- see test 6/7). Turn 2: another safe turn ("hola",
    // isBareGreeting) after it was already shown -> QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE (the
    // 1/2/3 menu), tagged with pendingMenu "MAIN".
    await send(app, "5214779993011", "wamid.11a", "hola tengo una duda");
    await send(app, "5214779993011", "wamid.11b", "hola");
    const beforeMenuOutbound = await outboundMessages(repos, conversation.id);
    expect(beforeMenuOutbound[1].body).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);

    // Turn 3: "1" against the MAIN menu -> MENU_QUESTION, asks what the actual question is --
    // never repeats the same 1/2/3 menu.
    await send(app, "5214779993011", "wamid.11c", "1");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(3);
    expect(outbound[2].body).toBe(buildQualifiedLeadAskQuestionMessage(false));
    expect(outbound[2].body).not.toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED"); // never HUMAN_HANDOFF just for asking
  });

  it("12: menu option '2' (Conocer opciones) resolves via pendingMenu -- EXPLORE_OPTIONS, does not repeat the menu", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993012");

    await send(app, "5214779993012", "wamid.12a", "hola tengo una duda");
    await send(app, "5214779993012", "wamid.12b", "hola");
    await send(app, "5214779993012", "wamid.12c", "2");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(3);
    expect(outbound[2].body).toBe(buildQualifiedLeadOptionsMessage(false));
    expect(outbound[2].metadata).toEqual({ expectedIntent: "QUALIFIED_OPTIONS_MENU" });
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    void lead;
  });

  it("13: menu option '3' (Agendar una asesoría) resolves via pendingMenu -- BOOKING flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993013");

    await send(app, "5214779993013", "wamid.13a", "hola tengo una duda");
    await send(app, "5214779993013", "wamid.13b", "hola");
    await send(app, "5214779993013", "wamid.13c", "3");
    await send(app, "5214779993013", "wamid.13c2", "por la mañana");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKING_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[3].body).toContain("Tengo estos horarios disponibles");
  });

  it("16: DO_NOT_CONTACT unchanged", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead } = await createPastBookedLead(repos, "5214779993016");

    await send(app, "5214779993016", "wamid.16a", "no me escriban mas");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("DO_NOT_CONTACT");
  });

  it("17: feature flags off (WHATSAPP_BOOKING_ENABLED false) -> pastBookedRecoveryHandler absent, unchanged prior behavior", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: false, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993017");

    await send(app, "5214779993017", "wamid.17a", "también me ayudan con seguro de auto?");

    // pastBookedRecoveryHandler is absent entirely -- falls through to the BOOKED-generic branch
    // (Fase 7J.1), which ALSO classifies this exact text as unknown and escalates. Confirms Sec 3
    // of Fase 7J (flag-off != handoff) is untouched: this is a DIFFERENT flag
    // (WHATSAPP_RESCHEDULE_ENABLED/WHATSAPP_CANCELLATION_ENABLED, both still true here) gating
    // that fallback, not WHATSAPP_BOOKING_ENABLED.
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toBe(UNKNOWN_INTENT_HANDOFF_MESSAGE);
  });

  it("17b: feature flags fully off (booking/reschedule/cancellation) -> byte-for-byte silent, no handoff attempted by this phase", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: false, whatsappRescheduleEnabled: false, whatsappCancellationEnabled: false });
    const { lead, conversation } = await createPastBookedLead(repos, "5214779993117");

    await send(app, "5214779993117", "wamid.17c", "también me ayudan con seguro de auto?");

    // No pastBookedRecoveryHandler, no BOOKED-generic branch (requires rescheduleHandler AND
    // cancellationHandler) -- falls through to the router's own final fallback, Sec 3 of Fase 7J,
    // deliberately untouched: silent.
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(0);
  });

  it("18: current (upcoming) BOOKED unknown-intent behavior unchanged (Fase 7J.1, regression)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const lead = await repos.leadsRepo.create({
      country: "MX", productVertical: "GMM", productInterest: "GMM", status: "NEW", score: 81,
      assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214779993018",
    });
    await repos.leadsRepo.update(lead.id, { status: "BOOKED" });
    const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214779993018", "wamid.18a", "también me ayudan con seguro de auto?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toBe(UNKNOWN_INTENT_HANDOFF_MESSAGE);
  });

  it("19: BOOKING_PENDING unknown-intent behavior unchanged (Fase 7J, regression)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const lead = await repos.leadsRepo.create({
      country: "MX", productVertical: "GMM", productInterest: "GMM", status: "NEW", score: 71, scoreClass: "B",
      assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214779993019",
      qualifiedAt: new Date("2026-08-20T10:00:00.000Z"), bookingStartedAt: new Date("2026-08-20T10:05:00.000Z"),
    });
    await repos.leadsRepo.update(lead.id, { status: "BOOKING_PENDING" });
    const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
    const roundId = `round-${lead.id}`;
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
    await repos.offeredSlotsRepo.createMany([
      { conversationId: conversation.id, leadId: lead.id, roundId, slotStart: new Date("2030-06-15T15:00:00.000Z"), slotEnd: new Date("2030-06-15T15:30:00.000Z"), position: 1, expiresAt, selected: false },
    ]);

    await send(app, "5214779993019", "wamid.19a", "también me ayudan con seguro de auto?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
  });

  it("20: cancellation/reschedule/date preference unchanged for past-booked (regression)", async () => {
    // Distinct appointment times per lead: all three share the SAME InMemoryAppointmentRepository
    // instance in this one test (unlike every other test above, each with its own fresh repos),
    // and its overlap check is not scoped by lead -- reusing PAST_STARTS_AT/PAST_ENDS_AT for all
    // three would collide as a false "double booking" of the same slot.
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });

    const { lead: leadCancel } = await createPastBookedLead(repos, "5214779993020", {}, { startsAt: new Date("2020-01-15T15:00:00.000Z"), endsAt: new Date("2020-01-15T15:30:00.000Z") });
    await send(app, "5214779993020", "wamid.20a", "cancelar");
    expect((await repos.leadsRepo.findById(leadCancel.id))?.status).toBe("BOOKED"); // safe no-op reply, nothing to cancel

    const { lead: leadReschedule } = await createPastBookedLead(repos, "5214779993021", {}, { startsAt: new Date("2020-01-16T15:00:00.000Z"), endsAt: new Date("2020-01-16T15:30:00.000Z") });
    await send(app, "5214779993021", "wamid.20b", "reagendar");
    expect((await repos.leadsRepo.findById(leadReschedule.id))?.status).toBe("BOOKING_PENDING");

    const { lead: leadDate } = await createPastBookedLead(repos, "5214779993022", {}, { startsAt: new Date("2020-01-17T15:00:00.000Z"), endsAt: new Date("2020-01-17T15:30:00.000Z") });
    await send(app, "5214779993022", "wamid.20c", "el próximo lunes");
    expect((await repos.leadsRepo.findById(leadDate.id))?.status).toBe("BOOKED"); // stays generic, never handoff
  });
});
