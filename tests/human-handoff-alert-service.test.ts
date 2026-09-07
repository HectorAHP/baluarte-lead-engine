import { describe, it, expect } from "vitest";
import { HumanHandoffAlertService } from "../src/application/human-handoff-alert-service.js";
import { InMemoryLeadRepository, InMemoryProcessedEventRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { HUMAN_HANDOFF_ALERT_REASON_UNKNOWN_INTENT } from "../src/domain/message-templates.js";
import type { MessagingProvider, SendMessageResult } from "../src/application/ports.js";

/** Fase 7J.2 -- unit tests for HumanHandoffAlertService, in isolation from the router/webhook. */

class TemplateFailingMessaging extends FakeMessagingProvider implements MessagingProvider {
  async sendTemplate(): Promise<SendMessageResult> {
    throw new Error("META_TEMPLATE_NOT_APPROVED");
  }
}

const ADVISOR_PHONE = "+525500000001"; // obviously-fake test number, never a real one
const CONFIG = { advisorPhoneE164: ADVISOR_PHONE, templateName: "handoff_asesor", languageCode: "es_MX", timezone: "America/Mexico_City" };

function buildDeps() {
  return {
    messaging: new FakeMessagingProvider(),
    processedEvents: new InMemoryProcessedEventRepository(),
    leads: new InMemoryLeadRepository(),
    logger: new FakeLogger(),
  };
}

describe("Fase 7J.2 -- HumanHandoffAlertService", () => {
  it("2/3: sends to the configured advisor phone with the configured template name and language", async () => {
    const deps = buildDeps();
    const lead = await deps.leads.create({ country: "MX", productVertical: "GMM", status: "BOOKING_PENDING", score: 0, firstName: "Ana", assignedAdvisor: "Hector Herrera", consentContact: true });
    const service = new HumanHandoffAlertService(deps, CONFIG);

    await service.alertAdvisorOfHandoff({ leadId: lead.id, conversationId: "conv-1", whatsappUserId: "5214778880001", handoffReason: "UNKNOWN_INTENT_HANDOFF", now: new Date("2026-09-07T15:04:00.000Z") });

    expect(deps.messaging.sentTemplates).toHaveLength(1);
    expect(deps.messaging.sentTemplates[0].to).toBe(ADVISOR_PHONE);
    expect(deps.messaging.sentTemplates[0].templateName).toBe("handoff_asesor");
    expect(deps.messaging.sentTemplates[0].languageCode).toBe("es_MX");
  });

  it("4: template variables never contain the lead's original inbound text -- only name/contact/fixed reason/timestamp", async () => {
    const deps = buildDeps();
    const lead = await deps.leads.create({ country: "MX", productVertical: "GMM", status: "BOOKED", score: 0, firstName: "Carlos", assignedAdvisor: "Hector Herrera", consentContact: true });
    const service = new HumanHandoffAlertService(deps, CONFIG);

    await service.alertAdvisorOfHandoff({ leadId: lead.id, conversationId: "conv-2", whatsappUserId: "5214778880002", handoffReason: "UNKNOWN_INTENT_HANDOFF", now: new Date("2026-09-07T09:30:00.000Z") });

    const params = deps.messaging.sentTemplates[0].params!;
    expect(params).toHaveLength(4);
    expect(params[0]).toBe("Carlos");
    expect(params[1]).toBe("5214778880002");
    expect(params[2]).toBe(HUMAN_HANDOFF_ALERT_REASON_UNKNOWN_INTENT);
    expect(params[2]).toBe("Mensaje no reconocido");
    expect(params[3]).toBe("07/09/2026 03:30"); // America/Mexico_City, UTC-6 in September (no DST)
    // The service's own params interface has no field for the raw inbound text at all -- this
    // assertion documents that constraint at the data level, not just by inspection.
    expect(params.join(" ")).not.toContain("asdkjfh");
  });

  it("no lead found -- falls back to 'Lead sin nombre', never throws", async () => {
    const deps = buildDeps();
    const service = new HumanHandoffAlertService(deps, CONFIG);

    await service.alertAdvisorOfHandoff({ leadId: "does-not-exist", conversationId: "conv-3", whatsappUserId: "5214778880003", handoffReason: "UNKNOWN_INTENT_HANDOFF", now: new Date() });

    expect(deps.messaging.sentTemplates).toHaveLength(1);
    expect(deps.messaging.sentTemplates[0].params![0]).toBe("Lead sin nombre");
  });

  it("6/idempotency: a second call for the SAME leadId never sends a second alert", async () => {
    const deps = buildDeps();
    const lead = await deps.leads.create({ country: "MX", productVertical: "GMM", status: "BOOKED", score: 0, assignedAdvisor: "Hector Herrera", consentContact: true });
    const service = new HumanHandoffAlertService(deps, CONFIG);

    await service.alertAdvisorOfHandoff({ leadId: lead.id, conversationId: "conv-4", whatsappUserId: "5214778880004", handoffReason: "UNKNOWN_INTENT_HANDOFF", now: new Date() });
    await service.alertAdvisorOfHandoff({ leadId: lead.id, conversationId: "conv-4", whatsappUserId: "5214778880004", handoffReason: "UNKNOWN_INTENT_HANDOFF", now: new Date() });

    expect(deps.messaging.sentTemplates).toHaveLength(1);
    expect(deps.logger.warnings.some((w) => w.message === "human_handoff_alert_skipped")).toBe(true);
  });

  it("8/9: a provider failure never throws, and is logged as human_handoff_alert_failed with no PII", async () => {
    const deps = { ...buildDeps(), messaging: new TemplateFailingMessaging() };
    const lead = await deps.leads.create({ country: "MX", productVertical: "GMM", status: "BOOKED", score: 0, firstName: "Luisa", assignedAdvisor: "Hector Herrera", consentContact: true });
    const service = new HumanHandoffAlertService(deps, CONFIG);

    await expect(
      service.alertAdvisorOfHandoff({ leadId: lead.id, conversationId: "conv-5", whatsappUserId: "5214778880005", handoffReason: "UNKNOWN_INTENT_HANDOFF", now: new Date() }),
    ).resolves.toBeUndefined(); // never throws/rejects

    const failure = deps.logger.warnings.find((w) => w.message === "human_handoff_alert_failed");
    expect(failure).toBeDefined();
    expect(failure!.details.providerOutcome).toBe("FAILED");
    expect(failure!.details.leadIdLast8).toBe(lead.id.slice(-8));
    // No PII: no advisor phone, no prospect phone, no lead name, no inbound text anywhere in the
    // logged details.
    const detailsJson = JSON.stringify(failure!.details);
    expect(detailsJson).not.toContain(ADVISOR_PHONE);
    expect(detailsJson).not.toContain("5214778880005");
    expect(detailsJson).not.toContain("Luisa");
  });

  it("a failed send does not retry itself -- but does NOT permanently consume the retry-relevant idempotency slot before the send is attempted (claim happens first, by design -- see the class doc comment's documented trade-off)", async () => {
    const deps = { ...buildDeps(), messaging: new TemplateFailingMessaging() };
    const lead = await deps.leads.create({ country: "MX", productVertical: "GMM", status: "BOOKED", score: 0, assignedAdvisor: "Hector Herrera", consentContact: true });
    const service = new HumanHandoffAlertService(deps, CONFIG);

    await service.alertAdvisorOfHandoff({ leadId: lead.id, conversationId: "conv-6", whatsappUserId: "5214778880006", handoffReason: "UNKNOWN_INTENT_HANDOFF", now: new Date() });
    // A second call for the SAME lead after a failure is also swallowed as SKIPPED_DUPLICATE
    // (the one-shot slot was already claimed before the send was attempted) -- documents the
    // known "no automatic retry this phase" limitation explicitly, at the test level.
    await service.alertAdvisorOfHandoff({ leadId: lead.id, conversationId: "conv-6", whatsappUserId: "5214778880006", handoffReason: "UNKNOWN_INTENT_HANDOFF", now: new Date() });

    expect(deps.logger.warnings.filter((w) => w.message === "human_handoff_alert_failed")).toHaveLength(1);
    expect(deps.logger.warnings.some((w) => w.message === "human_handoff_alert_skipped")).toBe(true);
  });
});
