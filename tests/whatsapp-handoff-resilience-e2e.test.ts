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
import { UNKNOWN_INTENT_HANDOFF_MESSAGE } from "../src/domain/message-templates.js";
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
