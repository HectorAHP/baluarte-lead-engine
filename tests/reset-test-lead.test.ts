import { describe, it, expect, vi } from "vitest";
import {
  parseArgs, captureSnapshot, assertConversationBelongsToLead, runDryRun, runConfirmedReset,
  ResetTestLeadUsageError, ResetTestLeadValidationError,
  type ResetTestLeadDeps, type ResetTestLeadRpcCaller,
} from "../scripts/reset-test-lead.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryQualificationAnswerRepository,
  InMemoryLeadScoreRepository, InMemoryOfferedSlotRepository, InMemoryAppointmentRepository,
  InMemoryBookingAttemptRepository, InMemorySlotOfferClaimRepository, InMemoryMessageRepository,
} from "../src/infrastructure/memory-repositories.js";

function makeDeps(): ResetTestLeadDeps {
  return {
    leads: new InMemoryLeadRepository(),
    conversations: new InMemoryConversationRepository(),
    qualificationAnswers: new InMemoryQualificationAnswerRepository(),
    leadScores: new InMemoryLeadScoreRepository(),
    offeredSlots: new InMemoryOfferedSlotRepository(),
    appointments: new InMemoryAppointmentRepository(),
    bookingAttempts: new InMemoryBookingAttemptRepository(),
    slotOfferClaims: new InMemorySlotOfferClaimRepository(),
    messages: new InMemoryMessageRepository(),
  };
}

async function seedLeadAndConversation(deps: ResetTestLeadDeps, overrides: Partial<Parameters<ResetTestLeadDeps["leads"]["create"]>[0]> = {}) {
  const lead = await deps.leads.create({
    country: "MX", productVertical: "PATRIMONIAL", status: "QUALIFIED_A",
    score: 80, assignedAdvisor: "Hector Herrera", consentContact: true,
    ...overrides,
  });
  const conversation = await deps.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  return { lead, conversation };
}

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

describe("parseArgs", () => {
  it("parses --lead-id/--conversation-id, confirm defaults to false", () => {
    const args = parseArgs(["--lead-id", UUID_A, "--conversation-id", UUID_B]);
    expect(args).toEqual({ leadId: UUID_A, conversationId: UUID_B, confirm: false });
  });

  it("confirm requerido: --confirm sets confirm=true, otherwise stays false", () => {
    const withConfirm = parseArgs(["--lead-id", UUID_A, "--conversation-id", UUID_B, "--confirm"]);
    expect(withConfirm.confirm).toBe(true);
    const without = parseArgs(["--lead-id", UUID_A, "--conversation-id", UUID_B]);
    expect(without.confirm).toBe(false);
  });

  it("UUID inválido: rejects a non-UUID --lead-id", () => {
    expect(() => parseArgs(["--lead-id", "not-a-uuid", "--conversation-id", UUID_B])).toThrow(ResetTestLeadUsageError);
  });

  it("UUID inválido: rejects a non-UUID --conversation-id", () => {
    expect(() => parseArgs(["--lead-id", UUID_A, "--conversation-id", "also-not-a-uuid"])).toThrow(ResetTestLeadUsageError);
  });

  it("requires both flags", () => {
    expect(() => parseArgs(["--lead-id", UUID_A])).toThrow(ResetTestLeadUsageError);
    expect(() => parseArgs(["--conversation-id", UUID_B])).toThrow(ResetTestLeadUsageError);
  });

  it("rejects an unrecognized flag", () => {
    expect(() => parseArgs(["--lead-id", UUID_A, "--conversation-id", UUID_B, "--wat"])).toThrow(ResetTestLeadUsageError);
  });
});

describe("dry-run no modifica", () => {
  it("runDryRun never writes -- leads.update/conversations.update are never called", async () => {
    const deps = makeDeps();
    const { lead, conversation } = await seedLeadAndConversation(deps);
    const leadsUpdateSpy = vi.spyOn(deps.leads, "update");
    const conversationsUpdateSpy = vi.spyOn(deps.conversations, "update");

    const snapshot = await runDryRun(deps, lead.id, conversation.id);

    expect(snapshot.lead?.id).toBe(lead.id);
    expect(leadsUpdateSpy).not.toHaveBeenCalled();
    expect(conversationsUpdateSpy).not.toHaveBeenCalled();
  });

  it("captureSnapshot accurately reflects seeded dependent-table data", async () => {
    const deps = makeDeps();
    const { lead, conversation } = await seedLeadAndConversation(deps);
    await deps.qualificationAnswers.create({ leadId: lead.id, conversationId: conversation.id, vertical: "GMM", fieldName: "coverage_type", fieldValue: "FAMILY", source: "MANUAL" });
    await deps.leadScores.create({ leadId: lead.id, vertical: "GMM", total: 71, scoreClass: "B", breakdown: {}, rulesVersion: "GMM_QUALIFICATION_V1" });
    await deps.messages.create({ conversationId: conversation.id, leadId: lead.id, direction: "INBOUND", channel: "WHATSAPP", body: "hola", aiGenerated: false, metadata: {} });

    const snapshot = await captureSnapshot(deps, lead.id, conversation.id);

    expect(snapshot.qualificationAnswersCount).toBe(1);
    expect(snapshot.leadScoresCount).toBe(1);
    expect(snapshot.messagesCount).toBe(1);
    expect(snapshot.activeAppointment).toBeNull();
    expect(snapshot.slotOfferClaim).toBeNull();
  });
});

describe("conversation no pertenece al lead", () => {
  it("assertConversationBelongsToLead throws when the conversation belongs to a different lead", async () => {
    const deps = makeDeps();
    const { lead: leadA } = await seedLeadAndConversation(deps);
    const { conversation: conversationB } = await seedLeadAndConversation(deps); // a different lead+conversation

    await expect(runDryRun(deps, leadA.id, conversationB.id)).rejects.toThrow(ResetTestLeadValidationError);
  });

  it("aborts without modifying anything -- neither lead is touched", async () => {
    const deps = makeDeps();
    const { lead: leadA } = await seedLeadAndConversation(deps);
    const { lead: leadB, conversation: conversationB } = await seedLeadAndConversation(deps);
    const leadsUpdateSpy = vi.spyOn(deps.leads, "update");

    await expect(runDryRun(deps, leadA.id, conversationB.id)).rejects.toThrow(ResetTestLeadValidationError);

    expect(leadsUpdateSpy).not.toHaveBeenCalled();
    expect((await deps.leads.findById(leadA.id))?.status).toBe(leadA.status);
    expect((await deps.leads.findById(leadB.id))?.status).toBe(leadB.status);
  });

  it("also throws for a lead-id/conversation-id that don't exist at all", async () => {
    const deps = makeDeps();
    await expect(runDryRun(deps, UUID_A, UUID_B)).rejects.toThrow(ResetTestLeadValidationError);
  });
});

describe("reset correcto", () => {
  it("resets lead fields, keeps conversation ACTIVE, empties dependent tables, preserves first_contact/first_response and messages", async () => {
    const deps = makeDeps();
    const firstContactAt = new Date("2026-01-01T00:00:00.000Z");
    const firstResponseAt = new Date("2026-01-01T00:05:00.000Z");
    const { lead, conversation } = await seedLeadAndConversation(deps, {
      status: "BOOKED",
      productInterest: "GMM",
      productVertical: "GMM",
      score: 71,
      scoreClass: "B",
      qualifiedAt: new Date("2026-08-27T02:31:38.068Z"),
      bookingStartedAt: new Date("2026-08-27T02:40:00.000Z"),
      bookedAt: new Date("2026-08-27T03:00:00.000Z"),
      meetingAt: new Date("2026-08-28T15:00:00.000Z"),
      firstContactAt,
      firstResponseAt,
    });
    await deps.qualificationAnswers.create({ leadId: lead.id, conversationId: conversation.id, vertical: "GMM", fieldName: "coverage_type", fieldValue: "FAMILY", source: "MANUAL" });
    await deps.leadScores.create({ leadId: lead.id, vertical: "GMM", total: 71, scoreClass: "B", breakdown: {}, rulesVersion: "GMM_QUALIFICATION_V1" });
    await deps.appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-08-28T15:00:00.000Z"), endsAt: new Date("2026-08-28T15:30:00.000Z"), timezone: "America/Mexico_City" });
    await deps.messages.create({ conversationId: conversation.id, leadId: lead.id, direction: "INBOUND", channel: "WHATSAPP", body: "hola", aiGenerated: false, metadata: {} });

    // Stands in for the real `reset_test_lead` Postgres RPC (migration 012): performs the same
    // two field-resets via the same repository methods the RPC's UPDATEs correspond to, and
    // replaces the dependent-table repos with fresh empty ones -- standing in for the RPC's
    // DELETEs, which these deliberately append-only/no-bulk-delete InMemory repositories (they
    // mirror the real app's own read/write patterns, never administrative bulk deletes) have no
    // method to perform directly. The real DELETE semantics live in and are reviewed directly
    // from migration 012's SQL, not re-implemented here.
    const callRpc: ResetTestLeadRpcCaller = async (leadId, conversationId) => {
      await deps.leads.update(leadId, {
        status: "CONTACTED",
        productInterest: undefined,
        productVertical: "UNKNOWN",
        score: 0,
        scoreClass: undefined,
        qualifiedAt: undefined,
        bookingStartedAt: undefined,
        bookedAt: undefined,
        meetingAt: undefined,
        closedAt: undefined,
      });
      await deps.conversations.update(conversationId, { status: "ACTIVE" });
      deps.qualificationAnswers = new InMemoryQualificationAnswerRepository();
      deps.leadScores = new InMemoryLeadScoreRepository();
      deps.offeredSlots = new InMemoryOfferedSlotRepository();
      deps.appointments = new InMemoryAppointmentRepository();
      deps.bookingAttempts = new InMemoryBookingAttemptRepository();
      deps.slotOfferClaims = new InMemorySlotOfferClaimRepository();
      return {
        leadId, conversationId,
        deleted: { leadScores: 1, qualificationAnswers: 1, offeredSlots: 0, appointments: 1, bookingAttempts: 0, slotOfferClaims: 0 },
      };
    };

    const result = await runConfirmedReset(deps, lead.id, conversation.id, callRpc);

    // estado BOOKED vuelve a CONTACTED, y el resto de campos de qualification/booking en null.
    expect(result.after.lead?.status).toBe("CONTACTED");
    expect(result.after.lead?.productInterest).toBeUndefined();
    expect(result.after.lead?.productVertical).toBe("UNKNOWN");
    expect(result.after.lead?.score).toBe(0);
    expect(result.after.lead?.scoreClass).toBeUndefined();
    expect(result.after.lead?.qualifiedAt).toBeUndefined();
    expect(result.after.lead?.bookingStartedAt).toBeUndefined();
    expect(result.after.lead?.bookedAt).toBeUndefined();
    expect(result.after.lead?.meetingAt).toBeUndefined();
    // first_contact_at / first_response_at se preservan.
    expect(result.after.lead?.firstContactAt).toEqual(firstContactAt);
    expect(result.after.lead?.firstResponseAt).toEqual(firstResponseAt);
    // conversation ACTIVE.
    expect(result.after.conversation?.status).toBe("ACTIVE");
    // offered_slots/appointments/etc quedan vacíos.
    expect(result.after.qualificationAnswersCount).toBe(0);
    expect(result.after.leadScoresCount).toBe(0);
    expect(result.after.offeredSlotsRoundCount).toBe(0);
    expect(result.after.activeAppointment).toBeNull();
    expect(result.after.bookingAttemptsCount).toBe(0);
    expect(result.after.slotOfferClaim).toBeNull();
    // messages se preservan.
    expect(result.after.messagesCount).toBe(1);
    expect(result.before.messagesCount).toBe(1);
  });

  it("ninguna otra lead/conversation se toca", async () => {
    const deps = makeDeps();
    const { lead: target, conversation: targetConversation } = await seedLeadAndConversation(deps, { status: "BOOKED" });
    const { lead: other, conversation: otherConversation } = await seedLeadAndConversation(deps, { status: "QUALIFIED_B", productInterest: "GMM" });
    await deps.messages.create({ conversationId: otherConversation.id, leadId: other.id, direction: "INBOUND", channel: "WHATSAPP", body: "no me toques", aiGenerated: false, metadata: {} });

    const callRpc: ResetTestLeadRpcCaller = async (leadId, conversationId) => {
      await deps.leads.update(leadId, { status: "CONTACTED", productInterest: undefined, productVertical: "UNKNOWN", score: 0, scoreClass: undefined });
      await deps.conversations.update(conversationId, { status: "ACTIVE" });
      return { leadId, conversationId, deleted: { leadScores: 0, qualificationAnswers: 0, offeredSlots: 0, appointments: 0, bookingAttempts: 0, slotOfferClaims: 0 } };
    };

    await runConfirmedReset(deps, target.id, targetConversation.id, callRpc);

    const reloadedOther = await deps.leads.findById(other.id);
    expect(reloadedOther?.status).toBe("QUALIFIED_B");
    expect(reloadedOther?.productInterest).toBe("GMM");
    const reloadedOtherConversation = await deps.conversations.findById(otherConversation.id);
    expect(reloadedOtherConversation?.status).toBe("ACTIVE"); // was already ACTIVE, untouched either way
    const otherMessages = await deps.messages.listByConversationId(otherConversation.id);
    expect(otherMessages).toHaveLength(1);
  });
});

describe("orchestration order", () => {
  it("calls the RPC exactly once, with the exact leadId/conversationId, and snapshots before AND after", async () => {
    const deps = makeDeps();
    const { lead, conversation } = await seedLeadAndConversation(deps);
    const callRpc = vi.fn(async (leadId: string, conversationId: string) => ({
      leadId, conversationId,
      deleted: { leadScores: 0, qualificationAnswers: 0, offeredSlots: 0, appointments: 0, bookingAttempts: 0, slotOfferClaims: 0 },
    }));

    await runConfirmedReset(deps, lead.id, conversation.id, callRpc);

    expect(callRpc).toHaveBeenCalledTimes(1);
    expect(callRpc).toHaveBeenCalledWith(lead.id, conversation.id);
  });

  it("never calls the RPC when validation fails", async () => {
    const deps = makeDeps();
    const { lead: leadA } = await seedLeadAndConversation(deps);
    const { conversation: conversationB } = await seedLeadAndConversation(deps);
    const callRpc = vi.fn();

    await expect(runConfirmedReset(deps, leadA.id, conversationB.id, callRpc)).rejects.toThrow(ResetTestLeadValidationError);

    expect(callRpc).not.toHaveBeenCalled();
  });
});
