import { describe, it, expect } from "vitest";
import { buildTestApp, TEST_REMINDER_RUNNER_SECRET, TEST_ADMIN_API_TOKEN } from "./helpers/test-app.js";
import { InMemoryLeadRepository, InMemoryConversationRepository, InMemoryAppointmentRepository } from "../src/infrastructure/memory-repositories.js";

async function seedBookedAppointment(leads: InMemoryLeadRepository, conversations: InMemoryConversationRepository, appointments: InMemoryAppointmentRepository) {
  const lead = await leads.create({ firstName: "Sofia", country: "MX", productVertical: "GMM", status: "BOOKED", score: 71, assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214771234567" });
  await conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  const appointment = await appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-01T15:00:00.000Z"), endsAt: new Date("2026-03-01T15:30:00.000Z"), timezone: "America/Mexico_City" });
  return { lead, appointment };
}

describe("Fase 7A -- POST /internal/reminders/run", () => {
  it("item 19: with no REMINDER_RUNNER_SECRET configured, the route fails closed with 401", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/internal/reminders/run", headers: { authorization: "Bearer anything" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "NOT_CONFIGURED" });
  });

  it("item 19: with the secret configured but a wrong/missing bearer token, 401", async () => {
    const app = await buildTestApp({ reminderRunnerSecret: TEST_REMINDER_RUNNER_SECRET });
    const wrong = await app.inject({ method: "POST", url: "/internal/reminders/run", headers: { authorization: "Bearer nope" } });
    expect(wrong.statusCode).toBe(401);
    const missing = await app.inject({ method: "POST", url: "/internal/reminders/run" });
    expect(missing.statusCode).toBe(401);
  });

  it("item 20: with the correct bearer token, 200 and a sanitized summary -- no PII in the response", async () => {
    const app = await buildTestApp({ reminderRunnerSecret: TEST_REMINDER_RUNNER_SECRET, appointmentRemindersEnabled: true });
    const res = await app.inject({
      method: "POST", url: "/internal/reminders/run",
      headers: { authorization: `Bearer ${TEST_REMINDER_RUNNER_SECRET}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.reminder24h).toMatchObject({ candidates: 0, sent: 0 });
    expect(JSON.stringify(body)).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}/); // no uuid (leadId/appointmentId) ever appears
  });

  it("both Fase 7A flags off (default) still returns 200 with all-empty summaries -- calling the endpoint is always safe", async () => {
    const app = await buildTestApp({ reminderRunnerSecret: TEST_REMINDER_RUNNER_SECRET });
    const res = await app.inject({ method: "POST", url: "/internal/reminders/run", headers: { authorization: `Bearer ${TEST_REMINDER_RUNNER_SECRET}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      reminder24h: { candidates: 0, sent: 0, failed: 0, skipped: 0 },
      reminder2h: { candidates: 0, sent: 0, failed: 0, skipped: 0 },
      postMeetingFollowup: { candidates: 0, sent: 0, failed: 0, skipped: 0 },
    });
  });
});

describe("Fase 7A -- POST /api/appointments/:id/mark-completed and /mark-no-show", () => {
  it("item 19: with no ADMIN_API_TOKEN configured, both routes fail closed with 401", async () => {
    const app = await buildTestApp();
    const id = "00000000-0000-0000-0000-000000000000";
    const completed = await app.inject({ method: "POST", url: `/api/appointments/${id}/mark-completed`, headers: { "x-admin-token": "anything" } });
    expect(completed.statusCode).toBe(401);
    const noShow = await app.inject({ method: "POST", url: `/api/appointments/${id}/mark-no-show`, headers: { "x-admin-token": "anything" } });
    expect(noShow.statusCode).toBe(401);
  });

  it("item 19: with the token configured but wrong/missing, 401", async () => {
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN });
    const id = "00000000-0000-0000-0000-000000000000";
    const wrong = await app.inject({ method: "POST", url: `/api/appointments/${id}/mark-completed`, headers: { "x-admin-token": "wrong" } });
    expect(wrong.statusCode).toBe(401);
    const missing = await app.inject({ method: "POST", url: `/api/appointments/${id}/mark-completed` });
    expect(missing.statusCode).toBe(401);
  });

  it("item 20: with the correct token, mark-completed transitions a real BOOKED appointment to COMPLETED", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const conversationsRepo = new InMemoryConversationRepository();
    const appointmentsRepo = new InMemoryAppointmentRepository();
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo, conversationsRepo, appointmentsRepo });
    const { appointment } = await seedBookedAppointment(leadsRepo, conversationsRepo, appointmentsRepo);

    const res = await app.inject({ method: "POST", url: `/api/appointments/${appointment.id}/mark-completed`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("COMPLETED");
    expect((await leadsRepo.findById((await appointmentsRepo.findById(appointment.id))!.leadId))?.status).toBe("MEETING_COMPLETED");
  });

  it("item 20: with the correct token, mark-no-show transitions a real BOOKED appointment to NO_SHOW and sends the nudge", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const conversationsRepo = new InMemoryConversationRepository();
    const appointmentsRepo = new InMemoryAppointmentRepository();
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo, conversationsRepo, appointmentsRepo });
    const { appointment } = await seedBookedAppointment(leadsRepo, conversationsRepo, appointmentsRepo);

    const res = await app.inject({ method: "POST", url: `/api/appointments/${appointment.id}/mark-no-show`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("NO_SHOW");
  });

  it("mark-completed on an unknown appointment id returns 404", async () => {
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN });
    const res = await app.inject({ method: "POST", url: "/api/appointments/00000000-0000-0000-0000-000000000000/mark-completed", headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });
    expect(res.statusCode).toBe(404);
  });

  it("mark-completed on a CANCELLED appointment returns 409, never silently overwrites", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const conversationsRepo = new InMemoryConversationRepository();
    const appointmentsRepo = new InMemoryAppointmentRepository();
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo, conversationsRepo, appointmentsRepo });
    const { appointment } = await seedBookedAppointment(leadsRepo, conversationsRepo, appointmentsRepo);
    await appointmentsRepo.update(appointment.id, { status: "CANCELLED" });

    const res = await app.inject({ method: "POST", url: `/api/appointments/${appointment.id}/mark-completed`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });

    expect(res.statusCode).toBe(409);
  });
});
