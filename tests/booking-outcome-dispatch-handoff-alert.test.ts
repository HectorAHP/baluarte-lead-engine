import { describe, it, expect } from "vitest";
import { escalateToHuman } from "../src/application/booking-outcome-dispatch.js";
import { HumanHandoffAlertService } from "../src/application/human-handoff-alert-service.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryProcessedEventRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import type { Lead } from "../src/domain/lead.js";

/**
 * Fase 7J.2 items 11/12 -- escalateToHuman (booking-outcome-dispatch.ts) is the SHARED helper
 * behind several distinct handoff reasons (BOOKING_INCONSISTENCY_HANDOFF,
 * RESCHEDULE_APPOINTMENT_INCONSISTENCY, etc.) -- this phase alerts ONLY for
 * "UNKNOWN_INTENT_HANDOFF" (spec item 11). Tested here directly against the function, independent
 * of any one handler, so this gate is verified once at its actual source rather than re-derived
 * per call site.
 */

const ADVISOR_PHONE = "+525500000002";

function buildDeps() {
  const messaging = new FakeMessagingProvider();
  const handoffAlertService = new HumanHandoffAlertService(
    { messaging, processedEvents: new InMemoryProcessedEventRepository(), leads: new InMemoryLeadRepository(), logger: new FakeLogger() },
    { advisorPhoneE164: ADVISOR_PHONE, templateName: "handoff_asesor", languageCode: "es_MX", timezone: "America/Mexico_City" },
  );
  return {
    leads: new InMemoryLeadRepository(),
    conversations: new InMemoryConversationRepository(),
    messaging,
    messages: new InMemoryMessageRepository(),
    leadStatusHistory: new InMemoryLeadStatusHistoryRepository(),
    logger: new FakeLogger(),
    handoffAlertService,
  };
}

async function makeLeadAndConversation(deps: ReturnType<typeof buildDeps>, status: Lead["status"]) {
  const lead = await deps.leads.create({ country: "MX", productVertical: "GMM", status, score: 0, whatsappUserId: "5214778880010", assignedAdvisor: "Hector Herrera", consentContact: true });
  const conversation = await deps.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead, conversation };
}

describe("Fase 7J.2 -- escalateToHuman alerts exclusively for UNKNOWN_INTENT_HANDOFF", () => {
  it("11: eventType BOOKING_INCONSISTENCY_HANDOFF (the function's own default) -> no alert", async () => {
    const deps = buildDeps();
    const { lead, conversation } = await makeLeadAndConversation(deps, "BOOKING_PENDING");

    await escalateToHuman(deps, lead, conversation.id, lead.whatsappUserId!);

    expect((await deps.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF"); // the handoff itself still happens
    expect(deps.messaging.sentTemplates).toHaveLength(0); // but never an alert for this reason, this phase
  });

  it("12: eventType MAX_ROUNDS_REACHED -> no alert", async () => {
    const deps = buildDeps();
    const { lead, conversation } = await makeLeadAndConversation(deps, "BOOKING_PENDING");

    await escalateToHuman(deps, lead, conversation.id, lead.whatsappUserId!, "MAX_ROUNDS_REACHED");

    expect((await deps.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(deps.messaging.sentTemplates).toHaveLength(0);
  });

  it("eventType RESCHEDULE_APPOINTMENT_INCONSISTENCY -> no alert (another already-existing reason, untouched this phase)", async () => {
    const deps = buildDeps();
    const { lead, conversation } = await makeLeadAndConversation(deps, "RESCHEDULE_REQUESTED");

    await escalateToHuman(deps, lead, conversation.id, lead.whatsappUserId!, "RESCHEDULE_APPOINTMENT_INCONSISTENCY");

    expect((await deps.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(deps.messaging.sentTemplates).toHaveLength(0);
  });

  it("eventType UNKNOWN_INTENT_HANDOFF -> exactly one alert, only for this reason", async () => {
    const deps = buildDeps();
    const { lead, conversation } = await makeLeadAndConversation(deps, "BOOKING_PENDING");

    await escalateToHuman(deps, lead, conversation.id, lead.whatsappUserId!, "UNKNOWN_INTENT_HANDOFF", "test message");

    expect((await deps.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
    expect(deps.messaging.sentTemplates).toHaveLength(1);
    expect(deps.messaging.sentTemplates[0].to).toBe(ADVISOR_PHONE);
  });

  it("a redundant call (lead ALREADY HUMAN_HANDOFF) with eventType UNKNOWN_INTENT_HANDOFF -> no second alert (isGenuineNewEscalation gate)", async () => {
    const deps = buildDeps();
    const { lead, conversation } = await makeLeadAndConversation(deps, "HUMAN_HANDOFF");

    await escalateToHuman(deps, lead, conversation.id, lead.whatsappUserId!, "UNKNOWN_INTENT_HANDOFF", "test message");

    expect(deps.messaging.sentTemplates).toHaveLength(0);
  });

  it("no handoffAlertService configured (flag off) -> escalateToHuman still works, never throws", async () => {
    const deps = buildDeps();
    const { handoffAlertService: _unused, ...depsWithoutAlert } = deps;
    const { lead, conversation } = await makeLeadAndConversation(deps, "BOOKING_PENDING");

    await escalateToHuman(depsWithoutAlert, lead, conversation.id, lead.whatsappUserId!, "UNKNOWN_INTENT_HANDOFF", "test message");

    expect((await deps.leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF");
  });
});
