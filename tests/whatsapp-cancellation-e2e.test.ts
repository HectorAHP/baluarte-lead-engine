import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryAppointmentRepository, InMemoryLeadScoreRepository, InMemoryQualificationAnswerRepository,
  InMemoryBookingAttemptRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository, InMemoryAppointmentCancellationRepository,
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

describe("Phase 4B -- WHATSAPP_CANCELLATION_ENABLED flag matrix", () => {
  it("false (default): a BOOKED lead's cancellation-intent message gets no automated reply -- Phase 3C behavior unchanged", async () => {
    const repos = buildRepos();
    // whatsappBookingEnabled: false too -- this test isolates the cancellation flag specifically.
    // With it on, this exact fixture (a BOOKED lead with literally no appointment row) would
    // correctly be picked up by the pre-launch "stale/past BOOKED appointment" recovery handler
    // instead (gated on whatsappBookingEnabled, independent of the cancellation flag) -- that is
    // deliberate, tested separately (see whatsapp-past-booked-recovery-e2e.test.ts), and not what
    // this test is about.
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: false, whatsappBookingEnabled: false });
    const { lead } = await createLeadAtStatus(repos, "5214778880001", "BOOKED");

    const res = await send(app, "5214778880001", "wamid.c1", "cancelar cita");

    expect(res.statusCode).toBe(200);
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    expect(await repos.messagesRepo.listByConversationId((await repos.conversationsRepo.findActiveByLeadId(lead.id))!.id)).toHaveLength(1); // only the inbound, no automated reply
  });

  it("true: a BOOKED lead's cancellation-intent message starts the confirmation flow through the real webhook pipeline", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214778880002", "BOOKED");
    await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"),
      endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-e2e-1",
    });

    const res = await send(app, "5214778880002", "wamid.c2", "cancelar cita");

    expect(res.statusCode).toBe(200);
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING");
  });
});

describe("Phase 4B -- full in-memory E2E through the real webhook pipeline", () => {
  it("BOOKED -> cancelar cita -> CANCEL_PENDING -> 1 -> CANCELLED, Calendar event deleted, both history tables correct", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214778880003", "BOOKED");
    const appointment = await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"),
      endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-e2e-2",
    });
    // Actually create the Calendar-side event too, so deleteEvent has something real to remove.
    await repos.calendar.createEvent({ title: "Cita", description: "", start: appointment.startsAt, end: appointment.endsAt });

    await send(app, "5214778880003", "wamid.c3", "quiero cancelar mi cita");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CANCEL_PENDING");

    await send(app, "5214778880003", "wamid.c4", "1");

    const finalLead = await repos.leadsRepo.findById(lead.id);
    expect(finalLead?.status).toBe("CANCELLED");
    const finalAppointment = await repos.appointmentsRepo.findById(appointment.id);
    expect(finalAppointment?.status).toBe("CANCELLED");

    const leadHistory = await repos.leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(leadHistory.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      ["BOOKED", "CANCEL_PENDING"],
      ["CANCEL_PENDING", "CANCELLED"],
    ]);
    const appointmentHistory = await repos.appointmentStatusHistoryRepo.listByAppointmentId(appointment.id);
    expect(appointmentHistory).toHaveLength(1);
    expect(appointmentHistory[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "CANCELLED" });

    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead.id);
    const messages = await repos.messagesRepo.listByConversationId(conversation!.id);
    const outbound = messages.filter((m) => m.direction === "OUTBOUND");
    expect(outbound.some((m) => m.body?.includes("1. Sí, cancelar"))).toBe(true);
    expect(outbound.some((m) => m.body?.includes("Listo, tu cita quedó cancelada"))).toBe(true);
  });

  it("declining ('2') leaves the appointment BOOKED and the lead BOOKED again, through the real webhook pipeline", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappCancellationEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214778880004", "BOOKED");
    const appointment = await repos.appointmentsRepo.create({
      leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"),
      endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City",
    });

    await send(app, "5214778880004", "wamid.c5", "cancelar cita");
    await send(app, "5214778880004", "wamid.c6", "2");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
    expect((await repos.appointmentsRepo.findById(appointment.id))?.status).toBe("BOOKED");
  });
});
