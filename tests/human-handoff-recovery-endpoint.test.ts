import { createHmac } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { buildTestApp, TEST_ADMIN_API_TOKEN, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import {
  InMemoryLeadRepository, InMemoryAppointmentRepository, InMemoryConversationRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryMessageRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";

/**
 * Fase 7E -- POST /api/leads/:id/recover-handoff. No production data anywhere in this file;
 * every lead/appointment fixture below is synthetic.
 */
function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
function textWebhookBody(from: string, id: string, body: string) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          contacts: [{ profile: { name: "Ana" }, wa_id: from }],
          messages: [{ from, id, type: "text", text: { body } }],
        },
      }],
    }],
  });
}

const UNKNOWN_ID = "00000000-0000-0000-0000-000000000000";

describe("Fase 7E -- POST /api/leads/:id/recover-handoff", () => {
  // item 10/11/12 -- auth
  it("item 10: with no ADMIN_API_TOKEN configured, fails closed with 401", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: `/api/leads/${UNKNOWN_ID}/recover-handoff`, headers: { "x-admin-token": "anything" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "NOT_CONFIGURED" });
  });

  it("item 11: with the token configured but wrong/missing, 401", async () => {
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN });
    const wrong = await app.inject({ method: "POST", url: `/api/leads/${UNKNOWN_ID}/recover-handoff`, headers: { "x-admin-token": "wrong" } });
    expect(wrong.statusCode).toBe(401);
    const missing = await app.inject({ method: "POST", url: `/api/leads/${UNKNOWN_ID}/recover-handoff` });
    expect(missing.statusCode).toBe(401);
  });

  it("item 12: with the correct token, an unknown lead id returns 404", async () => {
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN });
    const res = await app.inject({ method: "POST", url: `/api/leads/${UNKNOWN_ID}/recover-handoff`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "LEAD_NOT_FOUND" });
  });

  it("token is never echoed or logged in the response body", async () => {
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN });
    const res = await app.inject({ method: "POST", url: `/api/leads/${UNKNOWN_ID}/recover-handoff`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });
    expect(JSON.stringify(res.json())).not.toContain(TEST_ADMIN_API_TOKEN);
  });

  // Fase 7E.2 §5/§8 items 4/5 -- authentication happens strictly BEFORE any repository access.
  // Proven with spies, not inferred from reading the code -- a real UUID id is used so the ONLY
  // reason findById would ever be skipped is the auth check itself returning early.
  describe("order of operations: auth before any data access (spied, not assumed)", () => {
    it("item 4: an unauthenticated request (no token) never queries the lead repository", async () => {
      const leadsRepo = new InMemoryLeadRepository();
      const findByIdSpy = vi.spyOn(leadsRepo, "findById");
      const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo });

      const res = await app.inject({ method: "POST", url: `/api/leads/${UNKNOWN_ID}/recover-handoff` });

      expect(res.statusCode).toBe(401);
      expect(findByIdSpy).not.toHaveBeenCalled();
    });

    it("item 5: a wrong-token request never queries the lead repository", async () => {
      const leadsRepo = new InMemoryLeadRepository();
      const findByIdSpy = vi.spyOn(leadsRepo, "findById");
      const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo });

      const res = await app.inject({ method: "POST", url: `/api/leads/${UNKNOWN_ID}/recover-handoff`, headers: { "x-admin-token": "wrong" } });

      expect(res.statusCode).toBe(401);
      expect(findByIdSpy).not.toHaveBeenCalled();
    });

    it("a request with the CORRECT token DOES reach the repository -- confirms the spy itself is wired correctly, not just silent", async () => {
      const leadsRepo = new InMemoryLeadRepository();
      const findByIdSpy = vi.spyOn(leadsRepo, "findById");
      const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo });

      const res = await app.inject({ method: "POST", url: `/api/leads/${UNKNOWN_ID}/recover-handoff`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });

      expect(res.statusCode).toBe(404); // unknown id -> NOT_FOUND, but only AFTER the repository was actually consulted
      expect(findByIdSpy).toHaveBeenCalledTimes(1);
      expect(findByIdSpy).toHaveBeenCalledWith(UNKNOWN_ID);
    });
  });

  // item 13/14 -- no user-controlled destination
  it("items 13/14: the request body is completely ignored -- targetStatus/eventType/appointmentId in the body never influence the outcome", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const appointmentsRepo = new InMemoryAppointmentRepository();
    const leadStatusHistoryRepo = new InMemoryLeadStatusHistoryRepository();
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo, appointmentsRepo, leadStatusHistoryRepo });
    const created = await leadsRepo.create({ country: "MX", productVertical: "PATRIMONIAL", status: "BOOKED", score: 74, scoreClass: "A", assignedAdvisor: "Hector Herrera", consentContact: true });
    const lead = await leadsRepo.update(created.id, { status: "HUMAN_HANDOFF" });
    // No appointment, scoreClass "A" on file -> the ONLY safe destination is QUALIFIED_A. The
    // body below tries to force something completely different (DO_NOT_CONTACT, a fabricated
    // eventType, an unrelated appointmentId) -- none of it may have any effect.
    const res = await app.inject({
      method: "POST", url: `/api/leads/${lead.id}/recover-handoff`,
      headers: { "x-admin-token": TEST_ADMIN_API_TOKEN, "content-type": "application/json" },
      payload: JSON.stringify({ targetStatus: "DO_NOT_CONTACT", eventType: "FORGED_EVENT", appointmentId: "11111111-1111-1111-1111-111111111111" }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, outcome: "RECOVERED", status: "QUALIFIED_A" });
    expect((await leadsRepo.findById(lead.id))?.status).toBe("QUALIFIED_A"); // never DO_NOT_CONTACT
    const history = await leadStatusHistoryRepo.listByLeadId(lead.id);
    expect(history[history.length - 1].eventType).toBe("HANDOFF_MANUALLY_RECOVERED"); // never "FORGED_EVENT"
  });

  // item 5/12 (DO_NOT_CONTACT) and AMBIGUOUS, at the HTTP layer
  it("a DO_NOT_CONTACT lead gets 403, never touched", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo });
    const created = await leadsRepo.create({ country: "MX", productVertical: "PATRIMONIAL", status: "BOOKED", score: 0, assignedAdvisor: "Hector Herrera", consentContact: true });
    const lead = await leadsRepo.update(created.id, { status: "DO_NOT_CONTACT" });

    const res = await app.inject({ method: "POST", url: `/api/leads/${lead.id}/recover-handoff`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "DO_NOT_CONTACT_PROTECTED" });
    expect((await leadsRepo.findById(lead.id))?.status).toBe("DO_NOT_CONTACT");
  });

  it("a lead that was never HUMAN_HANDOFF gets 409 NOT_ELIGIBLE", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo });
    const lead = await leadsRepo.create({ country: "MX", productVertical: "PATRIMONIAL", status: "QUALIFIED_A", score: 74, scoreClass: "A", assignedAdvisor: "Hector Herrera", consentContact: true });

    const res = await app.inject({ method: "POST", url: `/api/leads/${lead.id}/recover-handoff`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "NOT_ELIGIBLE", currentStatus: "QUALIFIED_A" });
  });

  it("multiple active appointments -> 409 RECOVERY_AMBIGUOUS_APPOINTMENT_STATE, never guessed", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const appointmentsRepo = new InMemoryAppointmentRepository();
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo, appointmentsRepo });
    const created = await leadsRepo.create({ country: "MX", productVertical: "PATRIMONIAL", status: "BOOKED", score: 74, assignedAdvisor: "Hector Herrera", consentContact: true });
    const lead = await leadsRepo.update(created.id, { status: "HUMAN_HANDOFF" });
    const futureA = new Date(Date.now() + 24 * 3600_000);
    const futureB = new Date(Date.now() + 48 * 3600_000);
    await appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: futureA, endsAt: new Date(futureA.getTime() + 1800_000), timezone: "America/Mexico_City" });
    await appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: futureB, endsAt: new Date(futureB.getTime() + 1800_000), timezone: "America/Mexico_City" });

    const res = await app.inject({ method: "POST", url: `/api/leads/${lead.id}/recover-handoff`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "RECOVERY_AMBIGUOUS_APPOINTMENT_STATE" });
  });

  it("a second call after a successful recovery returns 200 ALREADY_RECOVERED, never a duplicate history row", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const leadStatusHistoryRepo = new InMemoryLeadStatusHistoryRepository();
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo, leadStatusHistoryRepo });
    const created = await leadsRepo.create({ country: "MX", productVertical: "PATRIMONIAL", status: "BOOKED", score: 74, scoreClass: "A", assignedAdvisor: "Hector Herrera", consentContact: true });
    const lead = await leadsRepo.update(created.id, { status: "HUMAN_HANDOFF" });

    const first = await app.inject({ method: "POST", url: `/api/leads/${lead.id}/recover-handoff`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });
    expect(first.statusCode).toBe(200);
    expect(first.json().outcome).toBe("RECOVERED");

    const second = await app.inject({ method: "POST", url: `/api/leads/${lead.id}/recover-handoff`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ ok: true, outcome: "ALREADY_RECOVERED", status: "QUALIFIED_A" });

    const history = (await leadStatusHistoryRepo.listByLeadId(lead.id)).filter((h) => h.eventType === "HANDOFF_MANUALLY_RECOVERED");
    expect(history).toHaveLength(1);
  });

  // item 15 -- no WhatsApp outbound during recovery
  it("item 15: recovery never sends any WhatsApp message", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo, messaging });
    const created = await leadsRepo.create({ country: "MX", productVertical: "PATRIMONIAL", status: "BOOKED", score: 74, scoreClass: "A", assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214771234567" });
    const lead = await leadsRepo.update(created.id, { status: "HUMAN_HANDOFF" });

    await app.inject({ method: "POST", url: `/api/leads/${lead.id}/recover-handoff`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });

    expect(messaging.sentTexts).toHaveLength(0);
    expect(messaging.sentTemplates).toHaveLength(0);
  });

  // item 16 -- the next inbound WhatsApp message no longer falls into suppressed-lead-check
  it("item 16: after recovery, the lead's next inbound WhatsApp message is processed normally, not suppressed", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const conversationsRepo = new InMemoryConversationRepository();
    const messagesRepo = new InMemoryMessageRepository();
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo, conversationsRepo, messagesRepo });
    const created = await leadsRepo.create({
      country: "MX", productVertical: "PATRIMONIAL", status: "BOOKED", score: 74, scoreClass: "A",
      assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214771234567", firstName: "Ana",
    });
    const lead = await leadsRepo.update(created.id, { status: "HUMAN_HANDOFF" });
    // Deliberately left HUMAN_HANDOFF -- whatsapp-inbound-service.ts's own conversation-resolution
    // never reuses a non-ACTIVE conversation, so the inbound below resolves into a BRAND NEW
    // conversation regardless of recovery (same as it would for any other non-ACTIVE conversation
    // status) -- this is why the assertion below looks up the conversation fresh via
    // findActiveByLeadId rather than assuming this exact row gets reused.
    await conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "HUMAN_HANDOFF" });

    const recoverRes = await app.inject({ method: "POST", url: `/api/leads/${lead.id}/recover-handoff`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });
    expect(recoverRes.statusCode).toBe(200);
    expect(recoverRes.json().status).toBe("QUALIFIED_A"); // no appointment on file -> Caso C

    const body = textWebhookBody("5214771234567", "wamid.recovery-test-1", "Hola de nuevo");
    const webhookRes = await app.inject({
      method: "POST", url: "/webhooks/whatsapp", payload: body,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body, TEST_META_APP_SECRET) },
    });
    expect(webhookRes.statusCode).toBe(200);

    const activeConversation = await conversationsRepo.findActiveByLeadId(lead.id);
    expect(activeConversation).not.toBeNull();
    const outbound = (await messagesRepo.listByConversationId(activeConversation!.id)).filter((m) => m.direction === "OUTBOUND");
    // The exact reply copy isn't the point here -- the point is that a reply exists at all,
    // proving wasAlreadySuppressed's "lead already DO_NOT_CONTACT or HUMAN_HANDOFF" branch was
    // never taken this time (that branch never persists an outbound reply).
    expect(outbound.length).toBeGreaterThan(0);
  });

  // item 17 -- past appointment recovery re-enters the existing past-booked-recovery flow
  it("item 17: after recovering a past-appointment lead to BOOKING_PENDING, a new-booking-intent message is handled by the normal booking flow, not suppressed", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const appointmentsRepo = new InMemoryAppointmentRepository();
    const conversationsRepo = new InMemoryConversationRepository();
    const messagesRepo = new InMemoryMessageRepository();
    const app = await buildTestApp({
      adminApiToken: TEST_ADMIN_API_TOKEN, leadsRepo, appointmentsRepo, conversationsRepo, messagesRepo,
      whatsappBookingEnabled: true,
    });
    const created = await leadsRepo.create({
      country: "MX", productVertical: "PATRIMONIAL", status: "BOOKED", score: 74, scoreClass: "A",
      assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214771234567",
    });
    const lead = await leadsRepo.update(created.id, { status: "HUMAN_HANDOFF" });
    // Same note as item 16 above: this conversation is never reused (non-ACTIVE status) -- the
    // webhook below resolves into a brand new one, looked up fresh via findActiveByLeadId.
    await conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "HUMAN_HANDOFF" });
    const past = new Date(Date.now() - 24 * 3600_000);
    await appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: past, endsAt: new Date(past.getTime() + 1800_000), timezone: "America/Mexico_City" });

    const recoverRes = await app.inject({ method: "POST", url: `/api/leads/${lead.id}/recover-handoff`, headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });
    expect(recoverRes.statusCode).toBe(200);
    expect(recoverRes.json().status).toBe("BOOKING_PENDING");

    const body = textWebhookBody("5214771234567", "wamid.recovery-test-2", "Agendar");
    await app.inject({
      method: "POST", url: "/webhooks/whatsapp", payload: body,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body, TEST_META_APP_SECRET) },
    });

    const activeConversation = await conversationsRepo.findActiveByLeadId(lead.id);
    expect(activeConversation).not.toBeNull();
    const outbound = (await messagesRepo.listByConversationId(activeConversation!.id)).filter((m) => m.direction === "OUTBOUND");
    expect(outbound.length).toBeGreaterThan(0); // not suppressed -- the past-booked-recovery flow got to reply
  });
});
