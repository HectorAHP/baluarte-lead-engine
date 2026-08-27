import { describe, expect, it } from "vitest";
import { WhatsAppQualificationHandler } from "../src/application/whatsapp-qualification-handler.js";
import { LeadService } from "../src/application/services.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryQualificationAnswerRepository, InMemoryLeadScoreRepository, InMemoryLeadStatusHistoryRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { NURTURE_C_MESSAGE, QUALIFICATION_COMPLETE_AB_MESSAGE } from "../src/domain/message-templates.js";

const noopLogger = { warn: () => {} };

// Turn 1 always resolves intent (asks the first catalog question); it never answers a field
// itself. SAVINGS has 5 questions, so a full completion needs 1 (intent) + 5 (answers) = 6 turns.
const STRONG_SAVINGS_TURNS = ["1", "1", "1", "5", "sí", "1"]; // SAVINGS, patrimonio, <3y, 20000+, yes-extra, this-month -> A
// One deliberately unparseable reply ("xyz") is an extra inbound message beyond the minimum
// needed, which computeEngagement() reads as a re-ask; "5" (OTRO) also reads as an AMBIGUOUS
// objective -- combined with the worst urgency/capacity, this lands comfortably in C.
const WEAK_SAVINGS_TURNS = ["1", "xyz", "5", "1", "1", "no", "3"]; // SAVINGS, retry, otro, <3y, <2000, no-extra, comparing -> C

function buildHarness() {
  const leads = new InMemoryLeadRepository();
  const conversations = new InMemoryConversationRepository();
  const messages = new InMemoryMessageRepository();
  const qualificationAnswers = new InMemoryQualificationAnswerRepository();
  const leadScores = new InMemoryLeadScoreRepository();
  const messaging = new FakeMessagingProvider();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const leadService = new LeadService(leads, leadScores, leadStatusHistory, noopLogger);
  const handler = new WhatsAppQualificationHandler({ leads, conversations, messages, qualificationAnswers, leadScores, leadService, messaging, leadStatusHistory, logger: noopLogger });
  return { leads, conversations, messages, qualificationAnswers, leadScores, messaging, leadService, leadStatusHistory, handler };
}

/** Mirrors what persistInboundMessage() in whatsapp-inbound-service.ts does for every real
 * WhatsApp message, so computeEngagement()'s inbound-message-count heuristic sees the same shape
 * of data here as it would in production. */
async function persistInbound(h: ReturnType<typeof buildHarness>, conversationId: string, leadId: string, body: string) {
  await h.messages.create({ conversationId, leadId, direction: "INBOUND", channel: "WHATSAPP", body, aiGenerated: false, metadata: {} });
}

/** Sets up a lead through the same point the real webhook handler reaches right before calling
 * beginQualification(): CONTACTED, with the triggering "Hola"-equivalent message persisted. */
async function setupContactedLead(h: ReturnType<typeof buildHarness>) {
  let lead = await h.leadService.createLead({ firstName: "Ana", phone: "5214771234567", source: "WHATSAPP", whatsappUserId: "5214771234567" });
  lead = await h.leadService.markContacted(lead.id);
  const conversation = await h.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  await persistInbound(h, conversation.id, lead.id, "Hola");
  return { lead, conversation };
}

async function runTurns(h: ReturnType<typeof buildHarness>, conversationId: string, leadId: string, whatsappUserId: string, turns: readonly string[]) {
  let current = (await h.leads.findById(leadId))!;
  for (const text of turns) {
    await persistInbound(h, conversationId, leadId, text);
    await h.handler.handleTurn({ lead: current, conversationId, whatsappUserId, inboundText: text });
    current = (await h.leads.findById(leadId))!;
  }
  return current;
}

describe("WhatsAppQualificationHandler -- persistence", () => {
  it("persists a valid answer as a normalized qualification_answer", async () => {
    const h = buildHarness();
    const { lead, conversation } = await setupContactedLead(h);
    await h.handler.beginQualification(lead.id);

    // Turn 1: "1" selects the SAVINGS product (menu option) and prompts for the objective.
    // Turn 2: "1" now answers the objective question itself.
    await runTurns(h, conversation.id, lead.id, "5214771234567", ["1", "1"]);

    const answers = await h.qualificationAnswers.listByLeadId(lead.id);
    expect(answers).toHaveLength(1);
    expect(answers[0].fieldName).toBe("objective");
    expect(answers[0].fieldValue).toBe("PATRIMONIO");
    expect(answers[0].vertical).toBe("PATRIMONIAL");
  });

  it("keeps lead.productVertical coherent with lead.productInterest for every product (FIX 2)", async () => {
    const h = buildHarness();

    const { lead: savingsLead, conversation: savingsConv } = await setupContactedLead(h);
    await h.handler.beginQualification(savingsLead.id);
    await h.handler.handleTurn({ lead: savingsLead, conversationId: savingsConv.id, whatsappUserId: "u1", inboundText: "1" }); // SAVINGS
    expect((await h.leads.findById(savingsLead.id))?.productInterest).toBe("SAVINGS");
    expect((await h.leads.findById(savingsLead.id))?.productVertical).toBe("PATRIMONIAL");

    const pprLead = await h.leadService.createLead({ phone: "5214779990002", source: "WHATSAPP", whatsappUserId: "u-ppr" });
    await h.leadService.markContacted(pprLead.id);
    const pprConv = await h.conversations.create({ leadId: pprLead.id, channel: "WHATSAPP", status: "ACTIVE" });
    await h.handler.beginQualification(pprLead.id);
    await h.handler.handleTurn({ lead: pprLead, conversationId: pprConv.id, whatsappUserId: "u-ppr", inboundText: "2" }); // RETIREMENT_PPR
    expect((await h.leads.findById(pprLead.id))?.productInterest).toBe("RETIREMENT_PPR");
    expect((await h.leads.findById(pprLead.id))?.productVertical).toBe("PATRIMONIAL");

    const gmmLead = await h.leadService.createLead({ phone: "5214779990003", source: "WHATSAPP", whatsappUserId: "u-gmm" });
    await h.leadService.markContacted(gmmLead.id);
    const gmmConv = await h.conversations.create({ leadId: gmmLead.id, channel: "WHATSAPP", status: "ACTIVE" });
    await h.handler.beginQualification(gmmLead.id);
    await h.handler.handleTurn({ lead: gmmLead, conversationId: gmmConv.id, whatsappUserId: "u-gmm", inboundText: "3" }); // GMM
    expect((await h.leads.findById(gmmLead.id))?.productInterest).toBe("GMM");
    expect((await h.leads.findById(gmmLead.id))?.productVertical).toBe("GMM");
  });

  it("persists GMM location partially, asking only for the missing field, and preserves postal code leading zeros as a string", async () => {
    const h = buildHarness();
    const { lead, conversation } = await setupContactedLead(h);
    await h.handler.beginQualification(lead.id);

    await runTurns(h, conversation.id, lead.id, "u1", [
      "seguro médico", // intent -> GMM, asks coverage_type
      "1", // answers coverage_type, asks age_range
      "1", // answers age_range, asks location
      "León, Guanajuato, 01150", // answers location (leading-zero CP)
    ]);

    const answers = await h.qualificationAnswers.listByLeadId(lead.id);
    const postal = answers.find((a) => a.fieldName === "postal_code");
    expect(postal?.fieldValue).toBe("01150");
    expect(typeof postal?.fieldValue).toBe("string");
  });

  it("never writes spontaneous medical content to qualification_answers", async () => {
    const h = buildHarness();
    const { lead, conversation } = await setupContactedLead(h);
    await h.handler.beginQualification(lead.id);
    const current = await runTurns(h, conversation.id, lead.id, "u1", ["seguro médico"]);

    await persistInbound(h, conversation.id, lead.id, "tengo cáncer y estoy en quimioterapia");
    await h.handler.handleTurn({ lead: current, conversationId: conversation.id, whatsappUserId: "u1", inboundText: "tengo cáncer y estoy en quimioterapia" });

    const answers = await h.qualificationAnswers.listByLeadId(lead.id);
    expect(answers).toHaveLength(0);
    expect(JSON.stringify(answers)).not.toMatch(/cáncer|quimioterapia/i);
  });
});

describe("WhatsAppQualificationHandler -- lifecycle", () => {
  it("beginQualification transitions CONTACTED -> QUALIFYING", async () => {
    const h = buildHarness();
    const { lead } = await setupContactedLead(h);
    await h.handler.beginQualification(lead.id);
    const updated = await h.leads.findById(lead.id);
    expect(updated?.status).toBe("QUALIFYING");
  });

  it("a strong SAVINGS completion reaches QUALIFIED_A with qualified_at set", async () => {
    const h = buildHarness();
    const { lead, conversation } = await setupContactedLead(h);
    await h.handler.beginQualification(lead.id);
    const current = await runTurns(h, conversation.id, lead.id, "u1", STRONG_SAVINGS_TURNS);

    expect(current.status).toBe("QUALIFIED_A");
    expect(current.qualifiedAt).toBeInstanceOf(Date);
    expect(h.messaging.sentTexts.at(-1)?.body).toBe(QUALIFICATION_COMPLETE_AB_MESSAGE);
  });

  it("a weak SAVINGS completion (a re-ask plus a vague objective) reaches NURTURE_C without qualified_at, using the nurture message", async () => {
    const h = buildHarness();
    const { lead, conversation } = await setupContactedLead(h);
    await h.handler.beginQualification(lead.id);
    const current = await runTurns(h, conversation.id, lead.id, "u1", WEAK_SAVINGS_TURNS);

    expect(current.status).toBe("NURTURE_C");
    expect(current.qualifiedAt).toBeUndefined();
    expect(h.messaging.sentTexts.at(-1)?.body).toBe(NURTURE_C_MESSAGE);
  });

  it("a re-entry to QUALIFYING with productInterest still set from the prior round stays silent (no reply), never re-running or re-scoring", async () => {
    // This is the realistic shape of the risk: nothing in this codebase ever clears
    // productInterest, so the *only* existing way to send a NURTURE_C lead back into
    // QUALIFYING -- the manual REST endpoint POST /api/leads/:id/qualification/start, which
    // only transitions status -- leaves productInterest exactly as it was. Reconstruction then
    // treats the prior round's answers as authoritative for the (unchanged) product, finds every
    // field already present, and lands on phase COMPLETED -> ALREADY_TERMINAL: no reply, no
    // re-parsing, no new answer or score. This case needs no new guard; it is already safe.
    const h = buildHarness();
    const { lead, conversation } = await setupContactedLead(h);
    await h.handler.beginQualification(lead.id);
    await runTurns(h, conversation.id, lead.id, "u1", WEAK_SAVINGS_TURNS);
    const answersBefore = await h.qualificationAnswers.listByLeadId(lead.id);
    const scoresBefore = await h.leadScores.listByLeadId(lead.id);
    const repliesBefore = h.messaging.sentTexts.length;

    await h.leadService.startQualification(lead.id); // NURTURE_C -> QUALIFYING, productInterest untouched
    const reentered = (await h.leads.findById(lead.id))!;
    expect(reentered.productInterest).toBe("SAVINGS");

    await persistInbound(h, conversation.id, lead.id, "hola otra vez");
    await h.handler.handleTurn({ lead: reentered, conversationId: conversation.id, whatsappUserId: "u1", inboundText: "hola otra vez" });

    expect(h.messaging.sentTexts).toHaveLength(repliesBefore); // no new automated reply at all
    expect(await h.qualificationAnswers.listByLeadId(lead.id)).toEqual(answersBefore);
    expect(await h.leadScores.listByLeadId(lead.id)).toEqual(scoresBefore);
  });

  it("a re-entry to QUALIFYING with productInterest cleared (e.g. a future 'requalify' admin action) escalates to HUMAN_HANDOFF instead of guessing a product", async () => {
    // Defense-in-depth for a scenario nothing in the codebase can trigger today (no code path
    // clears productInterest), but that a future feature (Phase 3C or later) plausibly could.
    // The explicit guard in handleTurn() -- prior score history + no productInterest -- catches
    // it rather than silently letting the qualifier re-run the intent classifier over stale
    // qualification_answers from the previous round.
    const h = buildHarness();
    const { lead, conversation } = await setupContactedLead(h);
    await h.handler.beginQualification(lead.id);
    await runTurns(h, conversation.id, lead.id, "u1", WEAK_SAVINGS_TURNS);
    const answersBefore = await h.qualificationAnswers.listByLeadId(lead.id);
    const scoresBefore = await h.leadScores.listByLeadId(lead.id);

    await h.leadService.startQualification(lead.id);
    await h.leads.update(lead.id, { productInterest: undefined });
    const current = (await h.leads.findById(lead.id))!;

    await persistInbound(h, conversation.id, lead.id, "1");
    await h.handler.handleTurn({ lead: current, conversationId: conversation.id, whatsappUserId: "u1", inboundText: "1" });

    const afterReentry = await h.leads.findById(lead.id);
    expect(afterReentry?.status).toBe("HUMAN_HANDOFF");

    // No new answers or scores were created from the "1" message -- it was never parsed as an
    // intent selection, and no stale prior-round answer was reused.
    expect(await h.qualificationAnswers.listByLeadId(lead.id)).toEqual(answersBefore);
    expect(await h.leadScores.listByLeadId(lead.id)).toEqual(scoresBefore);
    expect(h.messaging.sentTexts.at(-1)?.body).toContain("asesor de Baluarte Capital");
  });

  it("HUMAN_HANDOFF is a valid transition from QUALIFYING and does not touch qualified_at", async () => {
    const h = buildHarness();
    const { lead, conversation } = await setupContactedLead(h);
    await h.handler.beginQualification(lead.id);

    const current = await runTurns(h, conversation.id, lead.id, "u1", ["quiero hablar con una persona"]);

    expect(current.status).toBe("HUMAN_HANDOFF");
    expect(current.qualifiedAt).toBeUndefined();
    const conv = await h.conversations.findById(conversation.id);
    expect(conv?.status).toBe("HUMAN_HANDOFF");
  });
});

describe("WhatsAppQualificationHandler -- scoring", () => {
  it("uses readiness=6 (WANTS_INFO_FIRST) and tags readinessReason=PRE_APPOINTMENT_OFFER on completion", async () => {
    const h = buildHarness();
    const { lead, conversation } = await setupContactedLead(h);
    await h.handler.beginQualification(lead.id);
    await runTurns(h, conversation.id, lead.id, "u1", STRONG_SAVINGS_TURNS);

    const history = await h.leadScores.listByLeadId(lead.id);
    expect(history).toHaveLength(1);
    expect(history[0].breakdown.readiness).toBe(6);
    expect(history[0].breakdown.readinessReason).toBe("PRE_APPOINTMENT_OFFER");
    expect(history[0].rulesVersion).toBe("PATRIMONIAL_QUALIFICATION_V1");
  });

  it("appends exactly one score record per completed qualification, never mutating an earlier one", async () => {
    const h = buildHarness();
    const { lead: leadA, conversation: convA } = await setupContactedLead(h);
    await h.handler.beginQualification(leadA.id);
    await runTurns(h, convA.id, leadA.id, "u1", WEAK_SAVINGS_TURNS);

    const { lead: leadB, conversation: convB } = await setupContactedLead(h);
    await h.handler.beginQualification(leadB.id);
    await runTurns(h, convB.id, leadB.id, "u2", STRONG_SAVINGS_TURNS);

    const historyA = await h.leadScores.listByLeadId(leadA.id);
    const historyB = await h.leadScores.listByLeadId(leadB.id);
    expect(historyA).toHaveLength(1);
    expect(historyA[0].scoreClass).toBe("C");
    expect(historyB).toHaveLength(1);
    expect(historyB[0].scoreClass).toBe("A");
    // Each lead's history is independent -- completing leadB never touched leadA's record.
    expect(historyA[0].id).not.toBe(historyB[0].id);
  });
});
