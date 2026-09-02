import { describe, expect, it } from "vitest";
import { handleInboundWhatsAppText, type InboundWhatsAppText, type WhatsAppInboundDeps } from "../src/application/whatsapp-inbound-service.js";
import { LeadService } from "../src/application/services.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository, InMemoryLeadScoreRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryFiscalLeadScoreRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { buildWelcomeMessage, buildFiscalContextWelcomeMessage } from "../src/domain/message-templates.js";
import type { FiscalLeadScore } from "../src/domain/fiscal-lead-score.js";
import type { QualificationTurnHandler } from "../src/application/whatsapp-inbound-service.js";

/**
 * Fase 6B -- WhatsApp inbound fiscal context bridge tests. Reuses the exact makeDeps() pattern
 * from tests/whatsapp-inbound-service.test.ts (direct handleInboundWhatsAppText calls, no HTTP
 * layer), extended with an InMemoryFiscalLeadScoreRepository.
 */

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

const PREFILLED_TEXT = "Hola, acabo de realizar mi estimación fiscal en Baluarte Capital y quiero revisar mi resultado.";

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

async function seedFiscalScore(
  fiscalLeadScores: InMemoryFiscalLeadScoreRepository,
  leadId: string,
  overrides: Partial<Omit<FiscalLeadScore, "id" | "createdAt" | "leadId">> = {},
): Promise<FiscalLeadScore | null> {
  return fiscalLeadScores.tryCreate({
    leadId,
    submissionId: overrides.submissionId ?? "sub-1",
    score: overrides.score ?? 100,
    scoreClass: overrides.scoreClass ?? "HOT",
    version: overrides.version ?? "fiscal_v1",
    reasons: overrides.reasons ?? [{ code: "MONTHLY_INCOME_150K_PLUS", points: 40 }],
    monthlyIncomeBand: overrides.monthlyIncomeBand ?? "150K_PLUS",
    annualContributionBand: overrides.annualContributionBand ?? "180K_PLUS",
    hasPpr: overrides.hasPpr ?? false,
    filesAnnualReturn: overrides.filesAnnualReturn ?? true,
  });
}

describe("Fase 6B -- WhatsApp inbound fiscal context bridge", () => {
  it("1. an inbound message from a phone with fiscal context recovers it (log + message metadata)", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4771234567", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);

    const result = await handleInboundWhatsAppText(deps, baseInput());
    expect(result.leadId).toBe(fiscalLead.id);

    const resolvedLog = deps.logger.warnings.find((w) => w.message === "fiscal context resolved for whatsapp inbound");
    expect(resolvedLog?.details.contextFound).toBe(true);
    expect(resolvedLog?.details.scoreClass).toBe("HOT");

    const list = await deps.messages.listByConversationId(result.conversationId!);
    const inbound = list.find((m) => m.direction === "INBOUND");
    expect(inbound?.metadata).toMatchObject({ origin: "FISCAL_CALCULATOR", fiscalContextAvailable: true });
  });

  it("2. an inbound message from a phone WITHOUT fiscal context behaves exactly as before this phase", async () => {
    const deps = makeDeps();
    const result = await handleInboundWhatsAppText(deps, baseInput());
    const resolvedLog = deps.logger.warnings.find((w) => w.message === "fiscal context resolved for whatsapp inbound");
    expect(resolvedLog?.details.contextFound).toBe(false);

    const list = await deps.messages.listByConversationId(result.conversationId!);
    const inbound = list.find((m) => m.direction === "INBOUND");
    expect(inbound?.metadata).not.toHaveProperty("origin");

    expect(deps.messaging.sentTexts).toHaveLength(1);
    expect(deps.messaging.sentTexts[0].body).toBe(buildWelcomeMessage("Ana"));
  });

  it("3. the lookup matches via normalized E.164 phone, even when the raw WhatsApp form differs from how the lead was captured", async () => {
    const deps = makeDeps();
    // Captured via the web calculator with a plain 10-digit MX number.
    const fiscalLead = await deps.leadService.createLead({ phone: "4771234567", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);

    // WhatsApp delivers the legacy wa_id form ("521" + 10 digits) -- normalizePhoneToE164 strips
    // the extra "1" so both resolve to the same +524771234567.
    const result = await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214771234567", phoneRaw: "5214771234567" }));
    expect(result.leadId).toBe(fiscalLead.id);
    const resolvedLog = deps.logger.warnings.find((w) => w.message === "fiscal context resolved for whatsapp inbound");
    expect(resolvedLog?.details.contextFound).toBe(true);
  });

  it("4. a HOT fiscal score never modifies leads.scoreClass (the separate A/B/C WhatsApp-qualifier field)", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4772222222", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id, { scoreClass: "HOT" });
    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214772222222", phoneRaw: "5214772222222" }));
    const lead = await deps.leads.findById(fiscalLead.id);
    expect(lead?.scoreClass).toBeUndefined();
    expect(lead?.score).toBe(0);
  });

  it("5. a WARM fiscal score does not alter lifecycle fields", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4773333333", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id, { scoreClass: "WARM", score: 50 });
    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214773333333", phoneRaw: "5214773333333" }));
    const lead = await deps.leads.findById(fiscalLead.id);
    expect(lead?.qualifiedAt).toBeUndefined();
    expect(lead?.bookingStartedAt).toBeUndefined();
    expect(lead?.bookedAt).toBeUndefined();
    expect(lead?.status).toBe("CONTACTED"); // the existing pipeline's own normal Phase 2 transition, unrelated to fiscal
  });

  it("6. a NURTURE fiscal score does not alter lifecycle fields", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4774444444", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id, { scoreClass: "NURTURE", score: 0 });
    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214774444444", phoneRaw: "5214774444444" }));
    const lead = await deps.leads.findById(fiscalLead.id);
    expect(lead?.qualifiedAt).toBeUndefined();
    expect(lead?.assignedAdvisor).toBe("Hector Herrera"); // untouched default, not fiscal-driven
  });

  it("7. a fiscal repository failure is fail-open -- WhatsApp keeps working, no context is used, safe warning logged", async () => {
    const deps = makeDeps();
    const throwingFiscalScores = {
      tryCreate: async () => { throw new Error("unused"); },
      listByLeadId: async (): Promise<FiscalLeadScore[]> => { throw new Error("SUPABASE_FISCAL_LEAD_SCORE_LIST_FAILED: connection refused to db.internal:5432"); },
    };
    const failingDeps = { ...deps, fiscalLeadScores: throwingFiscalScores };

    const result = await handleInboundWhatsAppText(failingDeps, baseInput({ text: PREFILLED_TEXT }));
    expect(result.outcome).toBe("PROCESSED");
    expect(deps.messaging.sentTexts).toHaveLength(1);
    // Fails open to the generic welcome -- never the fiscal-acknowledgment variant, since
    // fiscalContext stayed null after the failure.
    expect(deps.messaging.sentTexts[0].body).toBe(buildWelcomeMessage("Ana"));

    const failureLog = deps.logger.warnings.find((w) => w.message.includes("fiscal context lookup failed"));
    expect(failureLog).toBeTruthy();
    expect(JSON.stringify(failureLog?.details)).not.toContain("db.internal");
  });

  it("8. exact financial figures never appear in any log line, even with fiscal context present", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4775555555", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);
    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214775555555", phoneRaw: "5214775555555" }));
    const serialized = JSON.stringify(deps.logger.warnings);
    expect(serialized).not.toContain("160000");
    expect(serialized).not.toContain("200000");
    expect(serialized).not.toContain("@example.com");
  });

  it("9. the internal context uses bands, never exact amounts -- and the persisted message metadata carries no bands/score at all", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4776666666", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);
    const result = await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214776666666", phoneRaw: "5214776666666" }));
    const list = await deps.messages.listByConversationId(result.conversationId!);
    const inbound = list.find((m) => m.direction === "INBOUND");
    expect(Object.keys(inbound?.metadata ?? {}).sort()).toEqual(["fiscalContextAvailable", "origin"]);
  });

  it("10. the latest fiscal submission wins when several exist for the same lead", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4777777777", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id, { submissionId: "sub-old", scoreClass: "NURTURE", score: 0 });
    await new Promise((r) => setTimeout(r, 5)); // ensure a distinct createdAt for the second row
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id, { submissionId: "sub-new", scoreClass: "HOT", score: 100 });

    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214777777777", phoneRaw: "5214777777777" }));
    const resolvedLog = deps.logger.warnings.find((w) => w.message === "fiscal context resolved for whatsapp inbound");
    expect(resolvedLog?.details.scoreClass).toBe("HOT"); // the newer row, not the older NURTURE one
  });

  it("11. the exact prefilled calculator message triggers the fiscal-acknowledgment welcome (no score/bands mentioned)", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4778888888", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);

    const result = await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214778888888", phoneRaw: "5214778888888", text: PREFILLED_TEXT }));
    expect(deps.messaging.sentTexts).toHaveLength(1);
    expect(deps.messaging.sentTexts[0].body).toBe(buildFiscalContextWelcomeMessage("Ana"));
    expect(deps.messaging.sentTexts[0].body).not.toMatch(/HOT|WARM|NURTURE|score|150K|180K/i);

    const list = await deps.messages.listByConversationId(result.conversationId!);
    expect(list.find((m) => m.direction === "OUTBOUND")?.body).not.toMatch(/HOT|WARM|NURTURE/i);
  });

  it("12. a normal (non-prefilled) message from the same fiscal-context lead still resolves the context internally, even though the reply stays generic", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4779999999", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);

    // First message: plain text, no calculator mention -- still gets the fiscal context resolved
    // internally (contextFound: true), but the WELCOME reply stays the generic one because the
    // text itself doesn't suggest calculator origin (item 6's second condition).
    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214779999999", phoneRaw: "5214779999999", text: "Hola, buenas tardes" }));
    const resolvedLog = deps.logger.warnings.find((w) => w.message === "fiscal context resolved for whatsapp inbound");
    expect(resolvedLog?.details.contextFound).toBe(true);
    expect(deps.messaging.sentTexts[0].body).toBe(buildWelcomeMessage("Ana"));
  });

  it("13. a different phone never receives another lead's fiscal context", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4771010101", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);

    // A different, unrelated phone writes in -- must never pick up fiscalLead's context.
    const result = await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214772020202", phoneRaw: "5214772020202", providerMessageId: "wamid.other" }));
    expect(result.leadId).not.toBe(fiscalLead.id);
    const resolvedLog = deps.logger.warnings.find((w) => w.message === "fiscal context resolved for whatsapp inbound" && w.details.leadIdLast8 === result.leadId!.slice(-8));
    expect(resolvedLog?.details.contextFound).toBe(false);
  });

  it("14. fiscal context retrieval never creates a duplicate lead for an existing fiscal-calculator lead", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4771111199", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);

    const result = await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214771111199", phoneRaw: "5214771111199" }));
    expect(result.leadId).toBe(fiscalLead.id); // reused, not duplicated
    const byDedup = await deps.leads.findByDedupKey({ phoneE164: "+524771111199" });
    expect(byDedup?.id).toBe(fiscalLead.id);
  });

  it("15. webhook idempotency (duplicate providerMessageId) is unaffected by fiscal context", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4771212121", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);

    const input = baseInput({ whatsappUserId: "5214771212121", phoneRaw: "5214771212121" });
    const first = await handleInboundWhatsAppText(deps, input);
    const second = await handleInboundWhatsAppText(deps, input); // exact same providerMessageId
    expect(first.outcome).toBe("PROCESSED");
    expect(second.outcome).toBe("DUPLICATE");
    expect(deps.messaging.sentTexts).toHaveLength(1); // no second reply
  });

  it("16. booking stays disabled (WHATSAPP_BOOKING_ENABLED off -- bookingHandler absent) even with fiscal context present", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4771313131", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);
    await deps.leads.update(fiscalLead.id, { status: "QUALIFIED_A" });

    const depsWithoutBooking: WhatsAppInboundDeps = { ...deps }; // bookingHandler intentionally omitted
    const result = await handleInboundWhatsAppText(depsWithoutBooking, baseInput({ whatsappUserId: "5214771313131", phoneRaw: "5214771313131", text: "quiero agendar" }));
    expect(result.outcome).toBe("PROCESSED");
    expect(deps.messaging.sentTexts).toHaveLength(0); // no-match fallback, exactly as before this phase
  });

  it("17. qualification A/B/C keeps working unchanged when fiscal context is present", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4771414141", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);
    await deps.leads.update(fiscalLead.id, { status: "QUALIFYING" });

    let handledTurn = false;
    const qualificationHandler: QualificationTurnHandler = {
      beginQualification: async () => {},
      handleTurn: async () => { handledTurn = true; },
    };
    const depsWithQualifier = { ...deps, qualificationHandler };
    const result = await handleInboundWhatsAppText(depsWithQualifier, baseInput({ whatsappUserId: "5214771414141", phoneRaw: "5214771414141", text: "quiero ahorrar" }));
    expect(result.outcome).toBe("PROCESSED");
    expect(handledTurn).toBe(true); // fiscal context did not intercept or reroute this turn
  });

  it("18. no outbound message is ever sent without a real inbound message triggering handleInboundWhatsAppText", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4771515151", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);
    // Merely having a fiscal context available for a lead sends nothing on its own -- there is no
    // proactive-send API in this codebase that fiscal context could trigger; the only way any
    // WhatsApp text ever goes out is via handleInboundWhatsAppText, which requires a real inbound
    // message as input.
    expect(deps.messaging.sentTexts).toHaveLength(0);
  });
});

/**
 * Fase 6B.1 -- corrects the "first WhatsApp inbound" signal used to decide the fiscal-contextual
 * welcome. wasNew (lead.status === "NEW") happens to be true in the simplest, untouched web
 * capture -> WhatsApp path, but is NOT a reliable "first WhatsApp inbound" signal in general: a
 * lead's status can move away from NEW for reasons entirely unrelated to WhatsApp (e.g. a manual
 * CRM "/contact" call) before their first genuine WhatsApp message ever arrives. These tests
 * exercise exactly that edge case -- status manually moved to CONTACTED before the first WhatsApp
 * message -- to prove the fiscal welcome no longer silently depends on wasNew.
 */
describe("Fase 6B.1 -- fiscal-contextual welcome uses real first-WhatsApp-inbound history, not lead.status", () => {
  it("1+2. a preexisting web lead with fiscal context whose status already moved away from NEW still gets the contextual welcome on its genuinely first WhatsApp inbound (wasNew === false)", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4772121001", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);
    // Simulates a manual CRM "/contact" call (or any other non-WhatsApp touch) that happened
    // BEFORE this lead ever wrote in on WhatsApp -- moves status away from "NEW".
    await deps.leads.update(fiscalLead.id, { status: "CONTACTED" });
    const beforeInbound = await deps.leads.findById(fiscalLead.id);
    expect(beforeInbound?.status).not.toBe("NEW"); // explicit proof wasNew will be false

    const result = await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214772121001", phoneRaw: "4772121001", text: PREFILLED_TEXT }));
    expect(result.outcome).toBe("PROCESSED");
    expect(deps.messaging.sentTexts).toHaveLength(1);
    expect(deps.messaging.sentTexts[0].body).toBe(buildFiscalContextWelcomeMessage("Ana"));

    const branchLog = deps.logger.warnings.find((w) => w.details.branch === "existing-lead-first-whatsapp-fiscal-welcome");
    expect(branchLog).toBeTruthy(); // confirms the NEW branch fired, not the wasNew one
  });

  it("3. a second WhatsApp inbound from the same lead never repeats the contextual welcome", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4772121002", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);
    await deps.leads.update(fiscalLead.id, { status: "CONTACTED" });

    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214772121002", phoneRaw: "4772121002", providerMessageId: "wamid.first", text: PREFILLED_TEXT }));
    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214772121002", phoneRaw: "4772121002", providerMessageId: "wamid.second", text: PREFILLED_TEXT }));

    expect(deps.messaging.sentTexts).toHaveLength(1); // only the first turn's welcome, never a second one
    expect(deps.messaging.sentTexts[0].body).toBe(buildFiscalContextWelcomeMessage("Ana"));
  });

  it("4. a retry of the exact first webhook (same providerMessageId) never duplicates the contextual welcome", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4772121003", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);
    await deps.leads.update(fiscalLead.id, { status: "CONTACTED" });

    const input = baseInput({ whatsappUserId: "5214772121003", phoneRaw: "4772121003", providerMessageId: "wamid.retry-me", text: PREFILLED_TEXT });
    const first = await handleInboundWhatsAppText(deps, input);
    const retry = await handleInboundWhatsAppText(deps, input); // literal webhook retry, same providerMessageId

    expect(first.outcome).toBe("PROCESSED");
    expect(retry.outcome).toBe("DUPLICATE");
    expect(deps.messaging.sentTexts).toHaveLength(1); // no second send for the retry
  });

  it("5. a preexisting web lead WITHOUT fiscal context behaves as normal (no contextual welcome) even with status already moved off NEW", async () => {
    const deps = makeDeps();
    const nonFiscalLead = await deps.leadService.createLead({ phone: "4772121004", source: "WEB", consentContact: false });
    await deps.leads.update(nonFiscalLead.id, { status: "CONTACTED" });

    const result = await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214772121004", phoneRaw: "4772121004", text: PREFILLED_TEXT }));
    expect(result.outcome).toBe("PROCESSED");
    // No fiscalContext, no qualificationHandler/bookingHandler wired -- falls through to the
    // existing "no-match" fallback, exactly as it would have before Fase 6B/6B.1 existed.
    expect(deps.messaging.sentTexts).toHaveLength(0);
    const branchLog = deps.logger.warnings.find((w) => w.details.branch === "no-match");
    expect(branchLog).toBeTruthy();
  });

  it("6. a fiscal-context lead's first inbound that does NOT mention the calculator does not force the contextual welcome (fiscalContext stays available internally)", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4772121005", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id);
    await deps.leads.update(fiscalLead.id, { status: "CONTACTED" });

    const result = await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214772121005", phoneRaw: "4772121005", text: "Hola, buenas tardes" }));
    expect(result.outcome).toBe("PROCESSED");
    expect(deps.messaging.sentTexts).toHaveLength(0); // no forced welcome
    const resolvedLog = deps.logger.warnings.find((w) => w.message === "fiscal context resolved for whatsapp inbound");
    expect(resolvedLog?.details.contextFound).toBe(true); // still resolved internally, just not surfaced
  });

  it("7. a brand-new WhatsApp-only lead with no fiscal context keeps the exact pre-Fase-6B welcome behavior", async () => {
    const deps = makeDeps();
    const result = await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214772121006", phoneRaw: "4772121006" }));
    expect(result.outcome).toBe("PROCESSED");
    expect(deps.messaging.sentTexts).toHaveLength(1);
    expect(deps.messaging.sentTexts[0].body).toBe(buildWelcomeMessage("Ana"));
    const branchLog = deps.logger.warnings.find((w) => w.details.branch === "wasNew-welcome");
    expect(branchLog).toBeTruthy();
  });

  it("8. status, WhatsApp-qualifier score/scoreClass (A/B/C), and lifecycle fields stay untouched by the new fiscal-welcome branch", async () => {
    const deps = makeDeps();
    const fiscalLead = await deps.leadService.createLead({ phone: "4772121007", source: "WEB_FISCAL_CALCULATOR", consentContact: false });
    await seedFiscalScore(deps.fiscalLeadScores, fiscalLead.id, { scoreClass: "HOT", score: 100 });
    await deps.leads.update(fiscalLead.id, { status: "CONTACTED" });

    await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214772121007", phoneRaw: "4772121007", text: PREFILLED_TEXT }));

    const lead = await deps.leads.findById(fiscalLead.id);
    expect(lead?.status).toBe("CONTACTED"); // the new branch never mutates status itself
    expect(lead?.scoreClass).toBeUndefined(); // A/B/C field, never touched by fiscal HOT
    expect(lead?.score).toBe(0); // WhatsApp-qualifier numeric score, untouched
    expect(lead?.qualifiedAt).toBeUndefined();
    expect(lead?.bookingStartedAt).toBeUndefined();
    expect(lead?.bookedAt).toBeUndefined();
  });
});
