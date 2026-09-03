import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryAppointmentRepository, InMemoryLeadScoreRepository, InMemoryQualificationAnswerRepository,
  InMemoryBookingAttemptRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository, InMemoryAppointmentCancellationRepository,
  InMemoryAppointmentRescheduleRepository, InMemoryFiscalLeadScoreRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeHubSpotCRMProvider } from "../src/infrastructure/fake-hubspot-crm-provider.js";
import type { CalendarProvider, CalendarEventInput } from "../src/application/ports.js";
import {
  BOOKED_GENERIC_INBOUND_MESSAGE, PAST_BOOKED_GENERIC_INBOUND_MESSAGE, buildQualifiedLeadTopicAnswer,
  buildQualifiedLeadOptionsMessage, buildFiscalContextWelcomeMessage, QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE,
  buildQualifiedLeadAskQuestionMessage,
} from "../src/domain/message-templates.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";
import type { FiscalLeadScore } from "../src/domain/fiscal-lead-score.js";

/**
 * Fase 6E.2 -- fixes the production loop where a lead with a stale (past) BOOKED appointment
 * typed "agendar" (exactly what PAST_BOOKED_GENERIC_INBOUND_MESSAGE instructed) and got the SAME
 * message back forever. Root cause: isNewBookingRequest's phrase list required "quiero agendar"/
 * "agendar (una) cita", never matching a bare "agendar" -- see new-booking-intent-detection.ts's
 * doc comment. Also: WhatsAppPastBookedRecoveryHandler had zero awareness of the qualified
 * router's topic/options/identity keywords, so a real question also looped.
 *
 * Covers the task's "11. TESTS" list, numbered 1-19 below.
 */

class CountingCalendarProvider implements CalendarProvider {
  createEventCalls = 0;
  deleteEventCalls = 0;
  constructor(private readonly inner: CalendarProvider) {}
  async getAvailableSlots(from: Date, to: Date, durationMinutes: number) { return this.inner.getAvailableSlots(from, to, durationMinutes); }
  async isSlotAvailable(start: Date, end: Date) { return this.inner.isSlotAvailable(start, end); }
  async createEvent(input: CalendarEventInput) { this.createEventCalls++; return this.inner.createEvent(input); }
  async deleteEvent(eventId: string) { this.deleteEventCalls++; return this.inner.deleteEvent(eventId); }
}

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
          contacts: [{ profile: { name: overrides.name ?? "Ana" }, wa_id: overrides.from ?? "5214779980001" }],
          messages: [{ from: overrides.from ?? "5214779980001", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
        },
      }],
    }],
  });
}

function buildRepos(calendar: CalendarProvider = new FakeCalendarProvider()) {
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
    fiscalLeadScoresRepo: new InMemoryFiscalLeadScoreRepository(),
    calendar,
  };
}

async function send(app: Awaited<ReturnType<typeof buildTestApp>>, from: string, id: string, body: string) {
  const payload = textWebhookBody({ from, id, body });
  return app.inject({
    method: "POST", url: "/webhooks/whatsapp", payload,
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET) },
  });
}

async function createLeadAtStatus(repos: ReturnType<typeof buildRepos>, whatsappUserId: string, status: LeadStatus, overrides: Partial<Lead> = {}) {
  const lead = await repos.leadsRepo.create({
    country: "MX", productVertical: "PATRIMONIAL", status: "NEW", score: 74, scoreClass: "B",
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId, firstName: "Juan",
    qualifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  });
  await repos.leadsRepo.update(lead.id, { status, ...overrides });
  const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead: (await repos.leadsRepo.findById(lead.id))!, conversation };
}

async function seedFiscalScore(fiscalLeadScoresRepo: InMemoryFiscalLeadScoreRepository, leadId: string) {
  return fiscalLeadScoresRepo.tryCreate({
    leadId, submissionId: "sub-1", score: 90, scoreClass: "HOT", version: "fiscal_v1",
    reasons: [{ code: "MONTHLY_INCOME_150K_PLUS", points: 40 }],
    monthlyIncomeBand: "150K_PLUS", annualContributionBand: "180K_PLUS", hasPpr: false, filesAnnualReturn: true,
  } satisfies Omit<FiscalLeadScore, "id" | "createdAt">);
}

async function outboundMessages(repos: ReturnType<typeof buildRepos>, conversationId: string) {
  const messages = await repos.messagesRepo.listByConversationId(conversationId);
  return messages.filter((m) => m.direction === "OUTBOUND");
}

const PAST_STARTS_AT = new Date("2020-01-15T15:00:00.000Z");
const PAST_ENDS_AT = new Date("2020-01-15T15:30:00.000Z");

describe("Fase 6E.2 -- past-booked rebook routing fix", () => {
  it("1. past booking + bare 'agendar' enters the real booking handler (the reported bug)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779980001", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980001", "wamid.1a", "Agendar");
    const first = await outboundMessages(repos, conversation.id);
    expect(first[0].body).not.toBe(PAST_BOOKED_GENERIC_INBOUND_MESSAGE); // the bug: same message again

    await send(app, "5214779980001", "wamid.1b", "Agendar"); // retry, exactly as reported
    const second = await outboundMessages(repos, conversation.id);
    // Second "agendar" is no longer meaningful (lead already left BOOKED for BOOKING_PENDING),
    // but the KEY assertion is the first reply already broke the loop:
    expect(first[0].body).toContain("Tengo estos horarios disponibles");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKING_PENDING");
    void second;
  });

  it("2. past booking + 'quiero agendar' enters the real booking handler (already worked, still works)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779980002", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980002", "wamid.2a", "Quiero agendar");

    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKING_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toContain("Tengo estos horarios disponibles");
  });

  it("3. past booking + WHATSAPP_BOOKING_ENABLED=false uses the safe (unchanged prior) fallback -- never a fake booking", async () => {
    const repos = buildRepos();
    // rescheduleHandler + cancellationHandler both present (unrelated to this fix) is what makes
    // whatsapp-inbound-service.ts's BOOKED-generic-fallback branch send a reply at all -- same
    // setup as whatsapp-past-booked-recovery-e2e.test.ts's own "flag-off regression" test.
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: false, whatsappRescheduleEnabled: true, whatsappCancellationEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779980003", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980003", "wamid.3a", "Agendar");

    // With the flag off, pastBookedRecoveryHandler is never constructed -- routed exactly as
    // before this hardening pass (unchanged behavior, same as the flag-off regression test in
    // whatsapp-past-booked-recovery-e2e.test.ts).
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toBe(BOOKED_GENERIC_INBOUND_MESSAGE);
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED");
  });

  it("4. past booking + PPR question gets a real PPR answer, not the past-booked loop", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779980004", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980004", "wamid.4a", "¿Cómo funciona el PPR?");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toBe(buildQualifiedLeadTopicAnswer("PPR"));
    expect(outbound[0].body).not.toBe(PAST_BOOKED_GENERIC_INBOUND_MESSAGE);
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKED"); // no state change
  });

  it("5. past booking + GMM question gets a real GMM answer, not the past-booked loop", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779980005", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980005", "wamid.5a", "¿Qué cubre el GMM?");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toBe(buildQualifiedLeadTopicAnswer("GMM"));
  });

  it("6. past booking + 'quiero conocer opciones' shows the options menu, not the past-booked loop", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779980006", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980006", "wamid.6a", "quiero conocer opciones");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toBe(buildQualifiedLeadOptionsMessage(false));
    expect(outbound[0].metadata).toEqual({ expectedIntent: "QUALIFIED_OPTIONS_MENU" });
  });

  it("7. genuinely unrecognized text does NOT loop indefinitely -- the fallback is shown once per unrecognized turn, never confused with a recognized reply", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779980007", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980007", "wamid.7a", "Hola"); // unrecognized -> fallback #1
    await send(app, "5214779980007", "wamid.7b", "Agendar"); // NOW recognized -> real booking, breaks the loop

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(2);
    expect(outbound[0].body).toBe(PAST_BOOKED_GENERIC_INBOUND_MESSAGE);
    expect(outbound[0].metadata).toEqual({ expectedIntent: "PAST_BOOKED_REACTIVATION" });
    expect(outbound[1].body).not.toBe(PAST_BOOKED_GENERIC_INBOUND_MESSAGE);
    expect(outbound[1].body).toContain("Tengo estos horarios disponibles");
  });

  it("8. the original past appointment remains historical -- never mutated, never reused as if it were the new one", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779980008", "BOOKED");
    const staleAppointment = await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980008", "wamid.8a", "Agendar");
    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date());
    await send(app, "5214779980008", "wamid.8b", "1");

    const reloadedStale = await repos.appointmentsRepo.findById(staleAppointment.id);
    expect(reloadedStale?.status).toBe("BOOKED");
    expect(reloadedStale?.startsAt.getTime()).toBe(PAST_STARTS_AT.getTime()); // untouched
    void offered;
  });

  it("9. a brand-new appointment row is created for the rebooking -- never overwrites/reuses the stale one", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779980009", "BOOKED");
    const staleAppointment = await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980009", "wamid.9a", "Agendar");
    await send(app, "5214779980009", "wamid.9b", "1");

    const all = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    expect(all).toHaveLength(2); // the stale one + the new one
    const newAppt = all.find((a) => a.id !== staleAppointment.id)!;
    expect(newAppt.status).toBe("BOOKED");
    // Genuinely a different (future-relative-to-the-stale-one) slot, never the 2020 stale date --
    // compared against PAST_STARTS_AT rather than Date.now() to avoid wall-clock flakiness.
    expect(newAppt.startsAt.getTime()).toBeGreaterThan(PAST_STARTS_AT.getTime());
    void conversation;
  });

  it("10. offered slots for the rebooking come exclusively from CalendarProvider -- never invented", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779980010", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    const busyStart = new Date(Date.now() + 3 * 86400000);
    const busyEnd = new Date(busyStart.getTime() + 30 * 60000);
    await repos.calendar.createEvent({ title: "busy", description: "", start: busyStart, end: busyEnd });

    await send(app, "5214779980010", "wamid.10a", "Agendar");

    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date());
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.length).toBeLessThanOrEqual(3);
    expect(offered.every((slot) => !(slot.slotStart < busyEnd && slot.slotEnd > busyStart))).toBe(true);
    void lead;
  });

  it("11. a duplicate webhook delivery (same provider_message_id) never creates two appointments", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214779980011", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980011", "wamid.dup11", "Agendar");
    await send(app, "5214779980011", "wamid.dup11", "Agendar"); // exact redelivery, same id

    const all = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    expect(all.filter((a) => a.status === "BOOKED" && a.startsAt.getTime() !== PAST_STARTS_AT.getTime())).toHaveLength(0); // no new booking yet, offer only sent once
  });

  it("12. a duplicate slot-selection webhook never creates two appointments", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214779980012", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await send(app, "5214779980012", "wamid.12a", "Agendar");

    await send(app, "5214779980012", "wamid.dup12", "1");
    await send(app, "5214779980012", "wamid.dup12", "1"); // exact redelivery of the slot selection

    const all = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    const newBookings = all.filter((a) => a.startsAt.getTime() !== PAST_STARTS_AT.getTime());
    expect(newBookings).toHaveLength(1); // never double-booked by the retry
  });

  it("13. Lía keeps using the lead's firstName through the rebooking flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779980013", "BOOKED", { firstName: "Juan" });
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980013", "wamid.13a", "Agendar");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toContain("Juan");
  });

  it("14. the Fase 6E.1 nested qualified-options-menu fix is untouched -- MAIN -> OPTIONS -> digit still resolves correctly for a QUALIFIED_A lead", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: false });
    const { conversation } = await createLeadAtStatus(repos, "5214779980014", "QUALIFIED_A");
    await send(app, "5214779980014", "wamid.14a", "Hola, tengo una duda"); // main menu
    await send(app, "5214779980014", "wamid.14b", "2"); // options menu

    await send(app, "5214779980014", "wamid.14c", "1");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[2].body).toBe(buildQualifiedLeadTopicAnswer("SAVINGS")); // no fiscal context -> savings first
    expect(outbound[2].body).not.toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
  });

  it("15. HubSpot fiscal sync is unaffected by this WhatsApp-router-only fix", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const res = await app.inject({
      method: "POST", url: "/api/leads",
      payload: {
        firstName: "Ana", phone: "4779980015", email: "sixteen@example.com", source: "WEB_FISCAL_CALCULATOR",
        privacyAccepted: true, consentContact: true,
        fiscalCalculator: {
          monthlyIncome: 160000, annualContribution: 200000,
          deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
          calculation: { annualIncome: 1920000, pprDeductionLimit: 213973.2, effectivePprContribution: 200000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 48000, estimatedTaxBenefitMax: 72000 },
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(hubspotCrm.contacts).toHaveLength(1);
  });

  it("16. fiscal context (fiscal_v1) for a past-booked lead is untouched by the rebooking flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214779980016", "BOOKED", { source: "WEB_FISCAL_CALCULATOR" });
    await seedFiscalScore(repos.fiscalLeadScoresRepo, lead.id);
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980016", "wamid.16a", "Agendar");

    const rows = await repos.fiscalLeadScoresRepo.listByLeadId(lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].scoreClass).toBe("HOT");
  });

  it("17. lifecycle integrity: score/scoreClass/qualifiedAt survive the full rebooking flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214779980017", "BOOKED", { score: 74, scoreClass: "B" });
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980017", "wamid.17a", "Agendar");
    await send(app, "5214779980017", "wamid.17b", "1");

    const after = await repos.leadsRepo.findById(lead.id);
    expect(after?.score).toBe(74);
    expect(after?.scoreClass).toBe("B");
    expect(after?.qualifiedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(after?.status).toBe("BOOKED"); // new booking completed -> back to BOOKED
  });

  it("18. DO_NOT_CONTACT stays fully suppressed -- the past-booked recovery handler never runs for it", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779980018", "DO_NOT_CONTACT");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980018", "wamid.18a", "Agendar");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(0);
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("DO_NOT_CONTACT");
  });

  it("19. HUMAN_HANDOFF stays fully suppressed -- the past-booked recovery handler never runs for it", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779980019", "HUMAN_HANDOFF");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779980019", "wamid.19a", "Agendar");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(0);
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
  });
});
