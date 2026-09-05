import { describe, it, expect } from "vitest";
import { handleInboundWhatsAppText, type InboundWhatsAppText } from "../src/application/whatsapp-inbound-service.js";
import { LeadService } from "../src/application/services.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository, InMemoryLeadStatusHistoryRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";

function makeDeps(leadIntegrityEnabled: boolean) {
  const leads = new InMemoryLeadRepository();
  const conversations = new InMemoryConversationRepository();
  const messages = new InMemoryMessageRepository();
  const leadScores = { create: async () => { throw new Error("unused"); }, listByLeadId: async () => [] } as never;
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const leadService = new LeadService(leads, leadScores, leadStatusHistory, new FakeLogger());
  const messaging = new FakeMessagingProvider();
  return {
    deps: { leads, conversations, messages, leadService, messaging, logger: new FakeLogger(), leadIntegrityEnabled },
    leads, conversations, messages,
  };
}

function inbound(overrides: Partial<InboundWhatsAppText> = {}): InboundWhatsAppText {
  return { whatsappUserId: "5214771234567", phoneRaw: "5214771234567", providerMessageId: `wamid.${Math.random()}`, text: "hola", ...overrides };
}

describe("Fase 7B item 34/8/9 -- passive WhatsApp phone verification", () => {
  it("flag off (default): no phoneQuality/phoneVerifiedAt is ever set", async () => {
    const { deps, leads } = makeDeps(false);
    const result = await handleInboundWhatsAppText(deps, inbound());
    const lead = await leads.findById(result.leadId!);
    expect(lead?.phoneVerifiedAt).toBeUndefined();
    expect(lead?.phoneQuality).toBeUndefined();
  });

  it("item 8: a brand-new WhatsApp lead is verified on its very first inbound (its own phone IS the channel)", async () => {
    const { deps, leads } = makeDeps(true);
    const result = await handleInboundWhatsAppText(deps, inbound());
    const lead = await leads.findById(result.leadId!);
    expect(lead?.phoneQuality).toBe("VERIFIED");
    expect(lead?.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it("a second inbound from the SAME lead/phone is idempotent -- phoneVerifiedAt is never re-written", async () => {
    const { deps, leads } = makeDeps(true);
    const first = await handleInboundWhatsAppText(deps, inbound({ providerMessageId: "wamid.1" }));
    const leadAfterFirst = await leads.findById(first.leadId!);
    const firstVerifiedAt = leadAfterFirst?.phoneVerifiedAt;

    await handleInboundWhatsAppText(deps, inbound({ providerMessageId: "wamid.2" }));
    const leadAfterSecond = await leads.findById(first.leadId!);
    expect(leadAfterSecond?.phoneVerifiedAt?.getTime()).toBe(firstVerifiedAt?.getTime());
  });

  it("item 9: an inbound from a DIFFERENT phone than the lead's own phoneE164 flags identityConflict, never overwrites", async () => {
    const { deps, leads } = makeDeps(true);
    const lead = await leads.create({
      firstName: "Marco", country: "MX", productVertical: "GMM", status: "NEW", score: 0,
      assignedAdvisor: "Hector Herrera", consentContact: false, whatsappUserId: "5214771234567", phoneE164: "+525551112222",
    });
    await deps.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });

    // Same whatsappUserId (so findByDedupKey resolves to THIS lead) but the inbound's own phoneRaw
    // normalizes to a DIFFERENT E.164 than the lead's phoneE164 on file.
    await handleInboundWhatsAppText(deps, inbound({ whatsappUserId: "5214771234567", phoneRaw: "5214779998888" }));

    const updated = await leads.findById(lead.id);
    expect(updated?.phoneE164).toBe("+525551112222"); // never overwritten
    expect(updated?.identityConflict).toBe(true);
    expect(updated?.phoneVerifiedAt).toBeUndefined(); // never verified against a phone that didn't match
  });

  it("identityConflict is never exposed to the lead -- no message differs, no reply is sent because of it", async () => {
    const { deps, leads, messages } = makeDeps(true);
    const lead = await leads.create({
      firstName: "Marco", country: "MX", productVertical: "GMM", status: "NEW", score: 0,
      assignedAdvisor: "Hector Herrera", consentContact: false, whatsappUserId: "5214771234567", phoneE164: "+525551112222",
    });
    const conversation = await deps.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });

    await handleInboundWhatsAppText(deps, inbound({ whatsappUserId: "5214771234567", phoneRaw: "5214779998888" }));

    const outbound = (await messages.listByConversationId(conversation.id)).filter((m) => m.direction === "OUTBOUND");
    // Phase 2 welcome-message behavior is completely unaffected by the identity-conflict flag --
    // whatever this lead's status/flow would normally send is unaffected.
    expect(outbound.every((m) => !m.body?.includes("conflict"))).toBe(true);
  });
});
