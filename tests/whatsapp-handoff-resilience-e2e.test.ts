import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTestApp, TEST_ADMIN_API_TOKEN, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryAppointmentRepository, InMemoryLeadScoreRepository, InMemoryQualificationAnswerRepository,
  InMemoryBookingAttemptRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository, InMemoryAppointmentCancellationRepository,
  InMemoryAppointmentRescheduleRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { UNKNOWN_INTENT_HANDOFF_MESSAGE, BOOKED_GENERIC_INBOUND_MESSAGE } from "../src/domain/message-templates.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";

/**
 * Fase 2.2.3 -- Handoff Resilience. See docs/FASE2.2.3-HANDOFF-RESILIENCE.md for the full audit
 * and design rationale. Covers the phase's own "10. TESTS OBLIGATORIOS" list, in order.
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

async function createLeadAtStatus(repos: ReturnType<typeof buildRepos>, whatsappUserId: string, status: LeadStatus, overrides: Partial<Lead> = {}) {
  const lead = await repos.leadsRepo.create({
    country: "MX", productVertical: "GMM", status: "NEW", score: 78, scoreClass: "A",
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId,
    ...overrides,
  });
  await repos.leadsRepo.update(lead.id, { status, ...overrides });
  // ConversationRepository.findActiveByLeadId only ever matches status "ACTIVE" (see
  // memory-repositories.ts) -- routing is keyed exclusively on lead.status, never
  // conversation.status (see whatsapp-inbound-service.ts's own doc comment), so a fresh "ACTIVE"
  // conversation here is the correct fixture regardless of which lead status this creates.
  const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead: (await repos.leadsRepo.findById(lead.id))!, conversation };
}

/** A HUMAN_HANDOFF lead with a real, live, upcoming BOOKED appointment -- the "caso obligatorio"
 * fixture from the Fase 2.2.3 brief (item 3), and the exact real-world shape of the Fase 2.2.2
 * incident this phase fixes. */
async function createHandoffLeadWithLiveAppointment(repos: ReturnType<typeof buildRepos>, whatsappUserId: string) {
  const { lead, conversation } = await createLeadAtStatus(repos, whatsappUserId, "HUMAN_HANDOFF");
  const appointment = await repos.appointmentsRepo.create({
    leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT,
    timezone: "America/Mexico_City", calendarEventId: `evt-${whatsappUserId}`,
  });
  return { lead, conversation, appointment };
}

async function outboundMessages(repos: ReturnType<typeof buildRepos>, conversationId: string) {
  const messages = await repos.messagesRepo.listByConversationId(conversationId);
  return messages.filter((m) => m.direction === "OUTBOUND");
}

/** Test-only introspection, Fase 2.2.14A: escalateToHuman (booking-outcome-dispatch.ts) flips the
 * conversation it's given to status "HUMAN_HANDOFF" -- so whatsapp-inbound-service.ts's own
 * `findActiveByLeadId` (ACTIVE only) can no longer find it, and the NEXT inbound message creates a
 * fresh conversation. This is pre-existing app behavior, unrelated to this phase, but it means a
 * test that sends a real escalation and then a follow-up message must look across every
 * conversation the lead has accumulated, not just the one its fixture originally created --
 * ConversationRepository's own port has no "all conversations for a lead" query (only
 * findActiveByLeadId), so this reaches into the InMemory implementation's own storage directly. */
function allConversationsForLead(repos: ReturnType<typeof buildRepos>, leadId: string) {
  const data = (repos.conversationsRepo as unknown as { data: Map<string, { id: string; leadId: string }> }).data;
  return [...data.values()].filter((c) => c.leadId === leadId);
}

async function allMessagesForLead(repos: ReturnType<typeof buildRepos>, leadId: string) {
  const conversations = allConversationsForLead(repos, leadId);
  const perConversation = await Promise.all(conversations.map((c) => repos.messagesRepo.listByConversationId(c.id)));
  return perConversation.flat().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

async function allOutboundMessagesForLead(repos: ReturnType<typeof buildRepos>, leadId: string) {
  return (await allMessagesForLead(repos, leadId)).filter((m) => m.direction === "OUTBOUND");
}

describe("Fase 2.2.3 -- Handoff Resilience", () => {
  // TEST 1 -- Lead normal + "Cancelar" -> cancelación funciona (regression baseline; the full
  // matrix already lives in whatsapp-cancellation-e2e.test.ts, kept there as the source of truth).
  it("TEST 1: BOOKED (normal, never suppressed) + 'Cancelar' -> starts the real cancellation flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214772200001", "BOOKED");
    await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT, timezone: "America/Mexico_City",
    });

    await send(app, "5214772200001", "wamid.t1", "Cancelar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING");
  });

  // TEST 2 -- Lead HUMAN_HANDOFF + "Cancelar" -> cancelación funciona, sin requerir recover-handoff previo.
  it("TEST 2: HUMAN_HANDOFF + 'Cancelar' -> auto-recovers to BOOKED and enters the real cancellation flow (no admin action needed)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true });
    const { lead, conversation, appointment } = await createHandoffLeadWithLiveAppointment(repos, "5214772200002");
    await repos.calendar.createEvent({ title: "Cita", description: "", start: appointment.startsAt, end: appointment.endsAt });

    await send(app, "5214772200002", "wamid.t2a", "Cancelar");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING");

    await send(app, "5214772200002", "wamid.t2b", "1"); // confirm

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("CANCELLED");
    const finalAppointment = await repos.appointmentsRepo.findById(appointment.id);
    expect(finalAppointment?.status).toBe("CANCELLED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.some((m) => m.body?.includes("Listo, tu cita quedó cancelada"))).toBe(true);
  });

  // TEST 3 -- Lead HUMAN_HANDOFF + "Reagendar" -> entra al flujo real de reprogramación.
  it("TEST 3: HUMAN_HANDOFF + 'Reagendar' -> auto-recovers to BOOKED and enters the real reschedule flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true });
    const { lead, conversation } = await createHandoffLeadWithLiveAppointment(repos, "5214772200003");

    await send(app, "5214772200003", "wamid.t3", "Reagendar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.length).toBeGreaterThan(0); // real slot-offering reply, never silence
  });

  // TEST 4 -- Lead HUMAN_HANDOFF + mensaje comercial libre -> bot comercial permanece pausado.
  it("TEST 4: HUMAN_HANDOFF + generic commercial free text -> stays fully suppressed, zero automated reply", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true, whatsappRescheduleEnabled: true });
    const { lead, conversation } = await createHandoffLeadWithLiveAppointment(repos, "5214772200004");

    await send(app, "5214772200004", "wamid.t4", "Hola, quiero saber más sobre el seguro de mi empresa");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF"); // unchanged
    expect(await outboundMessages(repos, conversation.id)).toHaveLength(0);
  });

  // TEST 5 -- UNKNOWN_INTENT no produce bloqueo permanente injustificado.
  it("TEST 5: UNKNOWN_INTENT_HANDOFF (real escalation path) does not permanently block -- 'Cancelar' afterward still works", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true, whatsappRescheduleEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214772200005", "BOOKED");
    await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT, timezone: "America/Mexico_City",
    });

    // Real escalation, exactly the Fase 2.2.2 incident: an unparseable message escalates BOOKED -> HUMAN_HANDOFF.
    await send(app, "5214772200005", "wamid.t5a", "no sé, tal vez tenga una junta");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect((await outboundMessages(repos, conversation.id))[0]?.body).toBe(UNKNOWN_INTENT_HANDOFF_MESSAGE);

    // Before this phase, this lead was frozen forever with no way out short of an admin manually
    // calling recover-handoff. Now, an unambiguous operational command still gets through.
    await send(app, "5214772200005", "wamid.t5b", "mejor cancelar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING");
    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(history.map((h) => h.eventType)).toContain("HANDOFF_AUTO_RECOVERED_CRITICAL_COMMAND");
  });

  // TEST 6 -- Explicit human handoff conserva comportamiento humano esperado.
  it("TEST 6: EXPLICIT_HUMAN_HANDOFF-shaped lead + commercial free text -> stays paused exactly like TEST 4 (no special-casing by reason)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true, whatsappRescheduleEnabled: true });
    const { lead, conversation, appointment } = await createHandoffLeadWithLiveAppointment(repos, "5214772200006");
    // Simulate the ORIGINAL escalation having been an explicit one (e.g. HEALTH_HANDOFF_MESSAGE /
    // REQUESTS_HUMAN) by recording that as the most recent history event -- the mechanism under
    // test does not branch on this reason at all (see the design note in
    // docs/FASE2.2.3-HANDOFF-RESILIENCE.md, section H), so this proves that holds.
    await repos.leadStatusHistoryRepo.create({ leadId: lead.id, fromStatus: "BOOKED", toStatus: "HUMAN_HANDOFF", eventType: "HUMAN_HANDOFF_REQUESTED", metadata: {} });

    await send(app, "5214772200006", "wamid.t6", "¿me pueden ayudar con otra cosa?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(await outboundMessages(repos, conversation.id)).toHaveLength(0);
    // The appointment is never touched by a commercial message either.
    expect((await repos.appointmentsRepo.findById(appointment.id))?.status).toBe("BOOKED");
  });

  // TEST 7 -- recover-handoff sigue funcionando (admin endpoint untouched).
  it("TEST 7: POST /api/leads/:id/recover-handoff still works unchanged for a lead with no live appointment", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, adminApiToken: TEST_ADMIN_API_TOKEN });
    const { lead } = await createLeadAtStatus(repos, "5214772200007", "HUMAN_HANDOFF");

    const res = await app.inject({
      method: "POST", url: `/api/leads/${lead.id}/recover-handoff`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, outcome: "RECOVERED", previousStatus: "HUMAN_HANDOFF" });
    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(history.at(-1)?.eventType).toBe("HANDOFF_MANUALLY_RECOVERED"); // unchanged admin-path label
  });

  // TEST 8 -- duplicate wamid sigue ignorado.
  it("TEST 8: duplicate webhook delivery of the SAME critical command during HUMAN_HANDOFF -> exactly one recovery, one cancellation, never two", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createHandoffLeadWithLiveAppointment(repos, "5214772200008");

    await send(app, "5214772200008", "wamid.t8", "cancelar");
    await send(app, "5214772200008", "wamid.t8", "cancelar"); // exact same provider_message_id -- a real Meta redelivery

    const messages = await repos.messagesRepo.listByConversationId(conversation.id);
    expect(messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1); // deduped correctly
    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(history.filter((h) => h.eventType === "HANDOFF_AUTO_RECOVERED_CRITICAL_COMMAND")).toHaveLength(1); // never a duplicate recovery
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING");
  });

  // TEST 9 -- cancelación sigue sincronizando Calendar.
  it("TEST 9: a HUMAN_HANDOFF cancellation still deletes the real Google Calendar event via the unmodified AppointmentCancellationService", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true });
    const { lead, appointment } = await createHandoffLeadWithLiveAppointment(repos, "5214772200009");
    const event = await repos.calendar.createEvent({ title: "Cita", description: "", start: appointment.startsAt, end: appointment.endsAt });
    await repos.appointmentsRepo.update(appointment.id, { calendarEventId: event.eventId });
    expect(await repos.calendar.isSlotAvailable(appointment.startsAt, appointment.endsAt)).toBe(false); // busy before cancellation

    await send(app, "5214772200009", "wamid.t9a", "cancelar");
    await send(app, "5214772200009", "wamid.t9b", "1");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCELLED");
    const cancellations = await repos.appointmentCancellationsRepo.findByIdempotencyKey(`whatsapp-cancel:${lead.id}:${appointment.id}`);
    expect(cancellations?.status).toBe("COMPLETED");
    expect(await repos.calendar.isSlotAvailable(appointment.startsAt, appointment.endsAt)).toBe(true); // slot freed -> event was actually deleted, not just marked
  });

  // TEST 10 -- status history conserva transiciones correctas (full audited chain).
  it("TEST 10: the full audit trail reads HUMAN_HANDOFF -> BOOKED (auto) -> CANCEL_PENDING -> CANCELLED, with distinct event types throughout", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true });
    const { lead, appointment } = await createHandoffLeadWithLiveAppointment(repos, "5214772200010");

    await send(app, "5214772200010", "wamid.t10a", "cancelar");
    await send(app, "5214772200010", "wamid.t10b", "1");

    const leadHistory = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(leadHistory.map((h) => [h.fromStatus, h.toStatus, h.eventType])).toEqual([
      ["HUMAN_HANDOFF", "BOOKED", "HANDOFF_AUTO_RECOVERED_CRITICAL_COMMAND"],
      ["BOOKED", "CANCEL_PENDING", "CANCELLATION_REQUESTED"],
      ["CANCEL_PENDING", "CANCELLED", "APPOINTMENT_CANCELLED"],
    ]);
    const appointmentHistory = await repos.appointmentStatusHistoryRepo.listByAppointmentId(appointment.id);
    expect(appointmentHistory).toHaveLength(1);
    expect(appointmentHistory[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "CANCELLED", eventType: "APPOINTMENT_CANCELLED" });
  });

  // Flag-off regression: with both handlers off, HUMAN_HANDOFF behaves byte-for-byte as before
  // this phase -- the critical-command bypass itself is gated on the same flags as the handlers.
  it("flag-off regression: HUMAN_HANDOFF + 'cancelar' with WHATSAPP_CANCELLATION_ENABLED off stays fully suppressed, unchanged", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: false, whatsappRescheduleEnabled: false });
    const { lead, conversation } = await createHandoffLeadWithLiveAppointment(repos, "5214772200011");

    await send(app, "5214772200011", "wamid.t11", "cancelar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(await outboundMessages(repos, conversation.id)).toHaveLength(0);
  });

  // No live appointment to act on: the bypass must never mutate lead status just because a
  // critical-command WORD was sent -- guards against Test 4's regression (see the doc comment on
  // the read-only precondition check in whatsapp-inbound-service.ts).
  it("HUMAN_HANDOFF + 'cancelar' with NO live BOOKED appointment -> stays suppressed, lead status untouched", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214772200012", "HUMAN_HANDOFF");

    await send(app, "5214772200012", "wamid.t12", "cancelar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF"); // never mutated
    expect(await outboundMessages(repos, conversation.id)).toHaveLength(0);
    expect(await repos.leadStatusHistoryRepo.listByLeadId(lead.id)).toHaveLength(0);
  });

  // DO_NOT_CONTACT stays absolutely final -- never given any of this phase's new bypasses.
  it("DO_NOT_CONTACT + 'cancelar' -> stays fully silent, never bypassed (opt-out is final)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214772200013", "DO_NOT_CONTACT");

    await send(app, "5214772200013", "wamid.t13", "cancelar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("DO_NOT_CONTACT");
    expect(await outboundMessages(repos, conversation.id)).toHaveLength(0);
  });

  // Opt-out during HUMAN_HANDOFF -- the third critical command listed in the brief (item 2).
  it("HUMAN_HANDOFF + 'STOP' -> opt-out is still honored, transitions to DO_NOT_CONTACT", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos });
    const { lead, conversation } = await createHandoffLeadWithLiveAppointment(repos, "5214772200014");

    await send(app, "5214772200014", "wamid.t14", "STOP");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("DO_NOT_CONTACT");
    expect((await outboundMessages(repos, conversation.id))).toHaveLength(1);
    // The live appointment is untouched by an opt-out -- opting out of messages is not a cancellation.
    const appointments = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    expect(appointments[0]?.status).toBe("BOOKED");
  });
});

/**
 * Fase 2.2.14A -- Unknown Intent Auto-Recovery. See
 * docs/FASE2.2.14-UNKNOWN-INTENT-HANDOFF-POLICY.md (audit/policy) and
 * docs/FASE2.2.14A-UNKNOWN-INTENT-AUTO-RECOVERY.md (this phase's report) for the full rationale.
 * Covers the phase's own "Sección 7: TESTS OBLIGATORIOS" list, in order. TEST 5 above already
 * proves the mechanism end-to-end for the critical-command path (existing since Fase 2.2.3) --
 * these 10 tests prove the NEW unknown-intent path added in this phase, and its precedence
 * relative to that existing path.
 */
describe("Fase 2.2.14A -- Unknown Intent Auto-Recovery", () => {
  // TEST 1 -- el mensaje siguiente reconocido recupera Y se procesa en el mismo turno.
  it("TEST 1: UNKNOWN_INTENT_HANDOFF + next recognized message -> auto-recovers and answers that SAME message, never stays frozen", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true, whatsappRescheduleEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214772210001", "BOOKED");
    await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT, timezone: "America/Mexico_City",
    });

    // Real escalation via the actual router (same trigger as the Fase 2.2.13 production incident).
    await send(app, "5214772210001", "wamid.u1a", "no sé, tal vez tenga una junta");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");

    // A generic, non-critical message the lead sends "a third time" that a plain BOOKED lead would
    // get a real reply for -- proves the user never needs to write a third time to unstick this.
    await send(app, "5214772210001", "wamid.u1b", "gracias");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKED"); // auto-recovered, and the recognized message did not re-escalate
    // The escalation flips the ORIGINAL conversation away from ACTIVE (see the doc comment on
    // allOutboundMessagesForLead), so the recovered turn's reply lands in a fresh conversation --
    // gather across all of them rather than assuming a single conversation.id stays valid.
    const outbound = await allOutboundMessagesForLead(repos, lead.id);
    expect(outbound).toHaveLength(2); // 1: the original UNKNOWN_INTENT_HANDOFF_MESSAGE, 2: a real answer to "gracias"
    expect(outbound[0]?.body).toBe(UNKNOWN_INTENT_HANDOFF_MESSAGE);
    expect(outbound[1]?.body).not.toBe(UNKNOWN_INTENT_HANDOFF_MESSAGE); // a real reply, never silence, never another escalation message
    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(history.map((h) => h.eventType)).toEqual(["UNKNOWN_INTENT_HANDOFF", "UNKNOWN_INTENT_AUTO_RECOVERY"]);
  });

  // TEST 2 -- el mensaje siguiente TAMBIÉN desconocido: recupera, enruta, vuelve a escalar -- sin loop.
  it("TEST 2: UNKNOWN_INTENT_HANDOFF + next message ALSO unrecognized -> auto-recovers, routes, re-escalates to HUMAN_HANDOFF again -- no infinite loop", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true, whatsappRescheduleEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214772210002", "BOOKED");
    await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT, timezone: "America/Mexico_City",
    });

    await send(app, "5214772210002", "wamid.u2a", "no sé, tal vez tenga una junta");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");

    // Same unparseable text again: recovers back to BOOKED, that status's own router still can't
    // parse it, and its own (unmodified) escalation logic fires again -- a genuine second episode.
    await send(app, "5214772210002", "wamid.u2b", "no sé, tal vez tenga una junta");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF"); // back in handoff -- correct, not a bug
    // Each escalation flips its own conversation away from ACTIVE (see allOutboundMessagesForLead's
    // doc comment), so this episode's two escalation replies land in two different conversations.
    const outbound = await allOutboundMessagesForLead(repos, lead.id);
    expect(outbound).toHaveLength(2); // exactly one escalation message per episode -- finite, never a runaway loop
    expect(outbound.every((m) => m.body === UNKNOWN_INTENT_HANDOFF_MESSAGE)).toBe(true);
    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(history.map((h) => h.eventType)).toEqual(["UNKNOWN_INTENT_HANDOFF", "UNKNOWN_INTENT_AUTO_RECOVERY", "UNKNOWN_INTENT_HANDOFF"]);
  });

  // TEST 3 -- handoff explícito nunca se auto-recupera con un mensaje normal.
  it("TEST 3: EXPLICIT_HUMAN_HANDOFF + normal message -> NO auto-recovery, stays silenced exactly as before this phase", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true, whatsappRescheduleEnabled: true });
    const { lead, conversation } = await createHandoffLeadWithLiveAppointment(repos, "5214772210003");
    await repos.leadStatusHistoryRepo.create({ leadId: lead.id, fromStatus: "BOOKED", toStatus: "HUMAN_HANDOFF", eventType: "HUMAN_HANDOFF_REQUESTED", metadata: {} });

    await send(app, "5214772210003", "wamid.u3", "¿me pueden ayudar con otra cosa?");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(await outboundMessages(repos, conversation.id)).toHaveLength(0);
    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(history.map((h) => h.eventType)).not.toContain("UNKNOWN_INTENT_AUTO_RECOVERY");
  });

  // TEST 4 -- el bypass crítico existente (Cancelar) tiene precedencia sobre esta nueva rama.
  it("TEST 4: UNKNOWN_INTENT_HANDOFF + 'Cancelar' -> preserves the EXISTING critical-command bypass, never the new unknown-intent path", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true, whatsappRescheduleEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214772210004", "BOOKED");
    await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT, timezone: "America/Mexico_City",
    });

    await send(app, "5214772210004", "wamid.u4a", "no sé, tal vez tenga una junta");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");

    await send(app, "5214772210004", "wamid.u4b", "Cancelar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING");
    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    const recoveryEvents = history.map((h) => h.eventType).filter((e) => e === "HANDOFF_AUTO_RECOVERED_CRITICAL_COMMAND" || e === "UNKNOWN_INTENT_AUTO_RECOVERY");
    expect(recoveryEvents).toEqual(["HANDOFF_AUTO_RECOVERED_CRITICAL_COMMAND"]); // the OLD bypass fired, never the new one
  });

  // TEST 5 -- el bypass crítico existente (Reagendar) tiene precedencia sobre esta nueva rama.
  it("TEST 5: UNKNOWN_INTENT_HANDOFF + 'Reagendar' -> preserves the EXISTING critical-command bypass, never the new unknown-intent path", async () => {
    const repos = buildRepos();
    // Both flags needed: the initial escalation trigger itself (booked-generic-fallback branch,
    // whatsapp-inbound-service.ts:977) requires BOTH rescheduleHandler AND cancellationHandler
    // present before it will even evaluate whether to escalate -- reschedule-only would leave the
    // first message unrouted (no reply, no escalation, lead stays BOOKED), never reaching the
    // HUMAN_HANDOFF precondition this test needs.
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true, whatsappRescheduleEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214772210005", "BOOKED");
    await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT, timezone: "America/Mexico_City",
    });

    await send(app, "5214772210005", "wamid.u5a", "no sé, tal vez tenga una junta");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");

    await send(app, "5214772210005", "wamid.u5b", "Reagendar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    const recoveryEvents = history.map((h) => h.eventType).filter((e) => e === "HANDOFF_AUTO_RECOVERED_CRITICAL_COMMAND" || e === "UNKNOWN_INTENT_AUTO_RECOVERY");
    expect(recoveryEvents).toEqual(["HANDOFF_AUTO_RECOVERED_CRITICAL_COMMAND"]);
  });

  // TEST 6 -- "caso obligatorio": UNKNOWN_INTENT_HANDOFF histórico, pero el handoff ACTUAL es explícito.
  it("TEST 6: historical UNKNOWN_INTENT_HANDOFF but the CURRENT handoff episode is explicit -> NO auto-recovery", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true, whatsappRescheduleEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214772210006", "HUMAN_HANDOFF");
    // Old episode, days ago: escalated for UNKNOWN_INTENT_HANDOFF, then manually recovered.
    await repos.leadStatusHistoryRepo.create({ leadId: lead.id, fromStatus: "BOOKED", toStatus: "HUMAN_HANDOFF", eventType: "UNKNOWN_INTENT_HANDOFF", metadata: {} });
    await repos.leadStatusHistoryRepo.create({ leadId: lead.id, fromStatus: "HUMAN_HANDOFF", toStatus: "BOOKED", eventType: "HANDOFF_MANUALLY_RECOVERED", metadata: {} });
    // NEW, separate episode: a genuinely explicit escalation is the current, most recent reason.
    await repos.leadStatusHistoryRepo.create({ leadId: lead.id, fromStatus: "BOOKED", toStatus: "HUMAN_HANDOFF", eventType: "HUMAN_HANDOFF_REQUESTED", metadata: {} });

    await send(app, "5214772210006", "wamid.u6", "Hola, quiero revisar mi resultado");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF"); // never confused with the old, unrelated episode
    expect(await outboundMessages(repos, conversation.id)).toHaveLength(0);
    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(history.map((h) => h.eventType)).not.toContain("UNKNOWN_INTENT_AUTO_RECOVERY");
  });

  // TEST 7 -- el audit trail registra un evento de auto-recuperación inequívoco y medible.
  it("TEST 7: audit trail records an unambiguous, distinctly-labeled UNKNOWN_INTENT_AUTO_RECOVERY event", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true, whatsappRescheduleEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214772210007", "BOOKED");
    await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT, timezone: "America/Mexico_City",
    });

    await send(app, "5214772210007", "wamid.u7a", "no sé, tal vez tenga una junta");
    await send(app, "5214772210007", "wamid.u7b", "gracias");

    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    const recoveryEntry = history.find((h) => h.eventType === "UNKNOWN_INTENT_AUTO_RECOVERY");
    expect(recoveryEntry).toBeDefined();
    expect(recoveryEntry).toMatchObject({ fromStatus: "HUMAN_HANDOFF", toStatus: "BOOKED" });
    expect(recoveryEntry?.metadata).toMatchObject({ recoveryReasonCode: "AUTOMATIC_UNKNOWN_INTENT_NOT_PERMANENT" });
    // Distinguishable from the OTHER two recover() callers' own labels -- never conflated.
    expect(history.map((h) => h.eventType)).not.toContain("HANDOFF_MANUALLY_RECOVERED");
    expect(history.map((h) => h.eventType)).not.toContain("HANDOFF_AUTO_RECOVERED_CRITICAL_COMMAND");
  });

  // TEST 8 -- el mismo mensaje entrante se procesa exactamente una vez tras la recuperación.
  it("TEST 8: the message that triggers auto-recovery is processed exactly once (never double-ingested)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true, whatsappRescheduleEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214772210008", "BOOKED");
    await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT, timezone: "America/Mexico_City",
    });

    await send(app, "5214772210008", "wamid.u8a", "no sé, tal vez tenga una junta");
    await send(app, "5214772210008", "wamid.u8b", "gracias");

    // The escalation creates a second conversation for the recovered turn (see
    // allOutboundMessagesForLead's doc comment) -- look across all of the lead's conversations.
    const messages = await allMessagesForLead(repos, lead.id);
    expect(messages.filter((m) => m.direction === "INBOUND" && m.providerMessageId === "wamid.u8b")).toHaveLength(1);
    const outbound = messages.filter((m) => m.direction === "OUTBOUND");
    expect(outbound.filter((m) => m.body === BOOKED_GENERIC_INBOUND_MESSAGE)).toHaveLength(1); // exactly one answer, not two
  });

  // TEST 9 -- el dedupe por wamid sigue funcionando bajo esta nueva rama.
  it("TEST 9: duplicate webhook delivery (same wamid) of the recovery-triggering message -> exactly one recovery, never two", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true, whatsappRescheduleEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214772210009", "BOOKED");
    await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT, timezone: "America/Mexico_City",
    });

    await send(app, "5214772210009", "wamid.u9a", "no sé, tal vez tenga una junta");
    await send(app, "5214772210009", "wamid.u9b", "gracias");
    await send(app, "5214772210009", "wamid.u9b", "gracias"); // exact same provider_message_id -- a real Meta redelivery

    const messages = await allMessagesForLead(repos, lead.id);
    expect(messages.filter((m) => m.direction === "INBOUND")).toHaveLength(2); // deduped: only u9a + u9b, not a third
    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(history.filter((h) => h.eventType === "UNKNOWN_INTENT_AUTO_RECOVERY")).toHaveLength(1); // never a duplicate recovery
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
  });

  // TEST 10 -- el endpoint admin recover-handoff sigue funcionando, incluso cuando el motivo original fue UNKNOWN_INTENT_HANDOFF.
  it("TEST 10: admin POST /api/leads/:id/recover-handoff still works without regression for a lead originally escalated via UNKNOWN_INTENT_HANDOFF", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, adminApiToken: TEST_ADMIN_API_TOKEN, whatsappCancellationEnabled: true, whatsappRescheduleEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214772210010", "BOOKED");
    await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: FUTURE_STARTS_AT, endsAt: FUTURE_ENDS_AT, timezone: "America/Mexico_City",
    });
    await send(app, "5214772210010", "wamid.u10", "no sé, tal vez tenga una junta");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");

    const res = await app.inject({
      method: "POST", url: `/api/leads/${lead.id}/recover-handoff`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, outcome: "RECOVERED", previousStatus: "HUMAN_HANDOFF" });
    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(history.at(-1)?.eventType).toBe("HANDOFF_MANUALLY_RECOVERED"); // unchanged admin-path label, unaffected by this phase
  });
});
