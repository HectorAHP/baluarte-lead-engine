import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleInboundWhatsAppText, type InboundWhatsAppText } from "../src/application/whatsapp-inbound-service.js";
import { LeadService } from "../src/application/services.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository, InMemoryLeadScoreRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryFiscalLeadScoreRepository, InMemoryAppointmentRepository,
  InMemoryQualificationAnswerRepository, InMemoryBookingAttemptRepository, InMemoryOfferedSlotRepository,
  InMemorySlotOfferClaimRepository, InMemoryAppointmentStatusHistoryRepository, InMemoryAppointmentCancellationRepository,
  InMemoryAppointmentRescheduleRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeHubSpotCRMProvider } from "../src/infrastructure/fake-hubspot-crm-provider.js";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import {
  buildFiscalContextWelcomeMessage, QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE, buildQualifiedLeadTopicAnswer,
  buildQualifiedLeadOptionsMessage, FISCAL_WELCOME_OTHER_TOPIC_MESSAGE, PAST_BOOKED_GENERIC_INBOUND_MESSAGE,
} from "../src/domain/message-templates.js";
import type { FiscalLeadScore } from "../src/domain/fiscal-lead-score.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";
import type { CalendarProvider } from "../src/application/ports.js";

/**
 * Fase 6E.4 -- fixes the reported production bug: a fiscal-calculator lead's "2"/"2"/"1"
 * follow-up replies to the fiscal welcome went completely silent. Root cause: the fiscal welcome
 * never attached a pending-menu marker, and a fiscal-calculator lead's status at that moment can
 * be CONTACTED (e.g. an advisor already called them, unrelated to WhatsApp) WITH productInterest
 * already set ("Beneficio fiscal PPR", set by impuestos.html's own payload) -- a lead shape NO
 * branch in whatsapp-inbound-service.ts's routing chain ever claimed (confirmed reproduced BEFORE
 * this fix -- see the Fase 6E.4 report, item 1).
 *
 * Covers the task's "11. TESTS" list, numbered 1-20 below. Items 1-9/13-15 reuse the direct
 * handleInboundWhatsAppText style from whatsapp-qualified-lead-router.test.ts; items 10-12/16-19
 * go through the real HTTP surface (webhook / POST /api/leads) since they need the exact
 * CONTACTED-status reproduction, WHATSAPP_BOOKING_ENABLED, or a HubSpotCRMProvider.
 */

const PREFILLED_TEXT = "Hola, acabo de realizar mi estimación fiscal en Baluarte Capital y quiero revisar mi resultado.";

function makeDeps() {
  const leads = new InMemoryLeadRepository();
  const conversations = new InMemoryConversationRepository();
  const messages = new InMemoryMessageRepository();
  const leadScores = new InMemoryLeadScoreRepository();
  const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
  const messaging = new FakeMessagingProvider();
  const logger = new FakeLogger();
  const leadService = new LeadService(leads, leadScores, new InMemoryLeadStatusHistoryRepository(), logger);
  return { leads, conversations, messages, fiscalLeadScores, messaging, logger, leadService };
}
function baseInput(overrides: Partial<InboundWhatsAppText> = {}): InboundWhatsAppText {
  return {
    whatsappUserId: "5214771234567", phoneRaw: "5214771234567", displayName: "Miguel",
    providerMessageId: "wamid.1", text: "Hola, quiero información",
    ...overrides,
  };
}
async function seedFiscalScore(fiscalLeadScores: InMemoryFiscalLeadScoreRepository, leadId: string) {
  return fiscalLeadScores.tryCreate({
    leadId, submissionId: "sub-1", score: 90, scoreClass: "HOT", version: "fiscal_v1",
    reasons: [{ code: "MONTHLY_INCOME_150K_PLUS", points: 40 }],
    monthlyIncomeBand: "150K_PLUS", annualContributionBand: "180K_PLUS", hasPpr: false, filesAnnualReturn: true,
  } satisfies Omit<FiscalLeadScore, "id" | "createdAt">);
}
/** A lead with status "NEW" (the common case -- calculator submission, never messaged WhatsApp
 * before), fiscal context present, only the fiscal welcome exchanged so far. */
async function seedFreshFiscalLeadWithWelcome(deps: ReturnType<typeof makeDeps>, phone: string, waId: string) {
  const lead = await deps.leadService.createLead({ firstName: "Miguel", phone, source: "WEB_FISCAL_CALCULATOR", consentContact: false });
  await seedFiscalScore(deps.fiscalLeadScores, lead.id);
  await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: waId, phoneRaw: phone, providerMessageId: "wamid.fiscal-1", text: PREFILLED_TEXT }));
  return { lead: (await deps.leads.findById(lead.id))! };
}
async function send(deps: ReturnType<typeof makeDeps>, waId: string, phone: string, msgId: string, text: string) {
  return handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: waId, phoneRaw: phone, providerMessageId: msgId, text }));
}

describe("Fase 6E.4 -- fiscal welcome menu follow-up", () => {
  it("1. the fiscal welcome itself generates an outbound reply", async () => {
    const deps = makeDeps();
    await seedFreshFiscalLeadWithWelcome(deps, "4779930001", "5214779930001");
    expect(deps.messaging.sentTexts).toHaveLength(1);
    expect(deps.messaging.sentTexts[0].body).toBe(buildFiscalContextWelcomeMessage("Miguel"));
  });

  it("2. the fiscal welcome's outbound carries the correct pending-menu marker", async () => {
    const deps = makeDeps();
    const { lead } = await seedFreshFiscalLeadWithWelcome(deps, "4779930002", "5214779930002");
    const conversation = await deps.conversations.findActiveByLeadId(lead.id);
    const messages = await deps.messages.listByConversationId(conversation!.id);
    const outbound = messages.filter((m) => m.direction === "OUTBOUND");
    expect(outbound[0].metadata).toEqual({ expectedIntent: "FISCAL_WELCOME_MENU" });
  });

  it("3. fiscal welcome + '1' -> ahorro (SAVINGS)", async () => {
    const deps = makeDeps();
    await seedFreshFiscalLeadWithWelcome(deps, "4779930003", "5214779930003");
    await send(deps, "5214779930003", "4779930003", "wamid.f3", "1");
    expect(deps.messaging.sentTexts[1].body).toBe(buildQualifiedLeadTopicAnswer("SAVINGS"));
  });

  it("4. fiscal welcome + '2' -> PPR", async () => {
    const deps = makeDeps();
    await seedFreshFiscalLeadWithWelcome(deps, "4779930004", "5214779930004");
    await send(deps, "5214779930004", "4779930004", "wamid.f4", "2");
    expect(deps.messaging.sentTexts[1].body).toBe(buildQualifiedLeadTopicAnswer("PPR"));
  });

  it("5. fiscal welcome + '3' -> GMM", async () => {
    const deps = makeDeps();
    await seedFreshFiscalLeadWithWelcome(deps, "4779930005", "5214779930005");
    await send(deps, "5214779930005", "4779930005", "wamid.f5", "3");
    expect(deps.messaging.sentTexts[1].body).toBe(buildQualifiedLeadTopicAnswer("GMM"));
  });

  it("6. fiscal welcome + '4' -> otro tema (open-ended, never a guess)", async () => {
    const deps = makeDeps();
    await seedFreshFiscalLeadWithWelcome(deps, "4779930006", "5214779930006");
    await send(deps, "5214779930006", "4779930006", "wamid.f6", "4");
    expect(deps.messaging.sentTexts[1].body).toBe(FISCAL_WELCOME_OTHER_TOPIC_MESSAGE);
  });

  it("7. a valid selection consumes the FISCAL_WELCOME_MENU state -- a later bare digit is not reinterpreted against it", async () => {
    const deps = makeDeps();
    const { lead } = await seedFreshFiscalLeadWithWelcome(deps, "4779930007", "5214779930007");
    await send(deps, "5214779930007", "4779930007", "wamid.f7a", "1"); // consumes it -> SAVINGS
    expect(deps.messaging.sentTexts[1].body).toBe(buildQualifiedLeadTopicAnswer("SAVINGS"));

    const conversation = await deps.conversations.findActiveByLeadId(lead.id);
    const messages = await deps.messages.listByConversationId(conversation!.id);
    const outbound = messages.filter((m) => m.direction === "OUTBOUND");
    expect(outbound[1].metadata).not.toEqual({ expectedIntent: "FISCAL_WELCOME_MENU" });
  });

  it("8. free text 'quiero saber del PPR' resolves semantically while the fiscal welcome menu is pending", async () => {
    const deps = makeDeps();
    await seedFreshFiscalLeadWithWelcome(deps, "4779930008", "5214779930008");
    await send(deps, "5214779930008", "4779930008", "wamid.f8", "quiero saber del PPR");
    expect(deps.messaging.sentTexts[1].body).toBe(buildQualifiedLeadTopicAnswer("PPR"));
  });

  it("9. free text 'gastos médicos' resolves to GMM while the fiscal welcome menu is pending", async () => {
    const deps = makeDeps();
    await seedFreshFiscalLeadWithWelcome(deps, "4779930009", "5214779930009");
    await send(deps, "5214779930009", "4779930009", "wamid.f9", "gastos médicos");
    expect(deps.messaging.sentTexts[1].body).toBe(buildQualifiedLeadTopicAnswer("GMM"));
  });

  it("13. Lía keeps using the lead's firstName for the fiscal welcome", async () => {
    const deps = makeDeps();
    await seedFreshFiscalLeadWithWelcome(deps, "4779930013", "5214779930013");
    expect(deps.messaging.sentTexts[0].body).toContain("Miguel");
  });

  it("14. fiscal context (fiscal_v1) is untouched by resolving the fiscal welcome menu", async () => {
    const deps = makeDeps();
    const { lead } = await seedFreshFiscalLeadWithWelcome(deps, "4779930014", "5214779930014");
    await send(deps, "5214779930014", "4779930014", "wamid.f14", "2");
    const rows = await deps.fiscalLeadScores.listByLeadId(lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].scoreClass).toBe("HOT");
    expect(rows[0].version).toBe("fiscal_v1");
  });

  it("15. the Fase 6E.1 qualified MAIN/OPTIONS menus remain intact once the fiscal-welcome-menu state is consumed and the lead is QUALIFIED_A", async () => {
    const deps = makeDeps();
    const lead = await deps.leadService.createLead({ firstName: "Miguel", phone: "4779930015", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, lead.id);
    await deps.leads.update(lead.id, { status: "QUALIFIED_A", score: 78, scoreClass: "A" });
    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214779930015", phoneRaw: "4779930015", providerMessageId: "wamid.f15a", text: PREFILLED_TEXT }));
    await send(deps, "5214779930015", "4779930015", "wamid.f15b", "1"); // consumes FISCAL_WELCOME_MENU -> SAVINGS

    await send(deps, "5214779930015", "4779930015", "wamid.f15c", "Hola, tengo una duda"); // unrecognized -> qualified MAIN menu
    expect(deps.messaging.sentTexts[2].body).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);

    await send(deps, "5214779930015", "4779930015", "wamid.f15d", "2"); // MAIN menu digit 2 -> qualified OPTIONS menu (different scheme entirely)
    expect(deps.messaging.sentTexts[3].body).toBe(buildQualifiedLeadOptionsMessage(true));
  });
});

// ---------------------------------------------------------------------------------------------
// Items 10-12/16-19 -- the real HTTP surface (webhook signature verification / POST /api/leads),
// needed for the exact CONTACTED-status reproduction, WHATSAPP_BOOKING_ENABLED, and HubSpot.
// ---------------------------------------------------------------------------------------------

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
          contacts: [{ profile: { name: overrides.name ?? "Miguel" }, wa_id: overrides.from ?? "5214779930101" }],
          messages: [{ from: overrides.from ?? "5214779930101", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
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
async function sendWebhook(app: Awaited<ReturnType<typeof buildTestApp>>, from: string, id: string, body: string) {
  const payload = textWebhookBody({ from, id, body });
  return app.inject({
    method: "POST", url: "/webhooks/whatsapp", payload,
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET) },
  });
}
async function outboundMessages(repos: ReturnType<typeof buildRepos>, conversationId: string) {
  const messages = await repos.messagesRepo.listByConversationId(conversationId);
  return messages.filter((m) => m.direction === "OUTBOUND");
}
/** Realistic production shape: a lead created via the REAL POST /api/leads route
 * (source=WEB_FISCAL_CALCULATOR, productInterest="Beneficio fiscal PPR" exactly like
 * impuestos.html's own payload -- impuestos.html:1010). */
async function seedFiscalCalculatorLead(app: Awaited<ReturnType<typeof buildTestApp>>, repos: ReturnType<typeof buildRepos>, phone: string) {
  const res = await app.inject({
    method: "POST", url: "/api/leads",
    payload: {
      firstName: "Miguel", phone, source: "WEB_FISCAL_CALCULATOR", privacyAccepted: true, consentContact: true,
      productInterest: "Beneficio fiscal PPR",
      fiscalCalculator: {
        monthlyIncome: 160000, annualContribution: 200000,
        deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
        calculation: { annualIncome: 1920000, pprDeductionLimit: 213973.2, effectivePprContribution: 200000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 48000, estimatedTaxBenefitMax: 72000 },
        filesAnnualReturn: true, hasPpr: false,
      },
    },
  });
  const leadId = res.json().leadId as string;
  return (await repos.leadsRepo.findById(leadId))!;
}

describe("Fase 6E.4 -- HTTP-level: CONTACTED reproduction, idempotency, and surrounding systems", () => {
  it("10. consecutive messages with different provider_message_id are each processed", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, qualificationEngineEnabled: true });
    const lead = await seedFiscalCalculatorLead(app, repos, "4779930110");
    await sendWebhook(app, "5214779930110", "wamid.10a", PREFILLED_TEXT);
    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead.id);

    await sendWebhook(app, "5214779930110", "wamid.10b", "2"); // consumes FISCAL_WELCOME_MENU -> PPR
    // A second, DIFFERENT provider_message_id, sent while the FISCAL_WELCOME_MENU state is
    // already consumed (now PPR_FOLLOWUP) -- still gets a real, non-empty reply (never silent),
    // via the now-pending PPR_FOLLOWUP resolving "1" as the tax-benefit branch (Fase 6E.3 reuse).
    await sendWebhook(app, "5214779930110", "wamid.10c", "1");

    const outbound = await outboundMessages(repos, conversation!.id);
    expect(outbound).toHaveLength(3); // welcome + 2 distinct follow-ups, both processed -- never silent
    expect(outbound[1].body).toBe(buildQualifiedLeadTopicAnswer("PPR"));
    expect(outbound[2].body).toBeTruthy();
    expect(outbound[2].body).not.toBe(outbound[1].body);
  });

  it("11. a retry with the SAME provider_message_id is deduped -- no duplicate outbound", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, qualificationEngineEnabled: true });
    const lead = await seedFiscalCalculatorLead(app, repos, "4779930111");
    await sendWebhook(app, "5214779930111", "wamid.11a", PREFILLED_TEXT);
    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead.id);

    await sendWebhook(app, "5214779930111", "wamid.dup11", "2");
    await sendWebhook(app, "5214779930111", "wamid.dup11", "2"); // exact redelivery, same id

    const inbound = (await repos.messagesRepo.listByConversationId(conversation!.id)).filter((m) => m.direction === "INBOUND");
    expect(inbound).toHaveLength(2); // welcome trigger + the ONE "2", never duplicated
    const outbound = await outboundMessages(repos, conversation!.id);
    expect(outbound).toHaveLength(2); // welcome + exactly one reply to "2"
  });

  it("12. no silent branch: a CONTACTED lead (productInterest already set, e.g. advisor called them first) gets a real reply -- the exact reported production bug", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, qualificationEngineEnabled: true });
    const lead = await seedFiscalCalculatorLead(app, repos, "4779930112");
    await app.inject({ method: "POST", url: `/api/leads/${lead.id}/contact` }); // e.g. Héctor called them before WhatsApp
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CONTACTED");

    await sendWebhook(app, "5214779930112", "wamid.12a", PREFILLED_TEXT);
    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead.id);
    await sendWebhook(app, "5214779930112", "wamid.12b", "2");
    await sendWebhook(app, "5214779930112", "wamid.12c", "2"); // exactly as reported: sent twice
    await sendWebhook(app, "5214779930112", "wamid.12d", "1");

    const outbound = await outboundMessages(repos, conversation!.id);
    // welcome + reply-to-"2" (consumes the state) + reply-to-second-"2" (state already consumed,
    // falls through) + reply-to-"1" -- the key assertion is NONE of these are missing.
    expect(outbound.length).toBeGreaterThanOrEqual(2);
    expect(outbound[1].body).toBe(buildQualifiedLeadTopicAnswer("PPR")); // never silent
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CONTACTED"); // lifecycle untouched by this fix
  });

  it("16. past-booked (Fase 6E.2/6E.3) recovery remains intact -- unaffected by this fiscal-welcome-only fix", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const lead = await repos.leadsRepo.create({
      country: "MX", productVertical: "PATRIMONIAL", status: "NEW", score: 74, scoreClass: "B",
      assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214779930116", firstName: "Juan",
    } satisfies Omit<Lead, "id" | "createdAt" | "updatedAt">);
    await repos.leadsRepo.update(lead.id, { status: "BOOKED" as LeadStatus });
    const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2020-01-01T10:00:00.000Z"), endsAt: new Date("2020-01-01T10:30:00.000Z"), timezone: "America/Mexico_City" });

    await sendWebhook(app, "5214779930116", "wamid.16a", "Agendar");

    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toContain("Tengo estos horarios disponibles"); // real booking, not the past-booked loop
  });

  it("17. the Fase 6E.3.1 episode-scoped booking round cap remains intact", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const lead = await repos.leadsRepo.create({
      country: "MX", productVertical: "PATRIMONIAL", status: "QUALIFIED_A", score: 78, scoreClass: "A",
      assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214779930117", firstName: "Juan",
    } satisfies Omit<Lead, "id" | "createdAt" | "updatedAt">);
    const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });

    await sendWebhook(app, "5214779930117", "wamid.17a", "Quiero agendar una cita"); // round 1
    const outbound = await outboundMessages(repos, conversation.id);
    expect(outbound[0].body).toContain("Tengo estos horarios disponibles");
  });

  it("18. HubSpot fiscal sync remains fully functional -- unaffected by this WhatsApp-router-only fix", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const res = await app.inject({
      method: "POST", url: "/api/leads",
      payload: {
        firstName: "Miguel", phone: "4779930118", email: "sixeighteen@example.com", source: "WEB_FISCAL_CALCULATOR",
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

  it("19. Calendar (CalendarProvider) is never touched by resolving the fiscal welcome menu -- no appointment created", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, qualificationEngineEnabled: true });
    const lead = await seedFiscalCalculatorLead(app, repos, "4779930119");
    await sendWebhook(app, "5214779930119", "wamid.19a", PREFILLED_TEXT);
    await sendWebhook(app, "5214779930119", "wamid.19b", "2");

    const appointments = await repos.appointmentsRepo.listAllByLeadId(lead.id);
    expect(appointments).toHaveLength(0);
  });

  it("20. lifecycle (status) is not force-advanced by resolving the fiscal welcome menu -- reply-only, no side effects", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, qualificationEngineEnabled: true });
    const lead = await seedFiscalCalculatorLead(app, repos, "4779930120");
    await app.inject({ method: "POST", url: `/api/leads/${lead.id}/contact` });
    await sendWebhook(app, "5214779930120", "wamid.20a", PREFILLED_TEXT);

    await sendWebhook(app, "5214779930120", "wamid.20b", "2");

    // Status stays exactly what it was (CONTACTED) -- the fix is reply-only, never a lifecycle
    // transition (that remains owned exclusively by the qualification engine / booking flow).
    expect((await repos.leadsRepo.findById(lead.id))?.status).toBe("CONTACTED");
  });
});
