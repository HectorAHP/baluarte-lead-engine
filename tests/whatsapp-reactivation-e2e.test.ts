import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryAppointmentRepository, InMemoryLeadScoreRepository, InMemoryQualificationAnswerRepository,
  InMemoryBookingAttemptRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository, InMemoryAppointmentCancellationRepository,
  InMemoryAppointmentRescheduleRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import {
  CANCELLED_GENERIC_INBOUND_MESSAGE, CANCELLED_RESCHEDULE_TO_NEW_BOOKING_MESSAGE, CANCELLED_ALREADY_MESSAGE,
  BOOKED_GENERIC_INBOUND_MESSAGE,
} from "../src/domain/message-templates.js";
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

/** A CANCELLED lead carrying stale bookedAt/meetingAt from its prior, now-irrelevant appointment
 * -- exactly the real-world shape a lead has after going through cancellation. */
async function makeCancelledLeadWithOldAppointment(repos: ReturnType<typeof buildRepos>, whatsappUserId: string) {
  const { lead, conversation } = await createLeadAtStatus(repos, whatsappUserId, "CANCELLED", {
    bookedAt: new Date("2026-08-01T10:00:00.000Z"),
    meetingAt: new Date("2026-08-15T15:00:00.000Z"),
  });
  const oldAppointment = await repos.appointmentsRepo.create({
    leadId: lead.id, status: "CANCELLED", startsAt: new Date("2026-08-15T15:00:00.000Z"),
    endsAt: new Date("2026-08-15T15:30:00.000Z"), timezone: "America/Mexico_City",
  });
  return { lead, conversation, oldAppointment };
}

describe("Pre-launch hardening -- reactivating a CANCELLED lead", () => {
  it("A: CANCELLED + generic inbound -> exactly one safe fallback, lead stays CANCELLED, old appointment intact", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation, oldAppointment } = await makeCancelledLeadWithOldAppointment(repos, "5214778890401");

    const res = await send(app, "5214778890401", "wamid.a1", "Hola");

    expect(res.statusCode).toBe(200);
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(CANCELLED_GENERIC_INBOUND_MESSAGE);
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCELLED");
    expect((await repos.appointmentsRepo.findById(oldAppointment.id))?.status).toBe("CANCELLED");
    expect(await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date())).toEqual([]);
  });

  it("B: CANCELLED + 'Quiero agendar' -> new booking flow starts, offered_slots have reschedule_context_id IS NULL, lead reaches BOOKING_PENDING (the correct, pre-existing state-machine target)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await makeCancelledLeadWithOldAppointment(repos, "5214778890402");

    await send(app, "5214778890402", "wamid.b1", "Quiero agendar");

    const lead = (await repos.leadsRepo.findById((await repos.conversationsRepo.findById(conversation.id))!.leadId))!;
    expect(lead.status).toBe("BOOKING_PENDING");
    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date());
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((s) => s.rescheduleContextId === undefined)).toBe(true); // context=null -- booking mode, never counted as a reschedule round
    const history = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(history[history.length - 1]).toMatchObject({ fromStatus: "CANCELLED", toStatus: "BOOKING_PENDING", eventType: "BOOKING_OFFER_STARTED" }); // existing event, nothing new invented
  });

  it("C: CANCELLED + 'Quiero reagendar' -> NEVER routed to WhatsAppRescheduleHandler; reframed as a new-booking intent with an explicit acknowledgment, then real availability is offered", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true });
    const { lead, conversation } = await makeCancelledLeadWithOldAppointment(repos, "5214778890403");

    await send(app, "5214778890403", "wamid.c1", "Quiero reagendar");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKING_PENDING"); // never RESCHEDULE_REQUESTED
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound.some((m) => m.body === CANCELLED_RESCHEDULE_TO_NEW_BOOKING_MESSAGE)).toBe(true);
    expect(outbound.some((m) => m.body?.includes("Responde con el número"))).toBe(true); // real availability offered
    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date());
    expect(offered.every((s) => s.rescheduleContextId === undefined)).toBe(true);
  });

  it("D: CANCELLED + 'Quiero cancelar' -> no Calendar call, old appointment intact, safe idempotent reply, no state change", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation, oldAppointment } = await makeCancelledLeadWithOldAppointment(repos, "5214778890404");
    const deleteEventSpy = vi.spyOn(repos.calendar, "deleteEvent");

    await send(app, "5214778890404", "wamid.d1", "Quiero cancelar");

    expect(deleteEventSpy).not.toHaveBeenCalled();
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCELLED");
    expect((await repos.appointmentsRepo.findById(oldAppointment.id))?.status).toBe("CANCELLED");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(CANCELLED_ALREADY_MESSAGE);
  });

  it("E: selecting a new slot -> new appointment BOOKED with rescheduledFrom=null, old appointment stays CANCELLED (never resurrected), lead BOOKED, meetingAt=new.startsAt, bookedAt refreshed to reflect THIS new booking confirmation (documented semantics: unlike reschedule, a cancel-then-rebook is a genuinely new, independent booking event)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation, oldAppointment } = await makeCancelledLeadWithOldAppointment(repos, "5214778890405");
    const originalBookedAt = lead.bookedAt!;

    await send(app, "5214778890405", "wamid.e1", "Quiero agendar");
    await send(app, "5214778890405", "wamid.e2", "1");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKED");
    const newAppointment = await repos.appointmentsRepo.findActiveByLeadId(lead.id);
    expect(newAppointment).not.toBeNull();
    expect(newAppointment?.rescheduledFrom).toBeUndefined();
    expect(newAppointment?.id).not.toBe(oldAppointment.id);
    expect((await repos.appointmentsRepo.findById(oldAppointment.id))?.status).toBe("CANCELLED"); // never touched again
    expect(finalLead?.meetingAt?.getTime()).toBe(newAppointment!.startsAt.getTime());
    // bookedAt semantics for cancel-then-rebook: refreshed, NOT preserved from the cancelled
    // booking (contrast with reschedule, where bookedAt IS preserved -- this is a genuinely new,
    // independent booking event, not a continuation of the old one).
    expect(finalLead?.bookedAt?.getTime()).not.toBe(originalBookedAt.getTime());
    expect(finalLead?.bookedAt?.getTime()).toBeGreaterThan(originalBookedAt.getTime());
  });

  it("F: a repeated webhook delivery with the SAME provider_message_id never produces a duplicate outbound", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await makeCancelledLeadWithOldAppointment(repos, "5214778890406");

    await send(app, "5214778890406", "wamid.f1", "Hola");
    await send(app, "5214778890406", "wamid.f1", "Hola");

    const messages = await repos.messagesRepo.listByConversationId(conversation.id);
    expect(messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1);
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
  });

  it("G: BOOKED generic fallback still works, no regression", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214778890407", "BOOKED", { bookedAt: new Date(), meetingAt: new Date("2026-08-28T15:30:00.000Z") });
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-08-28T15:30:00.000Z"), endsAt: new Date("2026-08-28T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890407", "wamid.g1", "Hola, quiero información");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe(BOOKED_GENERIC_INBOUND_MESSAGE);
  });

  it("H: RESCHEDULE_REQUESTED and CANCEL_PENDING flows stay fully intact, no regression", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214778890408", "BOOKED");
    // Pre-existing test-date fragility (unrelated to this turn's fix, discovered while making
    // this suite pass): must sit far enough in the future that the live reschedule-slot search
    // this test triggers (starting from actual wall-clock "now") can never coincide with it -- see
    // the identical note in whatsapp-booked-generic-fallback-e2e.test.ts's test D.
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2030-06-15T15:30:00.000Z"), endsAt: new Date("2030-06-15T16:00:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890408", "wamid.h1", "Quiero reagendar");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    await send(app, "5214778890408", "wamid.h2", "1");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");

    const { lead: lead2 } = await createLeadAtStatus(repos, "5214778890409", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead2.id, status: "BOOKED", startsAt: new Date("2026-08-29T15:30:00.000Z"), endsAt: new Date("2026-08-29T16:00:00.000Z"), timezone: "America/Mexico_City" });
    await send(app, "5214778890409", "wamid.h3", "Quiero cancelar");
    expect((await repos.leadsRepo.findById(lead2.id))?.status).toBe("CANCEL_PENDING");
    await send(app, "5214778890409", "wamid.h4", "1");
    expect((await repos.leadsRepo.findById(lead2.id))?.status).toBe("CANCELLED");
  });

  it("flag-off regression: with WHATSAPP_BOOKING_ENABLED off, CANCELLED + any text stays silent -- byte-for-byte the historical behavior", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: false });
    const { conversation } = await makeCancelledLeadWithOldAppointment(repos, "5214778890410");

    await send(app, "5214778890410", "wamid.off1", "Quiero agendar");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(0);
  });
});
