import { randomUUID, createHmac } from "node:crypto";
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
import type { CalendarProvider } from "../src/application/ports.js";
import {
  PAST_BOOKED_GENERIC_INBOUND_MESSAGE, QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE, buildQualifiedLeadTopicAnswer,
} from "../src/domain/message-templates.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";
import type { OfferedSlot } from "../src/domain/offered-slot.js";

/**
 * Fase 6E.3 -- fixes 3 distinct bugs reported together against a past-booked lead's conversation:
 *
 * A) "Sí" after a PPR topic answer lost context and fell back to PAST_BOOKED_GENERIC_INBOUND_MESSAGE.
 *    Root cause: buildQualifiedLeadTopicAnswer's reply never attached any pending-state metadata,
 *    so there was nothing to resolve a short follow-up reply against. Fixed with
 *    qualified-lead-topic-followup.ts's PPR_FOLLOWUP/GMM_FOLLOWUP mechanism.
 * B) "Ok" -- same root cause as A.
 * C) "Agendar" landed on HUMAN_HANDOFF instead of real availability. Root cause: MAX_OFFER_ROUNDS
 *    (offered_slots.round_id count) is scoped per CONVERSATION cumulatively forever, so a
 *    rebooking attempt inherited however many rounds the ORIGINAL (now-concluded) booking used.
 *    Fixed with SlotOfferParams.skipRoundCap, used only by
 *    WhatsAppPastBookedRecoveryHandler.startNewBooking -- see slot-offering-service.ts's doc
 *    comment for why a context-id-based fix was tried first and reverted (it broke
 *    WhatsAppBookingHandler's slot-selection lookup).
 *
 * Covers the task's "11. TESTS OBLIGATORIOS" list, numbered 1-22 below.
 */

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
          contacts: [{ profile: { name: overrides.name ?? "Juan" }, wa_id: overrides.from ?? "5214779970001" }],
          messages: [{ from: overrides.from ?? "5214779970001", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
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

async function outboundMessages(repos: ReturnType<typeof buildRepos>, conversationId: string) {
  const messages = await repos.messagesRepo.listByConversationId(conversationId);
  return messages.filter((m) => m.direction === "OUTBOUND");
}

/** Seeds 3 DISTINCT, EXPIRED, plain-booking-mode rounds for a conversation -- reproduces "the
 * ORIGINAL booking already used up the round budget" without needing to actually run 3 real
 * booking rounds through the handler first. */
async function seedExhaustedRoundBudget(repos: ReturnType<typeof buildRepos>, conversationId: string, leadId: string) {
  const past = new Date(Date.now() - 60 * 60 * 1000);
  for (let round = 0; round < 3; round++) {
    const roundId = randomUUID();
    const rows: Array<Omit<OfferedSlot, "id" | "createdAt">> = [1, 2, 3].map((position) => ({
      conversationId, leadId, roundId, slotStart: past, slotEnd: past, position, expiresAt: past, selected: false,
    }));
    await repos.offeredSlotsRepo.createMany(rows);
  }
}

const PAST_STARTS_AT = new Date("2020-01-15T15:00:00.000Z");
const PAST_ENDS_AT = new Date("2020-01-15T15:30:00.000Z");

describe("Fase 6E.3 -- contextual follow-up + past-booked booking handoff fix", () => {
  it("1. past-booked + PPR question gets the real PPR answer", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970001", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779970001", "wamid.1a", "¿Qué es un PPR?");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toBe(buildQualifiedLeadTopicAnswer("PPR"));
  });

  it("2. the PPR answer sets PPR_FOLLOWUP metadata on the outbound message", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970002", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779970002", "wamid.2a", "¿Qué es un PPR?");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].metadata).toEqual({ expectedIntent: "PPR_FOLLOWUP" });
  });

  it("3. PPR_FOLLOWUP + '1' answers the tax-benefit branch", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970003", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await send(app, "5214779970003", "wamid.3a", "¿Qué es un PPR?");

    await send(app, "5214779970003", "wamid.3b", "1");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[1]!.body!.toLowerCase()).toContain("beneficio fiscal");
    expect(outbound[1]!.body).not.toBe(PAST_BOOKED_GENERIC_INBOUND_MESSAGE);
  });

  it("4. PPR_FOLLOWUP + '2' answers the retirement-savings branch", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970004", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await send(app, "5214779970004", "wamid.4a", "¿Qué es un PPR?");

    await send(app, "5214779970004", "wamid.4b", "2");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[1]!.body!.toLowerCase()).toContain("aportaciones periódicas");
    expect(outbound[1]!.body).not.toBe(PAST_BOOKED_GENERIC_INBOUND_MESSAGE);
  });

  it("5. PPR_FOLLOWUP + 'Sí' asks which branch, never past-booked again (the exact reported bug)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970005", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await send(app, "5214779970005", "wamid.5a", "¿Qué es un PPR?");

    await send(app, "5214779970005", "wamid.5b", "Sí");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[1].body).toBe("Claro. ¿Quieres que empecemos por el beneficio fiscal o por cómo se construye el ahorro para el retiro?");
    expect(outbound[1].body).not.toBe(PAST_BOOKED_GENERIC_INBOUND_MESSAGE);
    expect(outbound[1].metadata).toEqual({ expectedIntent: "PPR_FOLLOWUP" }); // state preserved
  });

  it("6. PPR_FOLLOWUP + 'Ok' continues naturally, never past-booked again (the exact reported bug)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970006", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await send(app, "5214779970006", "wamid.6a", "¿Qué es un PPR?");
    await send(app, "5214779970006", "wamid.6b", "Sí"); // first ambiguous reply

    await send(app, "5214779970006", "wamid.6c", "Ok"); // second ambiguous reply, per the exact reported scenario

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[2].body).toBe("Perfecto. ¿Qué parte te gustaría revisar primero?");
    expect(outbound[2].body).not.toBe(PAST_BOOKED_GENERIC_INBOUND_MESSAGE);
  });

  it("7. PAST_BOOKED_GENERIC_INBOUND_MESSAGE is shown only once per reactivation episode", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970007", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779970007", "wamid.7a", "Hola"); // unrecognized -> past-booked #1
    await send(app, "5214779970007", "wamid.7b", "¿Qué es un PPR?"); // engages normally
    await send(app, "5214779970007", "wamid.7c", "algo completamente distinto sin sentido"); // unrecognized again

    const outbound = await outboundMessages(repos, conversation.id);
    const pastBookedCount = outbound.filter((m) => m.body === PAST_BOOKED_GENERIC_INBOUND_MESSAGE).length;
    expect(pastBookedCount).toBe(1); // never shown a second time
    expect(outbound[2].body).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE); // topic-agnostic redirect instead
  });

  it("8. past-booked + 'agendar' with booking=true reaches the real booking handler", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970008", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779970008", "wamid.8a", "Agendar");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toContain("Tengo estos horarios disponibles");
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("BOOKING_PENDING");
  });

  it("9. 'agendar' never produces HUMAN_HANDOFF, even when the ORIGINAL booking already used up the round budget (the confirmed root cause)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970009", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    // Simulates the ORIGINAL booking having already consumed all 3 rounds before the appointment
    // date arrived -- this is what made MAX_OFFER_ROUNDS trip immediately on the very first
    // post-appointment "agendar" before this fix.
    await seedExhaustedRoundBudget(repos, conversation.id, lead.id);

    await send(app, "5214779970009", "wamid.9a", "Agendar");

    const after = await repos.leadsRepo.findById(lead.id);
    expect(after?.status).not.toBe("HUMAN_HANDOFF");
    expect(after?.status).toBe("BOOKING_PENDING");
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toContain("Tengo estos horarios disponibles");
    expect(outbound[0].body).not.toContain("orientación adecuada"); // never the handoff copy
  });

  it("10. offered slots for the rebooking come exclusively from CalendarProvider -- never invented", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970010", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    const busyStart = new Date(Date.now() + 3 * 86400000);
    const busyEnd = new Date(busyStart.getTime() + 30 * 60000);
    await repos.calendar.createEvent({ title: "busy", description: "", start: busyStart, end: busyEnd });

    await send(app, "5214779970010", "wamid.10a", "Agendar");

    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date());
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.length).toBeLessThanOrEqual(3);
    expect(offered.every((slot) => !(slot.slotStart < busyEnd && slot.slotEnd > busyStart))).toBe(true);
    void lead;
  });

  it("11. the historical (past) appointment remains completely unchanged through the full rebooking flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214779970011", "BOOKED");
    const stale = await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779970011", "wamid.11a", "Agendar");
    await send(app, "5214779970011", "wamid.11b", "1");

    const reloaded = await repos.appointmentsRepo.findById(stale.id);
    expect(reloaded?.status).toBe("BOOKED");
    expect(reloaded?.startsAt.getTime()).toBe(PAST_STARTS_AT.getTime());
  });

  it("12. a brand-new appointment row is created for the rebooking", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214779970012", "BOOKED");
    const stale = await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779970012", "wamid.12a", "Agendar");
    await send(app, "5214779970012", "wamid.12b", "1");

    const all = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    expect(all).toHaveLength(2);
    const newAppt = all.find((a) => a.id !== stale.id)!;
    expect(newAppt.status).toBe("BOOKED");
    expect(newAppt.startsAt.getTime()).toBeGreaterThan(PAST_STARTS_AT.getTime());
  });

  it("13. booking idempotency remains intact -- a retried 'agendar' webhook never duplicates the offer", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214779970013", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779970013", "wamid.dup13", "Agendar");
    await send(app, "5214779970013", "wamid.dup13", "Agendar"); // exact redelivery, same provider_message_id

    const all = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    expect(all.filter((a) => a.startsAt.getTime() !== PAST_STARTS_AT.getTime())).toHaveLength(0); // no new booking yet, offer only sent once
  });

  it("14. anti-double-booking remains intact -- a retried slot-selection webhook never creates two appointments", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214779970014", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    await send(app, "5214779970014", "wamid.14a", "Agendar");

    await send(app, "5214779970014", "wamid.dup14", "1");
    await send(app, "5214779970014", "wamid.dup14", "1"); // exact redelivery of the slot selection

    const all = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    expect(all.filter((a) => a.startsAt.getTime() !== PAST_STARTS_AT.getTime())).toHaveLength(1);
  });

  it("15. a genuine data-consistency violation still escalates to legitimate HUMAN_HANDOFF -- this fix doesn't weaken that", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970015", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });
    // Seeds TWO simultaneously-active rounds for the same conversation -- a genuine
    // data-consistency violation (ActiveOfferInconsistentError), never producible through normal
    // handler flow, but exactly what this guard exists to catch.
    const now = new Date();
    const future = new Date(now.getTime() + 10 * 60 * 1000);
    for (let i = 0; i < 2; i++) {
      const roundId = randomUUID();
      await repos.offeredSlotsRepo.createMany([1, 2, 3].map((position) => ({
        conversationId: conversation.id, leadId: lead.id, roundId,
        slotStart: future, slotEnd: future, position, expiresAt: future, selected: false,
      })));
    }

    await send(app, "5214779970015", "wamid.15a", "Agendar");

    const after = await repos.leadsRepo.findById(lead.id);
    expect(after?.status).toBe("HUMAN_HANDOFF"); // legitimate escalation still works
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toContain("orientación adecuada");
  });

  it("16. DO_NOT_CONTACT stays fully suppressed", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970016", "DO_NOT_CONTACT");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779970016", "wamid.16a", "Agendar");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound).toHaveLength(0);
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("DO_NOT_CONTACT");
  });

  it("17. the Fase 6E.1 nested MAIN/OPTIONS menu fix is untouched for a QUALIFIED_A lead", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: false });
    const { conversation } = await createLeadAtStatus(repos, "5214779970017", "QUALIFIED_A");
    await send(app, "5214779970017", "wamid.17a", "Hola, tengo una duda");
    await send(app, "5214779970017", "wamid.17b", "2");

    await send(app, "5214779970017", "wamid.17c", "1");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[2].body).toBe(buildQualifiedLeadTopicAnswer("SAVINGS")); // no fiscal context -> savings first
  });

  it("18. Lía keeps using the lead's firstName through the rebooking flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970018", "BOOKED", { firstName: "Juan" });
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779970018", "wamid.18a", "Agendar");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toContain("Juan");
  });

  it("19. HubSpot fiscal sync is unaffected by this WhatsApp-router-only fix", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const res = await app.inject({
      method: "POST", url: "/api/leads",
      payload: {
        firstName: "Ana", phone: "4779970019", email: "nineteen@example.com", source: "WEB_FISCAL_CALCULATOR",
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

  it("20. fiscal_v1 for a past-booked lead is untouched by the rebooking/followup flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214779970020", "BOOKED", { source: "WEB_FISCAL_CALCULATOR" });
    await repos.fiscalLeadScoresRepo.tryCreate({
      leadId: lead.id, submissionId: "sub-1", score: 90, scoreClass: "HOT", version: "fiscal_v1",
      reasons: [{ code: "MONTHLY_INCOME_150K_PLUS", points: 40 }],
      monthlyIncomeBand: "150K_PLUS", annualContributionBand: "180K_PLUS", hasPpr: false, filesAnnualReturn: true,
    });
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779970020", "wamid.20a", "¿Qué es un PPR?");
    await send(app, "5214779970020", "wamid.20b", "Sí");
    await send(app, "5214779970020", "wamid.20c", "Agendar");

    const rows = await repos.fiscalLeadScoresRepo.listByLeadId(lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].scoreClass).toBe("HOT");
  });

  it("21. CalendarProvider itself is never called for anything except the real slot-offer/booking steps", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead, conversation } = await createLeadAtStatus(repos, "5214779970021", "BOOKED");
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779970021", "wamid.21a", "¿Qué es un PPR?");
    await send(app, "5214779970021", "wamid.21b", "Sí");
    await send(app, "5214779970021", "wamid.21c", "Ok");

    // None of the followup turns ever created an appointment or an offered-slot round.
    const appointments = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    expect(appointments).toHaveLength(1); // only the original stale one
    const offered = await repos.offeredSlotsRepo.listActiveByConversationId(conversation.id, new Date());
    expect(offered).toHaveLength(0);
  });

  it("22. lifecycle integrity: score/scoreClass/qualifiedAt survive the full followup + rebooking flow", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { lead } = await createLeadAtStatus(repos, "5214779970022", "BOOKED", { score: 74, scoreClass: "B" });
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: PAST_STARTS_AT, endsAt: PAST_ENDS_AT, timezone: "America/Mexico_City" });

    await send(app, "5214779970022", "wamid.22a", "¿Qué es un PPR?");
    await send(app, "5214779970022", "wamid.22b", "Sí");
    await send(app, "5214779970022", "wamid.22c", "Agendar");
    await send(app, "5214779970022", "wamid.22d", "1");

    const after = await repos.leadsRepo.findById(lead.id);
    expect(after?.score).toBe(74);
    expect(after?.scoreClass).toBe("B");
    expect(after?.qualifiedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(after?.status).toBe("BOOKED");
  });
});
