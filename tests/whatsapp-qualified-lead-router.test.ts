import { describe, expect, it } from "vitest";
import { handleInboundWhatsAppText, type InboundWhatsAppText } from "../src/application/whatsapp-inbound-service.js";
import { LeadService } from "../src/application/services.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository, InMemoryLeadScoreRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryFiscalLeadScoreRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import {
  buildFiscalContextWelcomeMessage, QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE, buildQualifiedLeadAskQuestionMessage,
  buildQualifiedLeadTopicAnswer, buildQualifiedLeadOptionsMessage, QUALIFIED_LEAD_BOOKING_FALLBACK_MESSAGE,
} from "../src/domain/message-templates.js";
import type { FiscalLeadScore } from "../src/domain/fiscal-lead-score.js";

/**
 * Fase 6C -- qualified-lead conversation router, end-to-end via handleInboundWhatsAppText.
 * Reproduces the real production shape: a fiscal-context lead (score 78/A, fiscal HOT/90) that
 * reached QUALIFIED_A, already exchanged the first-inbound fiscal welcome, and now sends genuine
 * follow-up messages -- WHATSAPP_BOOKING_ENABLED stays false throughout (no bookingHandler wired).
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
    leadId,
    submissionId: "sub-1",
    score: 90,
    scoreClass: "HOT",
    version: "fiscal_v1",
    reasons: [{ code: "MONTHLY_INCOME_150K_PLUS", points: 40 }],
    monthlyIncomeBand: "150K_PLUS",
    annualContributionBand: "180K_PLUS",
    hasPpr: false,
    filesAnnualReturn: true,
  } satisfies Omit<FiscalLeadScore, "id" | "createdAt">);
}

/** Reproduces the exact real production lead: QUALIFIED_A / score 78 / scoreClass "A" (WhatsApp
 * A/B/C qualifier), fiscal HOT/90 (fiscal_v1, completely separate), first fiscal-welcome exchange
 * already happened. */
async function seedQualifiedAFiscalLeadWithWelcome(deps: ReturnType<typeof makeDeps>, phone: string, waId: string) {
  const lead = await deps.leadService.createLead({ firstName: "Ana", phone, source: "WEB_FISCAL_CALCULATOR", consentContact: false });
  await seedFiscalScore(deps.fiscalLeadScores, lead.id);
  await deps.leads.update(lead.id, { status: "QUALIFIED_A", score: 78, scoreClass: "A", qualifiedAt: new Date("2026-01-01T00:00:00.000Z") });

  await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: waId, phoneRaw: phone, providerMessageId: "wamid.fiscal-1", text: PREFILLED_TEXT }));
  return { lead: (await deps.leads.findById(lead.id))! };
}

async function send(deps: ReturnType<typeof makeDeps>, waId: string, phone: string, msgId: string, text: string) {
  return handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: waId, phoneRaw: phone, providerMessageId: msgId, text }));
}

describe("Fase 6C -- qualified-lead conversation router", () => {
  it("A: an explicit PPR question gets a real PPR answer, not the same generic menu loop", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776000001", "5214776000001");

    await send(deps, "5214776000001", "4776000001", "wamid.a1", "¿Cómo funciona el PPR?");

    expect(deps.messaging.sentTexts).toHaveLength(2); // welcome + PPR answer
    const reply = deps.messaging.sentTexts[1].body;
    expect(reply).toBe(buildQualifiedLeadTopicAnswer("PPR"));
    expect(reply).not.toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE); // not JUST the bare menu again
    expect(reply.toLowerCase()).toContain("ppr");
  });

  it("B: '1' after the main menu was shown asks for the question, not the same menu again", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776000002", "5214776000002");
    // First follow-up: unrecognized text -> triggers the main menu (and marks it pending).
    await send(deps, "5214776000002", "4776000002", "wamid.b1", "Hola, tengo una duda");
    expect(deps.messaging.sentTexts[1].body).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);

    await send(deps, "5214776000002", "4776000002", "wamid.b2", "1");

    expect(deps.messaging.sentTexts).toHaveLength(3);
    expect(deps.messaging.sentTexts[2].body).toBe(buildQualifiedLeadAskQuestionMessage(true)); // fiscal context present
    expect(deps.messaging.sentTexts[2].body).not.toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
  });

  it("C: '2' after the main menu was shown enters the options exploration, not the same menu again", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776000003", "5214776000003");
    await send(deps, "5214776000003", "4776000003", "wamid.c1", "Hola, tengo una duda");

    await send(deps, "5214776000003", "4776000003", "wamid.c2", "2");

    expect(deps.messaging.sentTexts).toHaveLength(3);
    expect(deps.messaging.sentTexts[2].body).toBe(buildQualifiedLeadOptionsMessage(true)); // fiscal context present -> retirement first
    expect(deps.messaging.sentTexts[2].body).not.toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
    expect(deps.messaging.sentTexts[2].body).not.toMatch(/HOT|WARM|NURTURE|90/i);
  });

  it("D: '3' after the main menu was shown gets the safe booking fallback -- no booking is created (flag=false)", async () => {
    const deps = makeDeps();
    const { lead } = await seedQualifiedAFiscalLeadWithWelcome(deps, "4776000004", "5214776000004");
    await send(deps, "5214776000004", "4776000004", "wamid.d1", "Hola, tengo una duda");

    await send(deps, "5214776000004", "4776000004", "wamid.d2", "3");

    expect(deps.messaging.sentTexts).toHaveLength(3);
    expect(deps.messaging.sentTexts[2].body).toBe(QUALIFIED_LEAD_BOOKING_FALLBACK_MESSAGE);
    expect(deps.messaging.sentTexts[2].body).not.toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);

    const after = await deps.leads.findById(lead.id);
    expect(after?.status).toBe("QUALIFIED_A"); // never moved to BOOKING_PENDING
    expect(after?.bookingStartedAt).toBeUndefined();
    expect(after?.bookedAt).toBeUndefined();
  });

  it("E: 'Quiero conocer opciones' behaves the same as pressing 2, even with no prior menu shown", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776000005", "5214776000005");

    await send(deps, "5214776000005", "4776000005", "wamid.e1", "Quiero conocer opciones");

    expect(deps.messaging.sentTexts).toHaveLength(2);
    expect(deps.messaging.sentTexts[1].body).toBe(buildQualifiedLeadOptionsMessage(true));
  });

  it("F: 'Quiero agendar una cita' behaves the same as pressing 3, even with no prior menu shown", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776000006", "5214776000006");

    await send(deps, "5214776000006", "4776000006", "wamid.f1", "Quiero agendar una cita");

    expect(deps.messaging.sentTexts).toHaveLength(2);
    expect(deps.messaging.sentTexts[1].body).toBe(QUALIFIED_LEAD_BOOKING_FALLBACK_MESSAGE);
  });

  it("G: a GMM question routes to the GMM explanation", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776000007", "5214776000007");

    await send(deps, "5214776000007", "4776000007", "wamid.g1", "¿Qué cubre el GMM?");

    expect(deps.messaging.sentTexts).toHaveLength(2);
    expect(deps.messaging.sentTexts[1].body).toBe(buildQualifiedLeadTopicAnswer("GMM"));
    expect(deps.messaging.sentTexts[1].body.toLowerCase()).toContain("gastos médicos".toLowerCase());
  });

  it("H: genuinely unrecognized text falls back to the (still functional) generic menu", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776000008", "5214776000008");

    await send(deps, "5214776000008", "4776000008", "wamid.h1", "Hola, buenas tardes");

    expect(deps.messaging.sentTexts).toHaveLength(2);
    expect(deps.messaging.sentTexts[1].body).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
  });

  it("I: second and third follow-up turns never re-trigger the fiscal welcome", async () => {
    const deps = makeDeps();
    await seedQualifiedAFiscalLeadWithWelcome(deps, "4776000009", "5214776000009");
    await send(deps, "5214776000009", "4776000009", "wamid.i1", "¿Cómo funciona el PPR?");
    await send(deps, "5214776000009", "4776000009", "wamid.i2", "3");

    const fiscalWelcomeCount = deps.messaging.sentTexts.filter((m) => m.body === buildFiscalContextWelcomeMessage("Ana")).length;
    expect(fiscalWelcomeCount).toBe(1); // only the very first turn
    expect(deps.messaging.sentTexts).toHaveLength(3);
  });

  it("J: fiscal HOT never modifies the A/B/C WhatsApp-qualifier fields or lifecycle, across multiple follow-ups", async () => {
    const deps = makeDeps();
    const { lead } = await seedQualifiedAFiscalLeadWithWelcome(deps, "4776000010", "5214776000010");
    await send(deps, "5214776000010", "4776000010", "wamid.j1", "¿Cómo funciona el PPR?");
    await send(deps, "5214776000010", "4776000010", "wamid.j2", "2");
    await send(deps, "5214776000010", "4776000010", "wamid.j3", "3");

    const after = await deps.leads.findById(lead.id);
    expect(after?.status).toBe("QUALIFIED_A");
    expect(after?.score).toBe(78); // A/B/C field, untouched by fiscal 90
    expect(after?.scoreClass).toBe("A");
    expect(after?.qualifiedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z"); // untouched
    expect(after?.bookingStartedAt).toBeUndefined();
    expect(after?.bookedAt).toBeUndefined();
  });

  it("K: DO_NOT_CONTACT/HUMAN_HANDOFF stay fully suppressed -- the router never runs for them", async () => {
    const deps = makeDeps();
    const lead = await deps.leadService.createLead({ phone: "4776000011", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, lead.id);
    await deps.leads.update(lead.id, { status: "DO_NOT_CONTACT" });

    await send(deps, "5214776000011", "4776000011", "wamid.k1", "¿Cómo funciona el PPR?");

    expect(deps.messaging.sentTexts).toHaveLength(0);
  });

  it("L: no outbound is ever sent except in direct response to a real inbound message", async () => {
    const deps = makeDeps();
    const lead = await deps.leadService.createLead({ phone: "4776000012", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, lead.id);
    await deps.leads.update(lead.id, { status: "QUALIFIED_A", score: 78, scoreClass: "A" });
    // Nothing sent merely by seeding fiscal data and a status -- no proactive path exists.
    expect(deps.messaging.sentTexts).toHaveLength(0);
  });
});
