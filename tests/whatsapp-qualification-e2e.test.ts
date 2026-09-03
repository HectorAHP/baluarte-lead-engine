import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryQualificationAnswerRepository, InMemoryLeadScoreRepository, InMemoryAppointmentRepository,
  InMemoryBookingAttemptRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import type { MessagingProvider, SendMessageResult } from "../src/application/ports.js";
import { MessagingProviderError } from "../src/domain/errors.js";
import { QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE } from "../src/domain/message-templates.js";
import type { LeadStatus } from "../src/domain/lead.js";

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function textWebhookBody(overrides: { from?: string; id?: string; body?: string; name?: string } = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ profile: { name: overrides.name ?? "Ana" }, wa_id: overrides.from ?? "5214771234567" }],
              messages: [{ from: overrides.from ?? "5214771234567", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
            },
          },
        ],
      },
    ],
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
    calendar: new FakeCalendarProvider(),
  };
}

/**
 * Directly constructs a lead already sitting at a given lifecycle status with an ACTIVE
 * conversation, bypassing the normal transition flow -- a test fixture, not a real transition
 * (mirrors the existing pattern of directly mutating repo state to set up a scenario, used
 * elsewhere in this suite). Used to reproduce "this lead already reached status X" without
 * having to replay an entire prior qualification round.
 */
async function createLeadAtStatus(
  repos: ReturnType<typeof buildRepos>,
  whatsappUserId: string,
  status: LeadStatus,
  productInterest?: string,
) {
  const lead = await repos.leadsRepo.create({
    country: "MX",
    productVertical: "UNKNOWN",
    status: "NEW",
    score: 0,
    assignedAdvisor: "Hector Herrera",
    consentContact: true,
    whatsappUserId,
    productInterest,
  });
  await repos.leadsRepo.update(lead.id, { status, productInterest });
  const conversation = await repos.conversationsRepo.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead: (await repos.leadsRepo.findById(lead.id))!, conversation };
}

async function send(app: Awaited<ReturnType<typeof buildTestApp>>, from: string, id: string, body: string) {
  const payload = textWebhookBody({ from, id, body });
  return app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    payload,
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET) },
  });
}

describe("Phase 3B WhatsApp qualification -- feature flag off (default)", () => {
  it("behaves exactly like Phase 2 -- only the welcome message, no qualifier routing", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    // Explicit override, never relying on config.QUALIFICATION_ENGINE_ENABLED's default: this
    // repo's .env can (and during real E2E validation, does) set the flag to true, and
    // buildApp() falls back to that real value whenever an override isn't supplied. Asserting
    // "flag off" behavior must not depend on what happens to be in the environment right now.
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: false, ...repos });

    const res1 = await send(app, "5214771111111", "wamid.flagoff.1", "Hola");
    expect(res1.statusCode).toBe(200);
    const res2 = await send(app, "5214771111111", "wamid.flagoff.2", "1");
    expect(res2.statusCode).toBe(200);

    expect(messaging.sentTexts).toHaveLength(1); // only the welcome message, no follow-up question
    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: "5214771111111" });
    expect(lead?.status).toBe("CONTACTED"); // never transitions to QUALIFYING
  });
});

describe("Phase 3B WhatsApp qualification -- flag on", () => {
  it("first inbound sends the welcome menu and starts qualification (QUALIFYING)", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });

    const res = await send(app, "5214772000001", "wamid.e2e.1", "Hola");
    expect(res.statusCode).toBe(200);
    expect(messaging.sentTexts).toHaveLength(1);

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: "5214772000001" });
    expect(lead?.status).toBe("QUALIFYING");
  });

  it("a numeric menu selection routes to the right product and asks exactly one question", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });

    await send(app, "5214772000002", "wamid.e2e.2a", "Hola");
    await send(app, "5214772000002", "wamid.e2e.2b", "2"); // Retiro / PPR

    expect(messaging.sentTexts).toHaveLength(2);
    expect(messaging.sentTexts[1].body).toMatch(/edad/i);
    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: "5214772000002" });
    expect(lead?.productInterest).toBe("RETIREMENT_PPR");
  });

  it("natural-language text also routes to the right product", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });

    await send(app, "5214772000003", "wamid.e2e.3a", "Hola");
    await send(app, "5214772000003", "wamid.e2e.3b", "quiero un seguro de gastos médicos");

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: "5214772000003" });
    expect(lead?.productInterest).toBe("GMM");
    expect(messaging.sentTexts[1].body).toMatch(/cobertura/i);
  });

  it("sends exactly one outbound message per inbound turn throughout a full SAVINGS flow", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });
    const from = "5214772000004";
    const turns = ["Hola", "1", "1", "1", "5", "sí", "1"];

    for (let i = 0; i < turns.length; i++) {
      await send(app, from, `wamid.e2e.4.${i}`, turns[i]);
      expect(messaging.sentTexts).toHaveLength(i + 1);
    }

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("QUALIFIED_A");
  });

  it("a duplicate inbound delivery does not duplicate the answer, the score, or the outbound reply", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });
    const from = "5214772000005";

    await send(app, from, "wamid.e2e.5.0", "Hola");
    await send(app, from, "wamid.e2e.5.1", "1"); // selects SAVINGS
    const before = messaging.sentTexts.length;

    // The exact same provider_message_id delivered twice (Meta redelivery).
    await send(app, from, "wamid.e2e.5.2", "1"); // answers objective
    const afterFirst = messaging.sentTexts.length;
    await send(app, from, "wamid.e2e.5.2", "1"); // redelivery of the same id
    const afterRedelivery = messaging.sentTexts.length;

    expect(afterFirst).toBe(before + 1);
    expect(afterRedelivery).toBe(afterFirst); // no extra reply sent

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    const answers = await repos.qualificationAnswersRepo.listByLeadId(lead!.id);
    expect(answers.filter((a) => a.fieldName === "objective")).toHaveLength(1); // not duplicated
  });

  it("the webhook still returns 200 even when the outbound send fails, and the inbound message is not lost", async () => {
    class FailingMessagingProvider implements MessagingProvider {
      async sendText(): Promise<SendMessageResult> {
        throw new MessagingProviderError("simulated outbound failure", { httpStatus: 500 });
      }
      async sendTemplate(): Promise<SendMessageResult> {
        return {};
      }
      async markRead(): Promise<void> {}
    }
    const repos = buildRepos();
    const app = await buildTestApp({ messaging: new FailingMessagingProvider(), qualificationEngineEnabled: true, ...repos });

    const res = await send(app, "5214772000006", "wamid.e2e.6", "Hola");
    expect(res.statusCode).toBe(200);

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: "5214772000006" });
    expect(lead).not.toBeNull();
    expect(lead?.status).toBe("QUALIFYING"); // beginQualification still ran despite the send failure
  });

  it("spontaneous medical content during GMM triggers HUMAN_HANDOFF before any answer is parsed or persisted", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });
    const from = "5214772000007";

    await send(app, from, "wamid.e2e.7.0", "Hola");
    await send(app, from, "wamid.e2e.7.1", "seguro médico");
    await send(app, from, "wamid.e2e.7.2", "tengo diabetes y estoy en tratamiento");

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("HUMAN_HANDOFF");
    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead!.id);
    // findActiveByLeadId only matches ACTIVE conversations, so a HUMAN_HANDOFF one is absent here.
    expect(conversation).toBeNull();
    const answers = await repos.qualificationAnswersRepo.listByLeadId(lead!.id);
    expect(answers).toHaveLength(0);
    expect(messaging.sentTexts.at(-1)?.body).toMatch(/asesor/i);

    // Handoff is irreversible automatically: a further message gets no new automated reply.
    const before = messaging.sentTexts.length;
    await send(app, from, "wamid.e2e.7.3", "hola de nuevo");
    expect(messaging.sentTexts).toHaveLength(before);
  });

  it("opt-out during qualification stops the flow and DO_NOT_CONTACT prevails", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });
    const from = "5214772000008";

    await send(app, from, "wamid.e2e.8.0", "Hola");
    await send(app, from, "wamid.e2e.8.1", "1");
    await send(app, from, "wamid.e2e.8.2", "ya no me escriban");

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("DO_NOT_CONTACT");

    const before = messaging.sentTexts.length;
    await send(app, from, "wamid.e2e.8.3", "1");
    expect(messaging.sentTexts).toHaveLength(before); // silently ingested, no further reply
  });
});

describe("Phase 3B WhatsApp qualification -- health-safety incident regression (real E2E bug)", () => {
  /** Drives a GMM conversation up to (but not including) the has_current_insurance question,
   * matching the exact state the real incident was reported at: product=GMM,
   * activeQuestion=has_current_insurance, lead.status=QUALIFYING, conversation active. */
  async function reachHasCurrentInsuranceQuestion(app: Awaited<ReturnType<typeof buildTestApp>>, from: string) {
    await send(app, from, "wamid.health.0", "Hola");
    await send(app, from, "wamid.health.1", "3"); // GMM
    await send(app, from, "wamid.health.2", "1"); // coverage_type
    await send(app, from, "wamid.health.3", "1"); // age_range
    await send(app, from, "wamid.health.4", "León, Guanajuato, 37150"); // location
    await send(app, from, "wamid.health.5", "1"); // priority
    // Next question asked is "¿Actualmente cuentas con un seguro de gastos médicos?"
  }

  it("BLOCKING: 'No no cuento tengo hernia de disco y ciática' triggers HUMAN_HANDOFF instead of being parsed as a commercial yes/no answer", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });
    const from = "5214773000001";

    await reachHasCurrentInsuranceQuestion(app, from);
    const lead0 = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    const conversationBefore = await repos.conversationsRepo.findActiveByLeadId(lead0!.id);
    const conversationId = conversationBefore!.id; // captured while still ACTIVE, reused below
    const answersBefore = await repos.qualificationAnswersRepo.listByLeadId(lead0!.id);
    const scoresBefore = await repos.leadScoresRepo.listByLeadId(lead0!.id);
    const repliesBefore = messaging.sentTexts.length;

    const criticalMessage = "No no cuento tengo hernia de disco y ciática";
    const res = await send(app, from, "wamid.health.6", criticalMessage);
    expect(res.statusCode).toBe(200); // webhook still acks

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("HUMAN_HANDOFF");

    const conversationAfter = await repos.conversationsRepo.findById(conversationId);
    expect(conversationAfter?.status).toBe("HUMAN_HANDOFF");
    expect(await repos.conversationsRepo.findActiveByLeadId(lead!.id)).toBeNull(); // no longer ACTIVE

    // 0 qualification_answer created from this message -- specifically, has_current_insurance
    // was never persisted despite the message starting with a parseable "No".
    const answersAfter = await repos.qualificationAnswersRepo.listByLeadId(lead!.id);
    expect(answersAfter).toEqual(answersBefore);
    expect(answersAfter.find((a) => a.fieldName === "has_current_insurance")).toBeUndefined();

    // 0 score computed from this message.
    expect(await repos.leadScoresRepo.listByLeadId(lead!.id)).toEqual(scoresBefore);

    // Exactly one new outbound: the health handoff message. Never the urgency question.
    const newReplies = messaging.sentTexts.slice(repliesBefore);
    expect(newReplies).toHaveLength(1);
    expect(newReplies[0].body).toMatch(/asesor/i);
    expect(newReplies[0].body).not.toMatch(/pronto te gustaría resolver/i); // the urgency question

    // The raw clinical text is absent from the persisted message body and its metadata.
    const messages = await repos.messagesRepo.listByConversationId(conversationId);
    const criticalMessageRow = messages.find((m) => m.providerMessageId === "wamid.health.6");
    expect(criticalMessageRow?.body).not.toBe(criticalMessage);
    expect(criticalMessageRow?.body).not.toMatch(/hernia|ciática|ciatica/i);
    expect(JSON.stringify(criticalMessageRow?.metadata ?? {})).not.toMatch(/hernia|ciática|ciatica/i);

    // Next message does not reactivate qualification.
    const beforeReactivation = messaging.sentTexts.length;
    await send(app, from, "wamid.health.7", "hola, sigues ahí?");
    expect(messaging.sentTexts).toHaveLength(beforeReactivation);
  });

  it('"disco y ciática" alone triggers HUMAN_HANDOFF', async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });
    const from = "5214773000002";

    await reachHasCurrentInsuranceQuestion(app, from);
    await send(app, from, "wamid.health.a", "disco y ciática");

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("HUMAN_HANDOFF");
  });

  it('"me duele la espalda" triggers HUMAN_HANDOFF', async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });
    const from = "5214773000003";

    await reachHasCurrentInsuranceQuestion(app, from);
    await send(app, from, "wamid.health.b", "me duele la espalda");

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("HUMAN_HANDOFF");
  });

  it('"No tengo seguro actualmente" is NOT a false positive -- it is parsed as a normal commercial answer and qualification continues', async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });
    const from = "5214773000004";

    await reachHasCurrentInsuranceQuestion(app, from);
    const repliesBefore = messaging.sentTexts.length;
    await send(app, from, "wamid.health.c", "No tengo seguro actualmente");

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("QUALIFYING"); // no handoff

    const answers = await repos.qualificationAnswersRepo.listByLeadId(lead!.id);
    expect(answers.find((a) => a.fieldName === "has_current_insurance")?.fieldValue).toBe("NO");

    const newReplies = messaging.sentTexts.slice(repliesBefore);
    expect(newReplies).toHaveLength(1);
    expect(newReplies[0].body).toMatch(/pronto te gustaría resolver/i); // moved on to the urgency question
  });

  it('"Sí tengo seguro" is NOT a false positive -- no handoff, qualification continues', async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });
    const from = "5214773000005";

    await reachHasCurrentInsuranceQuestion(app, from);
    await send(app, from, "wamid.health.d", "Sí tengo seguro");

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("QUALIFYING");
    const answers = await repos.qualificationAnswersRepo.listByLeadId(lead!.id);
    expect(answers.find((a) => a.fieldName === "has_current_insurance")?.fieldValue).toBe("YES");
  });
});

describe("Phase 3B WhatsApp qualification -- CONTACTED-orphan recovery (FIX 3)", () => {
  it("A: CONTACTED + productInterest=null + flag on -> starts qualification from this exact inbound, resolves GMM, sets productVertical, no duplicate welcome", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });
    const from = "5214774000001";
    const { lead: orphan } = await createLeadAtStatus(repos, from, "CONTACTED", undefined);

    const res = await send(app, from, "wamid.recover.a", "3");
    expect(res.statusCode).toBe(200);

    const lead = await repos.leadsRepo.findById(orphan.id);
    expect(lead?.status).toBe("QUALIFYING");
    expect(lead?.productInterest).toBe("GMM");
    expect(lead?.productVertical).toBe("GMM"); // FIX 2, exercised through the recovery path too

    // Exactly one new outbound: the first GMM question. Never buildWelcomeMessage's text again.
    expect(messaging.sentTexts).toHaveLength(1);
    expect(messaging.sentTexts[0].body).toMatch(/cobertura/i);
    expect(messaging.sentTexts[0].body).not.toMatch(/Gracias por contactar a Baluarte Capital/i);
  });

  it("A (PATRIMONIAL mapping): resolving to SAVINGS sets productVertical=PATRIMONIAL", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });
    const from = "5214774000002";
    await createLeadAtStatus(repos, from, "CONTACTED", undefined);

    await send(app, from, "wamid.recover.a2", "1"); // Ahorro e inversión -> SAVINGS

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.productInterest).toBe("SAVINGS");
    expect(lead?.productVertical).toBe("PATRIMONIAL");
  });

  it("B: CONTACTED with an existing productInterest is never auto-reactivated", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });
    const from = "5214774000003";
    await createLeadAtStatus(repos, from, "CONTACTED", "SAVINGS");

    const res = await send(app, from, "wamid.recover.b", "3");
    expect(res.statusCode).toBe(200);

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("CONTACTED"); // unchanged
    expect(messaging.sentTexts).toHaveLength(0); // no automated reply, same as today
  });

  it.each<LeadStatus>(["HUMAN_HANDOFF", "DO_NOT_CONTACT"])(
    "C-D: a lead already at %s is never auto-reactivated by the recovery path (suppressed earlier, no reply at all)",
    async (status) => {
      const messaging = new FakeMessagingProvider();
      const repos = buildRepos();
      const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos });
      const from = `5214774000${(status.length % 10).toString()}0`; // deterministic per status, fresh repos each iteration
      await createLeadAtStatus(repos, from, status, undefined);

      const res = await send(app, from, `wamid.recover.${status}`, "3");
      expect(res.statusCode).toBe(200);

      const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
      // Unchanged -- HUMAN_HANDOFF/DO_NOT_CONTACT are suppressed even earlier
      // (wasAlreadySuppressed), before the recovery branch (or any other routing branch) is ever
      // reached.
      expect(lead?.status).toBe(status);
      expect(messaging.sentTexts).toHaveLength(0);
    },
  );

  it.each<LeadStatus>(["QUALIFIED_A", "QUALIFIED_B", "NURTURE_C"])(
    "E-G: a lead already at %s is never auto-reactivated by the CONTACTED-orphan recovery path, but still gets the qualified-lead generic fallback reply (production bug fix -- see QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE)",
    async (status) => {
      const messaging = new FakeMessagingProvider();
      const repos = buildRepos();
      const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, ...repos }); // whatsappBookingEnabled defaults to false -- no bookingHandler
      const from = `5214774000${(status.length % 10).toString()}0`; // deterministic per status, fresh repos each iteration
      await createLeadAtStatus(repos, from, status, undefined);

      const res = await send(app, from, `wamid.recover.${status}`, "3");
      expect(res.statusCode).toBe(200);

      const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
      // Unchanged -- QUALIFIED_A/B/NURTURE_C simply don't match the recovery path's
      // `status === "CONTACTED"` guard, so it's never reactivated into QUALIFYING by it. The
      // reply below comes from the QUALIFIED_A/B/NURTURE_C generic-fallback branch instead
      // (a completely separate code path from the CONTACTED-orphan recovery this test targets).
      expect(lead?.status).toBe(status);
      expect(messaging.sentTexts).toHaveLength(1);
      expect(messaging.sentTexts[0].body).toBe(QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE);
    },
  );

  it("H: feature flag false -> Phase 2 behavior, no recovery, even for an orphaned CONTACTED lead", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: false, ...repos });
    const from = "5214774000009";
    await createLeadAtStatus(repos, from, "CONTACTED", undefined);

    const res = await send(app, from, "wamid.recover.h", "3");
    expect(res.statusCode).toBe(200);

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("CONTACTED");
    expect(messaging.sentTexts).toHaveLength(0);
  });
});
