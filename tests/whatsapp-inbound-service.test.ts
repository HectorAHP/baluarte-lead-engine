import { describe, expect, it } from "vitest";
import { handleInboundWhatsAppText, type InboundWhatsAppText } from "../src/application/whatsapp-inbound-service.js";
import { LeadService } from "../src/application/services.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository, InMemoryLeadScoreRepository,
  InMemoryLeadStatusHistoryRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { HEALTH_HANDOFF_MESSAGE, OPT_OUT_CONFIRMATION_MESSAGE } from "../src/domain/message-templates.js";
import type { MessagingProvider, SendMessageResult } from "../src/application/ports.js";

function makeDeps() {
  const leads = new InMemoryLeadRepository();
  const conversations = new InMemoryConversationRepository();
  const messages = new InMemoryMessageRepository();
  const leadScores = new InMemoryLeadScoreRepository();
  const messaging = new FakeMessagingProvider();
  const logger = new FakeLogger();
  const leadService = new LeadService(leads, leadScores, new InMemoryLeadStatusHistoryRepository(), logger);
  return { leads, conversations, messages, messaging, logger, leadService };
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

describe("handleInboundWhatsAppText: lead resolution", () => {
  it("creates a new lead on first contact, with source WHATSAPP and normalized phone", async () => {
    const deps = makeDeps();
    const result = await handleInboundWhatsAppText(deps, baseInput());
    expect(result.outcome).toBe("PROCESSED");
    const lead = await deps.leads.findById(result.leadId!);
    expect(lead?.source).toBe("WHATSAPP");
    expect(lead?.whatsappUserId).toBe("5214771234567");
    // Normalized to true E.164, with WhatsApp's Mexico wa_id quirk (extra legacy "1") stripped.
    expect(lead?.phoneE164).toBe("+524771234567");
    expect(lead?.status).toBe("CONTACTED");
    expect(lead?.firstContactAt).toBeInstanceOf(Date);
    expect(lead?.firstResponseAt).toBeInstanceOf(Date);
    // First contact and first response are the same real-world event for a WhatsApp-originated lead.
    expect(lead?.firstContactAt?.getTime()).toBe(lead?.firstResponseAt?.getTime());
  });

  it("reuses an existing lead found by whatsapp_user_id instead of creating a new one", async () => {
    const deps = makeDeps();
    const existing = await deps.leadService.createLead({ firstName: "Carlos", whatsappUserId: "5214771234567", productVertical: "GMM" });
    const result = await handleInboundWhatsAppText(deps, baseInput({ providerMessageId: "wamid.2" }));
    expect(result.leadId).toBe(existing.id);
    expect(await deps.leads.findById(existing.id)).toMatchObject({ id: existing.id, firstName: "Carlos" });
  });

  it("reuses an existing lead found by phone_e164 when whatsapp_user_id doesn't match", async () => {
    const deps = makeDeps();
    const existing = await deps.leadService.createLead({ firstName: "Beto", phone: "4771234567", productVertical: "PATRIMONIAL" });
    const result = await handleInboundWhatsAppText(deps, baseInput({ whatsappUserId: "5214771234567", phoneRaw: "4771234567", providerMessageId: "wamid.3" }));
    expect(result.leadId).toBe(existing.id);
  });
});

describe("handleInboundWhatsAppText: conversation resolution", () => {
  it("creates an active WHATSAPP conversation for a new lead", async () => {
    const deps = makeDeps();
    const result = await handleInboundWhatsAppText(deps, baseInput());
    const conv = await deps.conversations.findById(result.conversationId!);
    expect(conv?.channel).toBe("WHATSAPP");
    expect(conv?.status).toBe("ACTIVE");
  });

  it("reuses the active conversation for a second message from the same lead", async () => {
    const deps = makeDeps();
    const first = await handleInboundWhatsAppText(deps, baseInput({ providerMessageId: "wamid.1" }));
    const second = await handleInboundWhatsAppText(deps, baseInput({ providerMessageId: "wamid.2", text: "otro mensaje" }));
    expect(second.conversationId).toBe(first.conversationId);
  });
});

describe("handleInboundWhatsAppText: message persistence and dedup", () => {
  it("persists the inbound message", async () => {
    const deps = makeDeps();
    const result = await handleInboundWhatsAppText(deps, baseInput({ text: "Quiero saber de PPR" }));
    const list = await deps.messages.listByConversationId(result.conversationId!);
    const inbound = list.find((m) => m.direction === "INBOUND");
    expect(inbound?.body).toBe("Quiero saber de PPR");
    expect(inbound?.providerMessageId).toBe("wamid.1");
  });

  it("does not create a second message, lead, or reply for a duplicate providerMessageId", async () => {
    const deps = makeDeps();
    const first = await handleInboundWhatsAppText(deps, baseInput());
    const second = await handleInboundWhatsAppText(deps, baseInput());
    expect(second.outcome).toBe("DUPLICATE");
    expect(second.leadId).toBe(first.leadId);
    const list = await deps.messages.listByConversationId(first.conversationId!);
    expect(list).toHaveLength(2); // one inbound + one welcome outbound, from the first call only
    expect(deps.messaging.sentTexts).toHaveLength(1);
  });
});

describe("handleInboundWhatsAppText: welcome response", () => {
  it("sends the deterministic welcome message once for a brand-new lead, marked aiGenerated=false", async () => {
    const deps = makeDeps();
    const result = await handleInboundWhatsAppText(deps, baseInput());
    expect(deps.messaging.sentTexts).toHaveLength(1);
    expect(deps.messaging.sentTexts[0].body).toContain("Baluarte Capital");
    expect(deps.messaging.sentTexts[0].body).toContain("Ana");
    const list = await deps.messages.listByConversationId(result.conversationId!);
    const outbound = list.find((m) => m.direction === "OUTBOUND");
    expect(outbound?.aiGenerated).toBe(false);
    expect(outbound?.providerMessageId).toBeTruthy();
  });

  it("does not resend the welcome message for a second message from an already-contacted lead", async () => {
    const deps = makeDeps();
    await handleInboundWhatsAppText(deps, baseInput({ providerMessageId: "wamid.1" }));
    await handleInboundWhatsAppText(deps, baseInput({ providerMessageId: "wamid.2", text: "segundo mensaje" }));
    expect(deps.messaging.sentTexts).toHaveLength(1);
  });
});

describe("handleInboundWhatsAppText: sensitive health redaction and handoff", () => {
  it("redacts sensitive health text, triggers human handoff, and sends the neutral response", async () => {
    const deps = makeDeps();
    const result = await handleInboundWhatsAppText(deps, baseInput({ text: "me diagnosticaron diabetes y tomo insulina" }));
    const lead = await deps.leads.findById(result.leadId!);
    expect(lead?.status).toBe("HUMAN_HANDOFF");
    const conv = await deps.conversations.findById(result.conversationId!);
    expect(conv?.status).toBe("HUMAN_HANDOFF");

    const list = await deps.messages.listByConversationId(result.conversationId!);
    const inbound = list.find((m) => m.direction === "INBOUND");
    expect(inbound?.body).not.toContain("diabetes");
    expect(inbound?.metadata).toEqual({ sensitive_content_detected: true, category: "HEALTH" });

    expect(deps.messaging.sentTexts).toHaveLength(1);
    expect(deps.messaging.sentTexts[0].body).toBe(HEALTH_HANDOFF_MESSAGE);
  });

  it("sends no further automated replies once a lead is in HUMAN_HANDOFF", async () => {
    const deps = makeDeps();
    await handleInboundWhatsAppText(deps, baseInput({ providerMessageId: "wamid.1", text: "tengo cáncer y necesito ayuda" }));
    await handleInboundWhatsAppText(deps, baseInput({ providerMessageId: "wamid.2", text: "¿siguen ahí?" }));
    expect(deps.messaging.sentTexts).toHaveLength(1); // only the initial handoff message
  });
});

describe("handleInboundWhatsAppText: opt-out", () => {
  it("detects opt-out, sets DO_NOT_CONTACT, closes the conversation, and sends one confirmation", async () => {
    const deps = makeDeps();
    const result = await handleInboundWhatsAppText(deps, baseInput({ text: "ya no me contacten" }));
    const lead = await deps.leads.findById(result.leadId!);
    expect(lead?.status).toBe("DO_NOT_CONTACT");
    const conv = await deps.conversations.findById(result.conversationId!);
    expect(conv?.status).toBe("CLOSED");
    expect(deps.messaging.sentTexts).toHaveLength(1);
    expect(deps.messaging.sentTexts[0].body).toBe(OPT_OUT_CONFIRMATION_MESSAGE);
  });

  it("sends no further messages after opt-out", async () => {
    const deps = makeDeps();
    await handleInboundWhatsAppText(deps, baseInput({ providerMessageId: "wamid.1", text: "no me escriban" }));
    await handleInboundWhatsAppText(deps, baseInput({ providerMessageId: "wamid.2", text: "hola de nuevo" }));
    expect(deps.messaging.sentTexts).toHaveLength(1);
  });
});

describe("handleInboundWhatsAppText: outbound send failure", () => {
  it("does not lose the inbound message and does not throw when the messaging provider fails", async () => {
    const deps = makeDeps();
    const failingMessaging: MessagingProvider = {
      async sendText(): Promise<SendMessageResult> {
        throw new Error("Graph API 500");
      },
      async sendTemplate(): Promise<SendMessageResult> {
        throw new Error("Graph API 500");
      },
      async markRead() {},
    };
    const failingDeps = { ...deps, messaging: failingMessaging };

    await expect(handleInboundWhatsAppText(failingDeps, baseInput())).resolves.toMatchObject({ outcome: "PROCESSED" });

    const list = await deps.messages.listByConversationId((await deps.conversations.findActiveByLeadId((await deps.leads.findByDedupKey({ whatsappUserId: "5214771234567" }))!.id))!.id);
    expect(list).toHaveLength(1); // inbound only -- no outbound row for a send that never succeeded
    expect(list[0].direction).toBe("INBOUND");
    expect(deps.logger.warnings.length).toBeGreaterThan(0);
  });
});
