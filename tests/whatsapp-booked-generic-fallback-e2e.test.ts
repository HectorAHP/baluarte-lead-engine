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
import type { Lead, LeadStatus } from "../src/domain/lead.js";

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
    meetingAt: new Date("2026-08-28T15:30:00.000Z"),
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

describe("Pre-launch hardening -- BOOKED lead + generic inbound (post-mortem item A)", () => {
  it("A: BOOKED + 'Hola, quiero información' -> inbound persisted, exactly one safe fallback outbound, lead and appointment completely untouched", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890301", "BOOKED");
    const appointment = await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-08-28T15:30:00.000Z"),
      endsAt: new Date("2026-08-28T16:00:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-real",
    });
    const scoreBefore = lead.score;
    const meetingAtBefore = lead.meetingAt;
    const bookedAtBefore = lead.bookedAt;

    const res = await send(app, "5214778890301", "wamid.gen1", "Hola, quiero información");

    expect(res.statusCode).toBe(200);
    const messages = await repos.messagesRepo.listByConversationId(conversation.id);
    expect(messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1);
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1); // exactly one safe fallback -- never silence, never more than one
    expect(outbound[0].body).toBe(BOOKED_GENERIC_INBOUND_MESSAGE);

    // Invariants (item 8): nothing about the lead or appointment changed.
    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKED");
    expect(finalLead?.score).toBe(scoreBefore);
    expect(finalLead?.meetingAt?.getTime()).toBe(meetingAtBefore!.getTime());
    expect(finalLead?.bookedAt?.getTime()).toBe(bookedAtBefore!.getTime());
    const finalAppointment = await repos.appointmentsRepo.findById(appointment.id);
    expect(finalAppointment?.status).toBe("BOOKED");
    expect(finalAppointment?.startsAt.getTime()).toBe(appointment.startsAt.getTime());
    expect(await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date())).toEqual([]); // no new offered_slots
    expect(await repos.qualificationAnswersRepo.listByLeadId(lead.id)).toEqual([]); // no qualification answers
    expect(await repos.leadScoresRepo.listByLeadId(lead.id)).toEqual([]); // no new score record
  });

  it("A2: a second, genuinely distinct generic message (different provider_message_id, different text) also gets its own safe fallback -- never silence, never treated as a duplicate", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890302", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-08-28T15:30:00.000Z"), endsAt: new Date("2026-08-28T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890302", "wamid.gen2a", "Hola quiero información"); // no comma -- genuinely different text
    await send(app, "5214778890302", "wamid.gen2b", "Hola, quiero información");

    const messages = await repos.messagesRepo.listByConversationId(conversation.id);
    expect(messages.filter((m) => m.direction === "INBOUND")).toHaveLength(2); // two real, distinct inbound messages -- item 10
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(2); // each genuinely distinct inbound gets its own reply
  });

  it("B: BOOKED + 'Quiero reagendar' still starts the real reschedule flow, never the generic fallback", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890303", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-08-28T15:30:00.000Z"), endsAt: new Date("2026-08-28T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890303", "wamid.b1", "Quiero reagendar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== BOOKED_GENERIC_INBOUND_MESSAGE)).toBe(true);
    expect(outbound.some((m) => m.body?.includes("puedo ayudarte a cambiar tu cita"))).toBe(true);
  });

  it("C: BOOKED + 'Quiero cancelar' still starts the real cancellation flow, never the generic fallback", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890304", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-08-28T15:30:00.000Z"), endsAt: new Date("2026-08-28T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890304", "wamid.c1", "Quiero cancelar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== BOOKED_GENERIC_INBOUND_MESSAGE)).toBe(true);
    expect(outbound.some((m) => m.body?.includes("1. Sí, cancelar"))).toBe(true);
  });

  it("D: RESCHEDULE_REQUESTED + a valid slot selection never gets the generic fallback", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890305", "BOOKED");
    // Pre-existing test-date fragility (unrelated to this turn's fix, discovered while making
    // this suite pass): the old appointment must sit far enough in the future that the real
    // reschedule-slot search this test triggers (which starts from actual wall-clock "now") can
    // never generate a candidate slot that coincides with it -- every OTHER test in this file
    // uses "today" safely because none of them actually complete a live slot selection against a
    // freshly generated offer the way this one does.
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });
    await send(app, "5214778890305", "wamid.d1", "Quiero reagendar");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");

    await send(app, "5214778890305", "wamid.d2", "1");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.every((m) => m.body !== BOOKED_GENERIC_INBOUND_MESSAGE)).toBe(true);
    expect(outbound.some((m) => m.body?.includes("tu cita fue reagendada"))).toBe(true);
  });

  it("E: CANCEL_PENDING + '1' and CANCEL_PENDING + '2' never get the generic fallback", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead: lead1, conversation: conv1 } = await createLeadAtStatus(repos, "5214778890306", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead1.id, status: "BOOKED", startsAt: new Date("2026-08-28T15:30:00.000Z"), endsAt: new Date("2026-08-28T16:00:00.000Z"), timezone: "America/Mexico_City" });
    await send(app, "5214778890306", "wamid.e1", "Quiero cancelar");
    await send(app, "5214778890306", "wamid.e2", "1");
    const outbound1 = await outboundMessages(repos, conv1.id);
    expect(outbound1.every((m) => m.body !== BOOKED_GENERIC_INBOUND_MESSAGE)).toBe(true);
    expect((await repos.leadsRepo.findById(lead1.id))?.status).toBe("CANCELLED");

    const { lead: lead2, conversation: conv2 } = await createLeadAtStatus(repos, "5214778890307", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead2.id, status: "BOOKED", startsAt: new Date("2026-08-29T15:30:00.000Z"), endsAt: new Date("2026-08-29T16:00:00.000Z"), timezone: "America/Mexico_City" });
    await send(app, "5214778890307", "wamid.e3", "Quiero cancelar");
    await send(app, "5214778890307", "wamid.e4", "2");
    const outbound2 = await outboundMessages(repos, conv2.id);
    expect(outbound2.every((m) => m.body !== BOOKED_GENERIC_INBOUND_MESSAGE)).toBe(true);
    expect((await repos.leadsRepo.findById(lead2.id))?.status).toBe("BOOKED");
  });

  it("F: a repeated webhook delivery with the SAME provider_message_id never produces a duplicate outbound (or a second inbound row)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890308", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-08-28T15:30:00.000Z"), endsAt: new Date("2026-08-28T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890308", "wamid.dup1", "Hola, quiero información");
    await send(app, "5214778890308", "wamid.dup1", "Hola, quiero información"); // exact same provider_message_id -- a real Meta webhook redelivery

    const messages = await repos.messagesRepo.listByConversationId(conversation.id);
    expect(messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1); // deduped correctly
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1); // never a duplicate reply
  });

  it("flag-off regression: with WHATSAPP_RESCHEDULE_ENABLED or WHATSAPP_CANCELLATION_ENABLED off, BOOKED + generic text stays silent -- byte-for-byte the historical behavior, the new copy is never sent referencing actions that aren't actually available", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: false, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890309", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-08-28T15:30:00.000Z"), endsAt: new Date("2026-08-28T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890309", "wamid.off1", "Hola, quiero información");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(0);
  });
});
