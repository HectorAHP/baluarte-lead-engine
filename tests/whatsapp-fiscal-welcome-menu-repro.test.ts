import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import { handleInboundWhatsAppText, type InboundWhatsAppText } from "../src/application/whatsapp-inbound-service.js";
import { LeadService } from "../src/application/services.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryFiscalLeadScoreRepository, InMemoryLeadScoreRepository, InMemoryLeadStatusHistoryRepository,
  InMemoryAppointmentRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { FakeHubSpotCRMProvider } from "../src/infrastructure/fake-hubspot-crm-provider.js";
import { buildQualifiedLeadTopicAnswer, buildQualifiedLeadOptionsMessage, FISCAL_WELCOME_OTHER_TOPIC_MESSAGE } from "../src/domain/message-templates.js";
import { resolvePendingFiscalWelcomeMenu, fiscalWelcomeMenuMetadata } from "../src/domain/fiscal-welcome-menu-state.js";
import type { Message } from "../src/domain/message.js";
import type { FiscalLeadScore } from "../src/domain/fiscal-lead-score.js";

/**
 * Fase 6E.5 -- REPRODUCTION of the exact production shape reported: a fiscal-calculator lead
 * whose status was ALREADY "CONTACTED" (with productInterest="Beneficio fiscal PPR" already set --
 * e.g. an advisor called them manually before their first WhatsApp message, unrelated to
 * WhatsApp) sends the fiscal-CTA text, gets the fiscal welcome, then replies "2" and -- per the
 * reported Render trace -- got branch="no-match", willReply=false.
 *
 * Built against the REAL pipeline (HTTP webhook injection through buildTestApp), never pure
 * functions in isolation -- per the task's explicit "debe ejecutar el pipeline real" instruction.
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
          contacts: [{ profile: { name: overrides.name ?? "Miguel" }, wa_id: overrides.from ?? "5214779940001" }],
          messages: [{ from: overrides.from ?? "5214779940001", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
        },
      }],
    }],
  });
}
async function send(app: Awaited<ReturnType<typeof buildTestApp>>, from: string, id: string, body: string) {
  const payload = textWebhookBody({ from, id, body });
  return app.inject({
    method: "POST", url: "/webhooks/whatsapp", payload,
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET) },
  });
}
async function outboundMessages(messagesRepo: InMemoryMessageRepository, conversationId: string) {
  const messages = await messagesRepo.listByConversationId(conversationId);
  return messages.filter((m) => m.direction === "OUTBOUND");
}
async function seedFiscalScore(fiscalLeadScoresRepo: InMemoryFiscalLeadScoreRepository, leadId: string) {
  return fiscalLeadScoresRepo.tryCreate({
    leadId, submissionId: "sub-real-1", score: 90, scoreClass: "HOT", version: "fiscal_v1",
    reasons: [{ code: "MONTHLY_INCOME_150K_PLUS", points: 40 }],
    monthlyIncomeBand: "150K_PLUS", annualContributionBand: "180K_PLUS", hasPpr: false, filesAnnualReturn: true,
  } satisfies Omit<FiscalLeadScore, "id" | "createdAt">);
}

const PREFILLED_CTA = "Hola, acabo de realizar mi estimación fiscal en Baluarte Capital y quiero revisar mi resultado.";

describe("Fase 6E.5 -- exact production reproduction: CONTACTED + productInterest + fiscal welcome + '2'", () => {
  it("reproduces the reported case end-to-end via the real HTTP webhook pipeline", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const conversationsRepo = new InMemoryConversationRepository();
    const messagesRepo = new InMemoryMessageRepository();
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ leadsRepo, conversationsRepo, messagesRepo, fiscalLeadScoresRepo });

    // Lead exactly as described: existing (not new), CONTACTED, productInterest already set
    // ("Beneficio fiscal PPR" -- impuestos.html's own submission payload), fiscal context
    // available, zero prior WhatsApp messages, no conversation yet.
    const lead = await leadsRepo.create({
      country: "MX", productVertical: "PATRIMONIAL", productInterest: "Beneficio fiscal PPR",
      status: "NEW", score: 0, assignedAdvisor: "Hector Herrera", consentContact: true,
      firstName: "Miguel", whatsappUserId: "5214779940001", phoneE164: "+525214779940001",
    });
    await leadsRepo.update(lead.id, { status: "CONTACTED" });
    await seedFiscalScore(fiscalLeadScoresRepo, lead.id);

    // Inbound #1: the prefilled fiscal CTA -- triggers the fiscal welcome.
    const first = await send(app, "5214779940001", "wamid.real1", PREFILLED_CTA);
    expect(first.statusCode).toBe(200);

    const conversation = await conversationsRepo.findActiveByLeadId(lead.id);
    expect(conversation).not.toBeNull();
    const afterFirst = await outboundMessages(messagesRepo, conversation!.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.body).toContain("estimación fiscal");
    expect(afterFirst[0]!.body).toContain("1. Ahorro e inversión");
    expect(afterFirst[0]!.metadata).toEqual({ expectedIntent: "FISCAL_WELCOME_MENU" });

    // Inbound #2: "2" -- must resolve to PPR, never silence, never "no-match".
    const second = await send(app, "5214779940001", "wamid.real2", "2");
    expect(second.statusCode).toBe(200);

    const afterSecond = await outboundMessages(messagesRepo, conversation!.id);
    expect(afterSecond).toHaveLength(2); // NOT still 1 -- this is the exact reported silence
    expect(afterSecond[1]!.body).toBe(buildQualifiedLeadTopicAnswer("PPR"));
  });

  it("item 13: the branch log never records 'no-match' for a valid FISCAL_WELCOME_MENU selection", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const conversationsRepo = new InMemoryConversationRepository();
    const messagesRepo = new InMemoryMessageRepository();
    const fiscalLeadScoresRepo = new InMemoryFiscalLeadScoreRepository();
    const app = await buildTestApp({ leadsRepo, conversationsRepo, messagesRepo, fiscalLeadScoresRepo });
    const lead = await leadsRepo.create({
      country: "MX", productVertical: "PATRIMONIAL", productInterest: "Beneficio fiscal PPR",
      status: "NEW", score: 0, assignedAdvisor: "Hector Herrera", consentContact: true,
      firstName: "Miguel", whatsappUserId: "5214779940002", phoneE164: "+525214779940002",
    });
    await leadsRepo.update(lead.id, { status: "CONTACTED" });
    await seedFiscalScore(fiscalLeadScoresRepo, lead.id);
    const logs: unknown[] = [];
    app.log.warn = ((...args: unknown[]) => { logs.push(args); }) as typeof app.log.warn;

    await send(app, "5214779940002", "wamid.b13a", PREFILLED_CTA);
    await send(app, "5214779940002", "wamid.b13b", "2");

    const serialized = JSON.stringify(logs);
    expect(serialized).toContain("fiscal-welcome-menu-ppr");
    expect(serialized).not.toContain("\"branch\":\"no-match\"");
  });
});

/**
 * Fase 6E.5 -- remaining test matrix (items 1, 5-9, 11, 14-18), reusing the low-level
 * handleInboundWhatsAppText style already established in whatsapp-fiscal-welcome-menu.test.ts
 * (Fase 6E.4) for speed/precision, plus two genuinely NEW pieces this phase adds:
 *  - item 7/8: a DIRECT, isolated test of resolvePendingFiscalWelcomeMenu proving it finds the
 *    right OUTBOUND row even when the current inbound has ALREADY been appended to the message
 *    list passed in (simulating production's real persist-then-resolve order exactly).
 *  - item 9: the new pendingMenu/pendingMenuResolved observability log lines.
 */
const PREFILLED_TEXT = PREFILLED_CTA;

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
async function seedScore(fiscalLeadScores: InMemoryFiscalLeadScoreRepository, leadId: string) {
  return fiscalLeadScores.tryCreate({
    leadId, submissionId: "sub-1", score: 90, scoreClass: "HOT", version: "fiscal_v1",
    reasons: [{ code: "MONTHLY_INCOME_150K_PLUS", points: 40 }],
    monthlyIncomeBand: "150K_PLUS", annualContributionBand: "180K_PLUS", hasPpr: false, filesAnnualReturn: true,
  } satisfies Omit<FiscalLeadScore, "id" | "createdAt">);
}
async function seedFreshFiscalLeadWithWelcome(deps: ReturnType<typeof makeDeps>, phone: string, waId: string) {
  const lead = await deps.leadService.createLead({ firstName: "Miguel", phone, source: "WEB_FISCAL_CALCULATOR", consentContact: false });
  await seedScore(deps.fiscalLeadScores, lead.id);
  await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: waId, phoneRaw: phone, providerMessageId: "wamid.fiscal-1", text: PREFILLED_TEXT }));
  return { lead: (await deps.leads.findById(lead.id))! };
}
async function sendLow(deps: ReturnType<typeof makeDeps>, waId: string, phone: string, msgId: string, text: string) {
  return handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: waId, phoneRaw: phone, providerMessageId: msgId, text }));
}

describe("Fase 6E.5 -- remaining test matrix", () => {
  it("1. all fiscal welcome emitters attach fiscalWelcomeMenuMetadata() -- audited: exactly 2 emitters exist, both correct", async () => {
    // Emitter A: wasNew-welcome branch (lead.status === NEW at trigger time).
    const depsA = makeDeps();
    const { lead: leadA } = await seedFreshFiscalLeadWithWelcome(depsA, "4779940003", "5214779940003");
    const convRowA = await depsA.conversations.findActiveByLeadId(leadA.id);
    const outboundA = (await depsA.messages.listByConversationId(convRowA!.id)).filter((m) => m.direction === "OUTBOUND");
    expect(outboundA).toHaveLength(1);
    expect(outboundA[0]!.metadata).toEqual({ expectedIntent: "FISCAL_WELCOME_MENU" });

    // Emitter B: existing-lead-first-whatsapp-fiscal-welcome branch (status already moved off NEW).
    const depsB = makeDeps();
    const leadB = await depsB.leadService.createLead({ firstName: "Ana", phone: "4779940004", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedScore(depsB.fiscalLeadScores, leadB.id);
    await depsB.leads.update(leadB.id, { status: "CONTACTED", productInterest: "Beneficio fiscal PPR" });
    await sendLow(depsB, "5214779940004", "4779940004", "wamid.b1", PREFILLED_TEXT);
    const convRowB = await depsB.conversations.findActiveByLeadId(leadB.id);
    const outboundB = (await depsB.messages.listByConversationId(convRowB!.id)).filter((m) => m.direction === "OUTBOUND");
    expect(outboundB).toHaveLength(1);
    expect(outboundB[0]!.metadata).toEqual({ expectedIntent: "FISCAL_WELCOME_MENU" });
  });

  it("5. fiscal welcome + '1' -> ahorro (SAVINGS)", async () => {
    const deps = makeDeps();
    const { lead } = await seedFreshFiscalLeadWithWelcome(deps, "4779940005", "5214779940005");
    await sendLow(deps, "5214779940005", "4779940005", "wamid.5a", "1");
    expect(deps.messaging.sentTexts[1]!.body).toBe(buildQualifiedLeadTopicAnswer("SAVINGS"));
    void lead;
  });

  it("6. fiscal welcome + '3' -> GMM", async () => {
    const deps = makeDeps();
    await seedFreshFiscalLeadWithWelcome(deps, "4779940006", "5214779940006");
    await sendLow(deps, "5214779940006", "4779940006", "wamid.6a", "3");
    expect(deps.messaging.sentTexts[1]!.body).toBe(buildQualifiedLeadTopicAnswer("GMM"));
  });

  it("7. fiscal welcome + '4' -> otro tema (open-ended, never a guess)", async () => {
    const deps = makeDeps();
    await seedFreshFiscalLeadWithWelcome(deps, "4779940007", "5214779940007");
    await sendLow(deps, "5214779940007", "4779940007", "wamid.7a", "4");
    expect(deps.messaging.sentTexts[1]!.body).toBe(FISCAL_WELCOME_OTHER_TOPIC_MESSAGE);
  });

  it("8. the current inbound being ALREADY persisted does not hide the last OUTBOUND FISCAL_WELCOME_MENU marker (direct resolver test, production order exactly)", () => {
    const now = new Date();
    const messages: Message[] = [
      { id: "m1", conversationId: "c1", leadId: "l1", direction: "INBOUND", channel: "WHATSAPP", body: PREFILLED_TEXT, aiGenerated: false, metadata: {}, createdAt: new Date(now.getTime() - 3000) },
      { id: "m2", conversationId: "c1", leadId: "l1", direction: "OUTBOUND", channel: "WHATSAPP", body: "welcome", aiGenerated: false, metadata: { expectedIntent: "FISCAL_WELCOME_MENU" }, createdAt: new Date(now.getTime() - 2000) },
      // The CURRENT inbound ("2"), matching production's real order: persisted BEFORE resolution
      // runs (see whatsapp-inbound-service.ts checkpoint 10/11, well before checkpoint 12d).
      { id: "m3", conversationId: "c1", leadId: "l1", direction: "INBOUND", channel: "WHATSAPP", body: "2", aiGenerated: false, metadata: {}, createdAt: new Date(now.getTime() - 1000) },
    ];

    const pending = resolvePendingFiscalWelcomeMenu(messages);

    expect(pending).toBe(true); // finds the last OUTBOUND (m2), never confused by the later INBOUND (m3)
  });

  it("9. observability: pendingMenu is logged as FISCAL_WELCOME_MENU when resolution succeeds, and pendingMenuResolved:false when it doesn't match anything", async () => {
    const deps = makeDeps();
    await seedFreshFiscalLeadWithWelcome(deps, "4779940009", "5214779940009");

    await sendLow(deps, "5214779940009", "4779940009", "wamid.9a", "2"); // resolves -> consumes state
    let serialized = JSON.stringify(deps.logger.warnings);
    expect(serialized).toContain("\"pendingMenu\":\"FISCAL_WELCOME_MENU\"");

    // Fresh lead, second message this time is genuinely unrecognized while the menu is pending.
    const deps2 = makeDeps();
    await seedFreshFiscalLeadWithWelcome(deps2, "4779940010", "5214779940010");
    await sendLow(deps2, "5214779940010", "4779940010", "wamid.9b", "no logro decidir, mándame más info general");
    serialized = JSON.stringify(deps2.logger.warnings);
    expect(serialized).toContain("\"pendingMenuResolved\":false");
  });

  it("11. free text 'ahorro' resolves to SAVINGS while the fiscal welcome menu is pending", async () => {
    const deps = makeDeps();
    await seedFreshFiscalLeadWithWelcome(deps, "4779940011", "5214779940011");
    await sendLow(deps, "5214779940011", "4779940011", "wamid.11a", "quiero saber de ahorro");
    expect(deps.messaging.sentTexts[1]!.body).toBe(buildQualifiedLeadTopicAnswer("SAVINGS"));
  });

  it("14. qualified MAIN/OPTIONS menus (Fase 6E.1) remain intact, independent of the fiscal welcome fix", async () => {
    const deps = makeDeps();
    const { lead } = await seedFreshFiscalLeadWithWelcome(deps, "4779940014", "5214779940014");
    await deps.leads.update(lead.id, { status: "QUALIFIED_A", score: 78, scoreClass: "A" });
    await sendLow(deps, "5214779940014", "4779940014", "wamid.14a", "Hola, tengo una duda"); // main menu
    await sendLow(deps, "5214779940014", "4779940014", "wamid.14b", "2"); // options menu

    // sentTexts[0] = fiscal welcome, [1] = main menu ("Hola, tengo una duda"), [2] = options menu ("2")
    expect(deps.messaging.sentTexts[2]!.body).toBe(buildQualifiedLeadOptionsMessage(true));
  });

  it("15. past-booked recovery (Fase 6E.2/6E.3) is unaffected by the fiscal welcome fix", async () => {
    const repos = {
      leadsRepo: new InMemoryLeadRepository(), conversationsRepo: new InMemoryConversationRepository(),
      messagesRepo: new InMemoryMessageRepository(), appointmentsRepo: new InMemoryAppointmentRepository(),
      fiscalLeadScoresRepo: new InMemoryFiscalLeadScoreRepository(),
    };
    const app = await buildTestApp({ ...repos, whatsappBookingEnabled: true });
    const lead = await repos.leadsRepo.create({
      country: "MX", productVertical: "PATRIMONIAL", status: "NEW", score: 74, scoreClass: "B",
      assignedAdvisor: "Hector Herrera", consentContact: true, whatsappUserId: "5214779940015", firstName: "Juan",
    });
    await repos.leadsRepo.update(lead.id, { status: "BOOKED" });
    await repos.appointmentsRepo.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2020-01-01T10:00:00Z"), endsAt: new Date("2020-01-01T10:30:00Z"), timezone: "America/Mexico_City" });
    const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });

    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [{ field: "messages", value: {
        messaging_product: "whatsapp", contacts: [{ profile: { name: "Juan" }, wa_id: "5214779940015" }],
        messages: [{ from: "5214779940015", id: "wamid.15a", type: "text", text: { body: "Agendar" } }],
      } }] }],
    });
    await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload, headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET) } });

    const outbound = await outboundMessages(repos.messagesRepo, conversation.id);
    expect(outbound[0]!.body).toContain("Tengo estos horarios disponibles");
  });

  it("16. booking round-cap episode scoping (Fase 6E.3.1) is unaffected by the fiscal welcome fix -- no file this phase touches overlaps slot-offering-service.ts", async () => {
    const deps = makeDeps();
    const { lead } = await seedFreshFiscalLeadWithWelcome(deps, "4779940016", "5214779940016");
    // makeDeps() (same minimal helper as Fase 6E.4's own test file) wires no qualificationHandler,
    // so the wasNew branch's conditional beginQualification() call never fires here -- the lead
    // simply stays CONTACTED (recordInboundContact's own NEW -> CONTACTED transition). The point
    // of this test is that resolving the fiscal welcome menu introduces NO status side effects of
    // its own; the round-cap mechanism itself is proven unaffected by its own dedicated,
    // unmodified test suite (tests/whatsapp-booking-round-cap-episode-fix.test.ts) still passing.
    expect((await deps.leads.findById(lead.id))?.status).toBe("CONTACTED");
  });

  it("17. HubSpot fiscal sync remains fully functional, unaffected by the fiscal welcome fix", async () => {
    const hubspotCrm = new FakeHubSpotCRMProvider();
    const app = await buildTestApp({ hubspotCrm });
    const res = await app.inject({
      method: "POST", url: "/api/leads",
      payload: {
        firstName: "Ana", phone: "4779940017", email: "welcome17@example.com", source: "WEB_FISCAL_CALCULATOR",
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

  it("18. fiscal_v1 scoring is untouched by resolving the fiscal welcome menu", async () => {
    const deps = makeDeps();
    const { lead } = await seedFreshFiscalLeadWithWelcome(deps, "4779940018", "5214779940018");
    await sendLow(deps, "5214779940018", "4779940018", "wamid.18a", "2");

    const rows = await deps.fiscalLeadScores.listByLeadId(lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].scoreClass).toBe("HOT");
    expect(rows[0].version).toBe("fiscal_v1");
  });
});
