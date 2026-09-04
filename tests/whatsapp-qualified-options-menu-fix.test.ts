import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleInboundWhatsAppText, type InboundWhatsAppText } from "../src/application/whatsapp-inbound-service.js";
import { LeadService } from "../src/application/services.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository, InMemoryLeadScoreRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryFiscalLeadScoreRepository, InMemoryAppointmentRepository,
  InMemoryBookingAttemptRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
  InMemoryQualificationAnswerRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeHubSpotCRMProvider } from "../src/infrastructure/fake-hubspot-crm-provider.js";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import {
  buildFiscalContextWelcomeMessage, QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE, buildQualifiedLeadAskQuestionMessage,
  buildQualifiedLeadTopicAnswer, buildQualifiedLeadOptionsMessage, QUALIFIED_LEAD_BOOKING_FALLBACK_MESSAGE,
} from "../src/domain/message-templates.js";
import type { FiscalLeadScore } from "../src/domain/fiscal-lead-score.js";

/**
 * Fase 6E.1 -- fixes the production bug where option "2" (Conocer opciones) followed by a valid
 * digit reply (e.g. "1" for "Retiro con beneficios fiscales") fell back to the MAIN menu instead
 * of answering the topic. Root cause: the OPTIONS submenu's outbound message never attached a
 * pending-menu marker, so resolvePendingQualifiedMenu() always returned null for it -- see
 * qualified-lead-menu-state.ts's and qualified-lead-options-menu.ts's doc comments.
 *
 * Covers the task's "9. TESTS" list, numbered 1-15 below. Items 1-8/10-12 reuse the direct
 * handleInboundWhatsAppText style already established in whatsapp-qualified-lead-router.test.ts;
 * items 9/13/14 go through the real HTTP surface (webhook / POST /api/leads) since they need
 * WHATSAPP_BOOKING_ENABLED / a HubSpotCRMProvider, neither of which handleInboundWhatsAppText's
 * bare deps object provides on its own.
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
    whatsappUserId: "5214771234567",
    phoneRaw: "5214771234567",
    displayName: "Ana",
    providerMessageId: "wamid.1",
    text: "Hola, quiero información",
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

async function seedQualifiedAFiscalLeadWithWelcome(deps: ReturnType<typeof makeDeps>, phone: string, waId: string) {
  const lead = await deps.leadService.createLead({ firstName: "Ana", phone, source: "WEB_FISCAL_CALCULATOR", consentContact: false });
  await seedFiscalScore(deps.fiscalLeadScores, lead.id);
  await deps.leads.update(lead.id, { status: "QUALIFIED_A", score: 78, scoreClass: "A", qualifiedAt: new Date("2026-01-01T00:00:00.000Z") });
  await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: waId, phoneRaw: phone, providerMessageId: "wamid.fiscal-1", text: PREFILLED_TEXT }));
  return { lead: (await deps.leads.findById(lead.id))! };
}

/** A lead with NO fiscal context -- options menu order flips (Ahorro first, Retiro second). */
async function seedQualifiedALeadNoFiscalContext(deps: ReturnType<typeof makeDeps>, phone: string, waId: string) {
  const lead = await deps.leadService.createLead({ firstName: "Carlos", phone, source: "WHATSAPP", consentContact: true });
  await deps.leads.update(lead.id, { status: "QUALIFIED_A", score: 65, scoreClass: "B", qualifiedAt: new Date("2026-01-02T00:00:00.000Z") });
  await deps.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead: (await deps.leads.findById(lead.id))! };
}

async function send(deps: ReturnType<typeof makeDeps>, waId: string, phone: string, msgId: string, text: string) {
  return handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: waId, phoneRaw: phone, providerMessageId: msgId, text }));
}

describe("Fase 6E.1 -- qualified-lead OPTIONS submenu state fix", () => {
  it("1. MAIN '2' still enters the OPTIONS menu (unchanged)", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776500001", "5214776500001");
    await send(deps, "5214776500001", "4776500001", "wamid.1a", "Hola, tengo una duda"); // main menu shown

    await send(deps, "5214776500001", "4776500001", "wamid.1b", "2");

    expect(deps.messaging.sentTexts).toHaveLength(3);
    expect(deps.messaging.sentTexts[2].body).toBe(buildQualifiedLeadOptionsMessage(true));
  });

  it("2. the OPTIONS outbound message carries expectedIntent: QUALIFIED_OPTIONS_MENU in metadata", async () => {
    const deps = makeDeps();
    const { lead } = await seedQualifiedAFiscalLeadWithWelcome(deps, "4776500002", "5214776500002");
    await send(deps, "5214776500002", "4776500002", "wamid.2a", "Hola, tengo una duda");
    await send(deps, "5214776500002", "4776500002", "wamid.2b", "2");

    const conversation = await deps.conversations.findActiveByLeadId(lead.id);
    const allMessages = await deps.messages.listByConversationId(conversation!.id);
    const outbound = allMessages.filter((m) => m.direction === "OUTBOUND");
    const optionsMessage = outbound[outbound.length - 1];
    expect(optionsMessage.body).toBe(buildQualifiedLeadOptionsMessage(true));
    expect(optionsMessage.metadata).toEqual({ expectedIntent: "QUALIFIED_OPTIONS_MENU" });
    // Never financial data/score/PII in this metadata.
    expect(JSON.stringify(optionsMessage.metadata)).not.toMatch(/HOT|WARM|NURTURE|score|90|78/i);
  });

  it("3. OPTIONS '1' (fiscal context present -> retiro shown first) answers PPR, not the main menu", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776500003", "5214776500003");
    await send(deps, "5214776500003", "4776500003", "wamid.3a", "Hola, tengo una duda");
    await send(deps, "5214776500003", "4776500003", "wamid.3b", "2"); // shows options: 1=PPR, 2=SAVINGS, 3=GMM

    await send(deps, "5214776500003", "4776500003", "wamid.3c", "1");

    expect(deps.messaging.sentTexts).toHaveLength(4);
    const reply = deps.messaging.sentTexts[3].body;
    expect(reply).toBe(buildQualifiedLeadTopicAnswer("PPR"));
    expect(reply).not.toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE); // the bug this phase fixes
  });

  it("4. OPTIONS '2' (fiscal context present) answers SAVINGS", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776500004", "5214776500004");
    await send(deps, "5214776500004", "4776500004", "wamid.4a", "Hola, tengo una duda");
    await send(deps, "5214776500004", "4776500004", "wamid.4b", "2"); // 1=PPR, 2=SAVINGS, 3=GMM

    await send(deps, "5214776500004", "4776500004", "wamid.4c", "2");

    expect(deps.messaging.sentTexts[3].body).toBe(buildQualifiedLeadTopicAnswer("SAVINGS"));
  });

  it("5. OPTIONS '3' (fiscal context present) answers protección / GMM", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776500005", "5214776500005");
    await send(deps, "5214776500005", "4776500005", "wamid.5a", "Hola, tengo una duda");
    await send(deps, "5214776500005", "4776500005", "wamid.5b", "2"); // 1=PPR, 2=SAVINGS, 3=GMM

    await send(deps, "5214776500005", "4776500005", "wamid.5c", "3");

    expect(deps.messaging.sentTexts[3].body).toBe(buildQualifiedLeadTopicAnswer("GMM"));
  });

  it("5b. OPTIONS digits are interpreted against the ORDER actually shown -- no fiscal context flips 1<->2 (1=SAVINGS, 2=PPR, 3=GMM)", async () => {
    const deps = makeDeps();
    await seedQualifiedALeadNoFiscalContext(deps, "4776500006", "5214776500006");
    await send(deps, "5214776500006", "4776500006", "wamid.5x1", "Hola, tengo una duda"); // main menu
    const menuMsg = deps.messaging.sentTexts[0].body;
    expect(menuMsg).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);

    await send(deps, "5214776500006", "4776500006", "wamid.5x2", "2"); // options: 1=SAVINGS, 2=PPR, 3=GMM (no fiscal context)
    expect(deps.messaging.sentTexts[1].body).toBe(buildQualifiedLeadOptionsMessage(false));

    await send(deps, "5214776500006", "4776500006", "wamid.5x3", "1"); // digit 1 -> SAVINGS here, NOT PPR
    expect(deps.messaging.sentTexts[2].body).toBe(buildQualifiedLeadTopicAnswer("SAVINGS"));
    expect(deps.messaging.sentTexts[2].body).not.toBe(buildQualifiedLeadTopicAnswer("PPR"));
  });

  it("6. OPTIONS '1' does not return to the MAIN menu text", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776500007", "5214776500007");
    await send(deps, "5214776500007", "4776500007", "wamid.6a", "Hola, tengo una duda");
    await send(deps, "5214776500007", "4776500007", "wamid.6b", "2");

    await send(deps, "5214776500007", "4776500007", "wamid.6c", "1");

    expect(deps.messaging.sentTexts[3].body).not.toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
  });

  it("7. the OPTIONS menu state is consumed after a valid selection -- a later bare '1' is NOT reinterpreted as retiro", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776500008", "5214776500008");
    await send(deps, "5214776500008", "4776500008", "wamid.7a", "Hola, tengo una duda");
    await send(deps, "5214776500008", "4776500008", "wamid.7b", "2"); // options shown
    await send(deps, "5214776500008", "4776500008", "wamid.7c", "1"); // consumes it -> PPR answer
    expect(deps.messaging.sentTexts[3].body).toBe(buildQualifiedLeadTopicAnswer("PPR"));

    await send(deps, "5214776500008", "4776500008", "wamid.7d", "1"); // no pending menu anymore

    expect(deps.messaging.sentTexts[4].body).not.toBe(buildQualifiedLeadTopicAnswer("PPR"));
    expect(deps.messaging.sentTexts[4].body).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE); // safe fallback, not a dead end
  });

  it("8. MAIN '1' is still MENU_QUESTION (resolver una duda), unaffected by this fix", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776500009", "5214776500009");
    await send(deps, "5214776500009", "4776500009", "wamid.8a", "Hola, tengo una duda");

    await send(deps, "5214776500009", "4776500009", "wamid.8b", "1");

    expect(deps.messaging.sentTexts[2].body).toBe(buildQualifiedLeadAskQuestionMessage(true));
  });

  it("10. a bare '1' right after the FISCAL welcome resolves against THAT menu (Fase 6E.4: 1=SAVINGS there, never PPR) -- not the qualified router's own MAIN menu, which was never shown", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776500010", "5214776500010"); // fiscal welcome only, no QUALIFIED MAIN/OPTIONS menu shown yet

    await send(deps, "5214776500010", "4776500010", "wamid.10a", "1");

    // Fase 6E.4: the fiscal welcome's own 1-4 menu (1=SAVINGS/2=PPR/3=GMM/4=OTHER) is now a real,
    // tracked pending state -- "1" correctly resolves to SAVINGS, never guessed as PPR (digit 2
    // there), and never the qualified router's unrelated MAIN menu (never shown for this lead).
    expect(deps.messaging.sentTexts[1].body).not.toBe(buildQualifiedLeadTopicAnswer("PPR"));
    expect(deps.messaging.sentTexts[1].body).not.toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
    expect(deps.messaging.sentTexts[1].body).toBe(buildQualifiedLeadTopicAnswer("SAVINGS"));
  });

  it("11. fiscal context (fiscal_v1 HOT/90) is untouched by the full MAIN -> OPTIONS -> topic flow", async () => {
    const deps = makeDeps();
    const { lead } = await seedQualifiedAFiscalLeadWithWelcome(deps, "4776500011", "5214776500011");
    await send(deps, "5214776500011", "4776500011", "wamid.11a", "Hola, tengo una duda");
    await send(deps, "5214776500011", "4776500011", "wamid.11b", "2");
    await send(deps, "5214776500011", "4776500011", "wamid.11c", "1");

    const rows = await deps.fiscalLeadScores.listByLeadId(lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(90);
    expect(rows[0].scoreClass).toBe("HOT");
    expect(rows[0].version).toBe("fiscal_v1");
  });

  it("12. Lía keeps using the lead's firstName throughout (unaffected by this fix)", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776500012", "5214776500012");
    expect(deps.messaging.sentTexts[0].body).toBe(buildFiscalContextWelcomeMessage("Ana"));
  });

  it("15. WhatsApp lifecycle (status/score/scoreClass/qualifiedAt) is untouched by the full MAIN -> OPTIONS -> topic flow", async () => {
    const deps = makeDeps();
    const { lead } = await seedQualifiedAFiscalLeadWithWelcome(deps, "4776500015", "5214776500015");
    await send(deps, "5214776500015", "4776500015", "wamid.15a", "Hola, tengo una duda");
    await send(deps, "5214776500015", "4776500015", "wamid.15b", "2");
    await send(deps, "5214776500015", "4776500015", "wamid.15c", "3");

    const after = await deps.leads.findById(lead.id);
    expect(after?.status).toBe("QUALIFIED_A");
    expect(after?.score).toBe(78);
    expect(after?.scoreClass).toBe("A");
    expect(after?.qualifiedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(after?.bookingStartedAt).toBeUndefined();
    expect(after?.bookedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Items 9/13/14 -- require the real HTTP surface (webhook signature verification / POST
// /api/leads), which handleInboundWhatsAppText's bare deps object above doesn't provide alone.
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
          contacts: [{ profile: { name: overrides.name ?? "Ana" }, wa_id: overrides.from ?? "5214776600001" }],
          messages: [{ from: overrides.from ?? "5214776600001", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
        },
      }],
    }],
  });
}

function buildRepos() {
  return {
    leadsRepo: new InMemoryLeadRepository(),
    conversationsRepo: new InMemoryConversationRepository(),
    messagesRepo: new InMemoryMessageRepository(),
    qualificationAnswersRepo: new InMemoryQualificationAnswerRepository(),
    leadScoresRepo: new InMemoryLeadScoreRepository(),
    appointmentsRepo: new InMemoryAppointmentRepository(),
    bookingAttemptsRepo: new InMemoryBookingAttemptRepository(),
    offeredSlotsRepo: new InMemoryOfferedSlotRepository(),
    slotOfferClaimsRepo: new InMemorySlotOfferClaimRepository(),
    leadStatusHistoryRepo: new InMemoryLeadStatusHistoryRepository(),
    fiscalLeadScoresRepo: new InMemoryFiscalLeadScoreRepository(),
    calendar: new FakeCalendarProvider(),
  };
}

async function sendWebhook(app: Awaited<ReturnType<typeof buildTestApp>>, from: string, id: string, body: string) {
  const payload = textWebhookBody({ from, id, body });
  return app.inject({
    method: "POST", url: "/webhooks/whatsapp", payload,
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET) },
  });
}

async function createLeadAtStatus(repos: ReturnType<typeof buildRepos>, whatsappUserId: string) {
  const lead = await repos.leadsRepo.create({
    country: "MX", productVertical: "PATRIMONIAL", status: "NEW", score: 78, scoreClass: "A",
    assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId,
  });
  await repos.leadsRepo.update(lead.id, { status: "QUALIFIED_A" });
  const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead: (await repos.leadsRepo.findById(lead.id))!, conversation };
}

describe("Fase 6E.1 -- surrounding systems remain intact", () => {
  it("9. MAIN '3' still enters the REAL booking flow when WHATSAPP_BOOKING_ENABLED=true (Calendar untouched otherwise)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const { conversation } = await createLeadAtStatus(repos, "5214776600009");
    await sendWebhook(app, "5214776600009", "wamid.9a", "Hola, tengo una duda"); // main menu shown

    const res = await sendWebhook(app, "5214776600009", "wamid.9b", "3");
    expect(res.statusCode).toBe(200);

    const messages = await repos.messagesRepo.listByConversationId(conversation.id);
    const outbound = messages.filter((m) => m.direction === "OUTBOUND");
    // Real booking flow offers real slots -- never the safe fallback text (see whatsapp-calendar-booking-router.test.ts).
    expect(outbound[outbound.length - 1].body).not.toBe(QUALIFIED_LEAD_BOOKING_FALLBACK_MESSAGE);
  });

  it("14. Calendar/booking stays untouched for a conversation that only ever explores OPTIONS (no appointment created)", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    await createLeadAtStatus(repos, "5214776600014");
    await sendWebhook(app, "5214776600014", "wamid.14a", "Hola, tengo una duda");
    await sendWebhook(app, "5214776600014", "wamid.14b", "2"); // options menu
    await sendWebhook(app, "5214776600014", "wamid.14c", "1"); // PPR answer -- never touches Calendar

    const appointments = await repos.appointmentsRepo.listAllByLeadId((await repos.leadsRepo.findByDedupKey({ whatsappUserId: "5214776600014" }))!.id);
    expect(appointments).toHaveLength(0);
  });

  it("13. HubSpot fiscal sync remains fully functional (unaffected by this WhatsApp-router-only fix)", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const res = await app.inject({
      method: "POST", url: "/api/leads",
      payload: {
        firstName: "Ana", lastName: "García", phone: "4776600013", email: "sixeone@example.com",
        source: "WEB_FISCAL_CALCULATOR", privacyAccepted: true, consentContact: true,
        fiscalCalculator: {
          age: 35, city: "León", taxRegime: "sueldos", filesAnnualReturn: true,
          monthlyIncome: 160000, annualContribution: 200000,
          deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
          hasGmm: true, hasPpr: false,
          calculation: { annualIncome: 1920000, pprDeductionLimit: 213973.2, effectivePprContribution: 200000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 48000, estimatedTaxBenefitMax: 72000 },
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(hubspotCrm.contacts).toHaveLength(1);
    expect(hubspotCrm.contacts[0].email).toBe("sixeone@example.com");
  });
});
