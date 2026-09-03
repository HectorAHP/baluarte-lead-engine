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
    country: "MX", productVertical: "GMM", status: "NEW", score: 71,
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId,
    ...overrides,
  });
  await repos.leadsRepo.update(lead.id, { status, ...overrides });
  const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead: (await repos.leadsRepo.findById(lead.id))!, conversation };
}

describe("Phase 4C -- WHATSAPP_RESCHEDULE_ENABLED flag matrix", () => {
  it("false (default): a BOOKED lead's reschedule-intent message gets no automated reply -- Phase 4B behavior unchanged", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: false, whatsappCancellationEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214778890001", "BOOKED");

    const res = await send(app, "5214778890001", "wamid.r1", "quiero reagendar");

    expect(res.statusCode).toBe(200);
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead.id);
    expect(await repos.messagesRepo.listByConversationId(conversation!.id)).toHaveLength(1); // only the inbound
  });

  it("false: a BOOKED lead's cancellation-intent message still works exactly as Phase 4B (reschedule routing never intercepts it when the flag is off)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: false, whatsappCancellationEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214778890002", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890002", "wamid.r2", "cancelar cita");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING");
  });

  it("true: a BOOKED lead's reschedule-intent message starts the reschedule flow through the real webhook pipeline", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214778890003", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City" });

    const res = await send(app, "5214778890003", "wamid.r3", "quiero reagendar");

    expect(res.statusCode).toBe(200);
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
  });
});

describe("Phase 4C post-mortem -- item F: meeting-time sync, full E2E through the real booking + reschedule webhook pipeline", () => {
  it("real booking (09:00) -> real reschedule (09:30) -> lead BOOKED with meetingAt=09:30, bookedAt preserved from the ORIGINAL booking", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214778890199", "BOOKING_PENDING", { bookingStartedAt: new Date() });
    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead.id);

    // Real booking flow -- offer, select position 1 (09:00).
    await send(app, "5214778890199", "wamid.f1", "hola");
    const bookingRound = await repos.offeredSlotsRepo.listActiveByConversationId(conversation!.id, new Date());
    const position1 = bookingRound.find((s) => s.position === 1)!;
    await send(app, "5214778890199", "wamid.f2", "1");

    const bookedLead = await repos.leadsRepo.findById(lead.id);
    expect(bookedLead?.status).toBe("BOOKED");
    const originalBookedAt = bookedLead!.bookedAt;
    expect(originalBookedAt).toBeTruthy();
    expect(bookedLead!.meetingAt?.getTime()).toBe(position1.slotStart.getTime());
    const oldAppointment = await repos.appointmentsRepo.findActiveByLeadId(lead.id);
    expect(oldAppointment!.startsAt.getTime()).toBe(position1.slotStart.getTime());

    // Real reschedule flow -- request, then select the new offer's position 1 (the calendar's
    // next available slot, distinct from the original -- the original time is now Calendar-busy).
    await send(app, "5214778890199", "wamid.f3", "quiero reagendar");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");
    const rescheduleRound = await repos.offeredSlotsRepo.listActiveByConversationId(conversation!.id, new Date(), oldAppointment!.id);
    expect(rescheduleRound.length).toBeGreaterThan(0);
    const newPosition1 = rescheduleRound.find((s) => s.position === 1)!;
    expect(newPosition1.slotStart.getTime()).not.toBe(position1.slotStart.getTime()); // genuinely a different, fresh time

    await send(app, "5214778890199", "wamid.f4", "1");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKED");
    const newAppointment = await repos.appointmentsRepo.findActiveByLeadId(lead.id);
    expect(newAppointment?.rescheduledFrom).toBe(oldAppointment!.id);

    // The two properties under test, per the real production bug report:
    expect(finalLead?.meetingAt?.getTime()).toBe(newAppointment!.startsAt.getTime()); // synced to the NEW appointment
    expect(finalLead?.meetingAt?.getTime()).not.toBe(oldAppointment!.startsAt.getTime()); // never left at the OLD time
    expect(finalLead?.bookedAt?.getTime()).toBe(originalBookedAt!.getTime()); // preserved from the ORIGINAL booking, untouched by the reschedule
  });
});

describe("Phase 4C -- full in-memory E2E through the real webhook pipeline", () => {
  it("BOOKED -> quiero reagendar -> RESCHEDULE_REQUESTED -> 1 -> BOOKED with a NEW appointment, old RESCHEDULED, both history tables correct", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214778890004", "BOOKED");
    const oldAppointment = await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"),
      endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-e2e-old",
    });
    await repos.calendar.createEvent({ title: "Cita", description: "", start: oldAppointment.startsAt, end: oldAppointment.endsAt });

    await send(app, "5214778890004", "wamid.r4", "quiero reagendar");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");

    await send(app, "5214778890004", "wamid.r5", "1");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("BOOKED");
    const finalOld = await repos.appointmentsRepo.findById(oldAppointment.id);
    expect(finalOld?.status).toBe("RESCHEDULED");
    const newAppointment = await repos.appointmentsRepo.findActiveByLeadId(lead.id);
    expect(newAppointment?.rescheduledFrom).toBe(oldAppointment.id);
    expect(newAppointment?.id).not.toBe(oldAppointment.id);

    const leadHistory = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(leadHistory.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      ["BOOKED", "RESCHEDULE_REQUESTED"],
      ["RESCHEDULE_REQUESTED", "BOOKED"],
    ]);
    const appointmentHistory = await repos.appointmentStatusHistoryRepo.listByAppointmentId(oldAppointment.id);
    expect(appointmentHistory).toHaveLength(1);
    expect(appointmentHistory[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "RESCHEDULED" });

    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead.id);
    const messages = await repos.messagesRepo.listByConversationId(conversation!.id);
    const outbound = messages.filter((m) => m.direction === "OUTBOUND");
    expect(outbound.some((m) => m.body?.includes("puedo ayudarte a cambiar tu cita"))).toBe(true);
    expect(outbound.some((m) => m.body?.includes("tu cita fue reagendada"))).toBe(true);
  });

  it("cancellation during reschedule (item 13): RESCHEDULE_REQUESTED -> 'cancelar cita' -> CANCEL_PENDING -> '1' cancels the ORIGINAL appointment, never the reschedule", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214778890005", "BOOKED");
    const oldAppointment = await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"),
      endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City",
    });

    await send(app, "5214778890005", "wamid.r6", "quiero reagendar");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");

    await send(app, "5214778890005", "wamid.r7", "cancelar cita");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING");

    await send(app, "5214778890005", "wamid.r8", "1");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCELLED");
    expect((await repos.appointmentsRepo.findById(oldAppointment.id))?.status).toBe("CANCELLED");
  });

  it("Phase 4B regression: with reschedule ALSO enabled, a plain cancellation (no reschedule attempt) still works end to end", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214778890006", "BOOKED");
    const appointment = await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City" });

    await send(app, "5214778890006", "wamid.r9", "cancelar cita");
    await send(app, "5214778890006", "wamid.r10", "1");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCELLED");
    expect((await repos.appointmentsRepo.findById(appointment.id))?.status).toBe("CANCELLED");
  });

  it("Phase 3C regression: with reschedule enabled, the normal booking flow (QUALIFIED_A -> BOOKING_PENDING -> BOOKED) is untouched", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214778890007", "BOOKING_PENDING", { bookingStartedAt: new Date() });

    await send(app, "5214778890007", "wamid.r11", "hola");
    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead.id);
    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation!.id, new Date());
    expect(offered.length).toBeGreaterThan(0);

    await send(app, "5214778890007", "wamid.r12", "1");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
  });
});

describe("Phase 4C post-mortem -- item 13: the missing E2E (real booking, then reschedule, on the SAME conversation)", () => {
  it("real booking flow (offer -> select position 1 -> BOOKED) leaves an unexpired round with positions 2/3 still active; a subsequent reschedule request must NEVER reuse them -- it must create a brand new round tagged with the old appointment's id", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappRescheduleEnabled: true, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214778890099", "BOOKING_PENDING", { bookingStartedAt: new Date() });
    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead.id);

    // Real booking flow, through the real webhook pipeline -- no direct repo seeding.
    await send(app, "5214778890099", "wamid.pm1", "hola");
    const bookingRound = await repos.offeredSlotsRepo.listActiveByConversationId(conversation!.id, new Date());
    expect(bookingRound).toHaveLength(3);
    expect(bookingRound.every((s) => s.rescheduleContextId === undefined)).toBe(true);
    const originalRoundId = bookingRound[0].roundId;
    const position2Id = bookingRound.find((s) => s.position === 2)!.id;
    const position3Id = bookingRound.find((s) => s.position === 3)!.id;

    await send(app, "5214778890099", "wamid.pm2", "1"); // selects position 1 -- real booking

    const bookedLead = await repos.leadsRepo.findById(lead.id);
    expect(bookedLead?.status).toBe("BOOKED");
    const oldAppointment = await repos.appointmentsRepo.findActiveByLeadId(lead.id);
    expect(oldAppointment).not.toBeNull();

    // Positions 2/3 are STILL active (unselected, unexpired) at this point -- exactly the real
    // bug report's precondition.
    const stillActive = await repos.offeredSlotsRepo.listActiveByConversationId(conversation!.id, new Date());
    expect(stillActive.map((s) => s.id).sort()).toEqual([position2Id, position3Id].sort());

    // Now request a reschedule, through the real webhook pipeline, on the SAME conversation.
    await send(app, "5214778890099", "wamid.pm3", "quiero reagendar");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("RESCHEDULE_REQUESTED");

    const rescheduleRound = await repos.offeredSlotsRepo.listActiveByConversationId(conversation!.id, new Date(), oldAppointment!.id);
    expect(rescheduleRound.length).toBeGreaterThan(0); // a genuinely new round WAS created
    // NEVER the original booking round.
    expect(rescheduleRound.every((s) => s.roundId !== originalRoundId)).toBe(true);
    // NEVER positions 2/3 from the original booking round.
    const rescheduleSlotIds = new Set(rescheduleRound.map((s) => s.id));
    expect(rescheduleSlotIds.has(position2Id)).toBe(false);
    expect(rescheduleSlotIds.has(position3Id)).toBe(false);
    // Every new slot is tagged with the CURRENT reschedule episode's context.
    expect(rescheduleRound.every((s) => s.rescheduleContextId === oldAppointment!.id)).toBe(true);

    // The outbound message actually sent to WhatsApp reflects the NEW round's real times, never
    // the original booking round's leftover options.
    const messages = await repos.messagesRepo.listByConversationId(conversation!.id);
    const lastOutbound = messages.filter((m) => m.direction === "OUTBOUND").slice(-1)[0];
    expect(lastOutbound.body).toContain("¿Cuál te funciona mejor?");
  });
});
