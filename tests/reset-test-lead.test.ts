import { describe, it, expect, vi } from "vitest";
import {
  parseArgs, captureSnapshot, assertConversationBelongsToLead, runDryRun, runConfirmedReset, formatSnapshot,
  ResetTestLeadUsageError, ResetTestLeadValidationError,
  type ResetTestLeadDeps, type ResetTestLeadRpcCaller,
} from "../scripts/reset-test-lead-lib.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryQualificationAnswerRepository,
  InMemoryLeadScoreRepository, InMemoryOfferedSlotRepository, InMemoryAppointmentRepository,
  InMemoryBookingAttemptRepository, InMemorySlotOfferClaimRepository, InMemoryMessageRepository,
  InMemoryAppointmentCancellationRepository, InMemoryAppointmentRescheduleRepository,
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
    appointmentCancellations: new InMemoryAppointmentCancellationRepository(),
    appointmentReschedules: new InMemoryAppointmentRescheduleRepository(),
  };
}

/** Stands in for the real `reset_test_lead` Postgres RPC (migration 016): performs the same
 * field-resets/deletes the RPC's UPDATEs/DELETEs correspond to, including replacing
 * appointments/appointmentReschedules/appointmentCancellations with fresh empty repos -- standing
 * in for `delete from appointments` cascading away appointment_reschedules/
 * appointment_cancellations via their `on delete cascade` FKs (see migration 016). The real
 * DELETE/cascade semantics live in and are reviewed directly from migration 016's SQL, not
 * re-implemented here -- this InMemory stand-in exists only to exercise
 * reset-test-lead-lib.ts's own orchestration (captureSnapshot/formatSnapshot/runConfirmedReset). */
function makeRealisticRpc(deps: ResetTestLeadDeps): ResetTestLeadRpcCaller {
  return async (leadId, conversationId) => {
    const before = await captureSnapshot(deps, leadId, conversationId);
    await deps.leads.update(leadId, {
      status: "CONTACTED", productInterest: undefined, productVertical: "UNKNOWN", score: 0,
      scoreClass: undefined, qualifiedAt: undefined, bookingStartedAt: undefined,
      bookedAt: undefined, meetingAt: undefined, closedAt: undefined,
    });
    await deps.conversations.update(conversationId, { status: "ACTIVE" });
    deps.qualificationAnswers = new InMemoryQualificationAnswerRepository();
    deps.leadScores = new InMemoryLeadScoreRepository();
    deps.offeredSlots = new InMemoryOfferedSlotRepository();
    deps.appointments = new InMemoryAppointmentRepository();
    deps.bookingAttempts = new InMemoryBookingAttemptRepository();
    deps.slotOfferClaims = new InMemorySlotOfferClaimRepository();
    deps.appointmentReschedules = new InMemoryAppointmentRescheduleRepository();
    deps.appointmentCancellations = new InMemoryAppointmentCancellationRepository();
    return {
      leadId, conversationId,
      appointmentsBeforeReset: before.appointmentsByStatus,
      phase4OperationsBeforeReset: {
        appointmentReschedules: before.appointmentReschedulesCount,
        appointmentCancellations: before.appointmentCancellationsCount,
        appointmentStatusHistory: 0,
        appointmentMessageDeliveries: 0,
      },
      deleted: {
        leadScores: before.leadScoresCount, qualificationAnswers: before.qualificationAnswersCount,
        offeredSlots: before.offeredSlotsRoundCount, appointments: before.appointmentsByStatus.total,
        bookingAttempts: before.bookingAttemptsCount, slotOfferClaims: before.slotOfferClaim ? 1 : 0,
        appointmentReschedulesCascaded: before.appointmentReschedulesCount,
        appointmentCancellationsCascaded: before.appointmentCancellationsCount,
        appointmentStatusHistoryCascaded: 0,
        appointmentMessageDeliveriesCascaded: 0,
      },
    };
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

    const callRpc = makeRealisticRpc(deps);

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

    const callRpc = makeRealisticRpc(deps);

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
    const callRpc = vi.fn(makeRealisticRpc(deps));

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

// -----------------------------------------------------------------------------------------------
// Pre-launch hardening: reset:test-lead must remain correct after Phase 4B (cancellation) and
// Phase 4C (reschedule) left multi-appointment / operation-table residue behind on a lead --
// previously invisible to both the dry-run report and the confirmed-reset's own return value (see
// migration 016 and the ResetTestLeadSnapshot/ResetTestLeadRpcResult doc comments above).
// -----------------------------------------------------------------------------------------------
describe("Pre-launch hardening -- reset Phase 4 test state (tests A-H)", () => {
  it("A) old RESCHEDULED + new BOOKED + appointment_reschedules COMPLETED -> reset deletes both appointments and the reschedule op", async () => {
    const deps = makeDeps();
    const { lead, conversation } = await seedLeadAndConversation(deps, { status: "BOOKED" });
    const oldAppointment = await deps.appointments.create({
      leadId: lead.id, status: "RESCHEDULED",
      startsAt: new Date("2026-08-28T15:00:00.000Z"), endsAt: new Date("2026-08-28T15:30:00.000Z"),
      timezone: "America/Mexico_City",
    });
    const newAppointment = await deps.appointments.create({
      leadId: lead.id, status: "BOOKED", rescheduledFrom: oldAppointment.id,
      startsAt: new Date("2026-08-28T09:30:00.000Z"), endsAt: new Date("2026-08-28T10:00:00.000Z"),
      timezone: "America/Mexico_City",
    });
    const reschedule = await deps.appointmentReschedules.tryCreate({
      leadId: lead.id, oldAppointmentId: oldAppointment.id,
      idempotencyKey: `whatsapp-reschedule:${lead.id}:${oldAppointment.id}:some-offered-slot-id`,
      oldCalendarEventId: "old-cal-event-id",
    });
    await deps.appointmentReschedules.update(reschedule!.id, {
      newAppointmentId: newAppointment.id, newCalendarEventId: "new-cal-event-id",
      phaseAStatus: "COMPLETED", status: "COMPLETED", completedAt: new Date(),
    });

    const before = await captureSnapshot(deps, lead.id, conversation.id);
    expect(before.appointmentsByStatus).toEqual({ total: 2, booked: 1, rescheduled: 1, cancelled: 0, other: 0 });
    expect(before.appointmentReschedulesCount).toBe(1);

    const result = await runConfirmedReset(deps, lead.id, conversation.id, makeRealisticRpc(deps));

    expect(result.after.appointmentsByStatus.total).toBe(0);
    expect(result.after.appointmentReschedulesCount).toBe(0);
    expect(result.rpcResult.deleted.appointments).toBe(2);
    expect(result.rpcResult.deleted.appointmentReschedulesCascaded).toBe(1);
  });

  it("B) CANCELLED appointment + appointment_cancellations -> reset deletes both", async () => {
    const deps = makeDeps();
    const { lead, conversation } = await seedLeadAndConversation(deps, { status: "CANCELLED" });
    const appointment = await deps.appointments.create({
      leadId: lead.id, status: "CANCELLED",
      startsAt: new Date("2026-08-28T15:00:00.000Z"), endsAt: new Date("2026-08-28T15:30:00.000Z"),
      timezone: "America/Mexico_City",
    });
    const cancellation = await deps.appointmentCancellations.tryCreate({
      appointmentId: appointment.id, leadId: lead.id,
      idempotencyKey: `whatsapp-cancel:${lead.id}:${appointment.id}`,
      calendarEventId: "cal-event-id",
    });
    await deps.appointmentCancellations.update(cancellation!.id, { status: "COMPLETED", completedAt: new Date() });

    const before = await captureSnapshot(deps, lead.id, conversation.id);
    expect(before.appointmentsByStatus).toEqual({ total: 1, booked: 0, rescheduled: 0, cancelled: 1, other: 0 });
    expect(before.appointmentCancellationsCount).toBe(1);

    const result = await runConfirmedReset(deps, lead.id, conversation.id, makeRealisticRpc(deps));

    expect(result.after.appointmentsByStatus.total).toBe(0);
    expect(result.after.appointmentCancellationsCount).toBe(0);
    expect(result.rpcResult.deleted.appointments).toBe(1);
    expect(result.rpcResult.deleted.appointmentCancellationsCascaded).toBe(1);
  });

  it("C) mixed historical appointments (BOOKED + RESCHEDULED + CANCELLED) -> all deleted", async () => {
    const deps = makeDeps();
    const { lead, conversation } = await seedLeadAndConversation(deps, { status: "BOOKED" });
    await deps.appointments.create({ leadId: lead.id, status: "CANCELLED", startsAt: new Date("2026-08-01T15:00:00.000Z"), endsAt: new Date("2026-08-01T15:30:00.000Z"), timezone: "America/Mexico_City" });
    await deps.appointments.create({ leadId: lead.id, status: "RESCHEDULED", startsAt: new Date("2026-08-15T15:00:00.000Z"), endsAt: new Date("2026-08-15T15:30:00.000Z"), timezone: "America/Mexico_City" });
    await deps.appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-08-28T15:00:00.000Z"), endsAt: new Date("2026-08-28T15:30:00.000Z"), timezone: "America/Mexico_City" });

    const before = await captureSnapshot(deps, lead.id, conversation.id);
    expect(before.appointmentsByStatus).toEqual({ total: 3, booked: 1, rescheduled: 1, cancelled: 1, other: 0 });

    const result = await runConfirmedReset(deps, lead.id, conversation.id, makeRealisticRpc(deps));

    expect(result.after.appointmentsByStatus.total).toBe(0);
    expect(result.rpcResult.deleted.appointments).toBe(3);
  });

  it("D) messages are preserved through a reset with Phase 4 residue present", async () => {
    const deps = makeDeps();
    const { lead, conversation } = await seedLeadAndConversation(deps, { status: "BOOKED" });
    await deps.appointments.create({ leadId: lead.id, status: "RESCHEDULED", startsAt: new Date("2026-08-28T15:00:00.000Z"), endsAt: new Date("2026-08-28T15:30:00.000Z"), timezone: "America/Mexico_City" });
    await deps.appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-08-29T15:00:00.000Z"), endsAt: new Date("2026-08-29T15:30:00.000Z"), timezone: "America/Mexico_City" });
    await deps.messages.create({ conversationId: conversation.id, leadId: lead.id, direction: "INBOUND", channel: "WHATSAPP", body: "hola", aiGenerated: false, metadata: {} });
    await deps.messages.create({ conversationId: conversation.id, leadId: lead.id, direction: "OUTBOUND", channel: "WHATSAPP", body: "hola de vuelta", aiGenerated: false, metadata: {} });

    const result = await runConfirmedReset(deps, lead.id, conversation.id, makeRealisticRpc(deps));

    expect(result.after.messagesCount).toBe(2);
    const messages = await deps.messages.listByConversationId(conversation.id);
    expect(messages).toHaveLength(2);
  });

  it("E) firstContactAt/firstResponseAt are preserved through a reset with Phase 4 residue present", async () => {
    const deps = makeDeps();
    const firstContactAt = new Date("2026-01-01T00:00:00.000Z");
    const firstResponseAt = new Date("2026-01-01T00:05:00.000Z");
    const { lead, conversation } = await seedLeadAndConversation(deps, { status: "BOOKED", firstContactAt, firstResponseAt });
    await deps.appointments.create({ leadId: lead.id, status: "CANCELLED", startsAt: new Date("2026-08-28T15:00:00.000Z"), endsAt: new Date("2026-08-28T15:30:00.000Z"), timezone: "America/Mexico_City" });

    const result = await runConfirmedReset(deps, lead.id, conversation.id, makeRealisticRpc(deps));

    expect(result.after.lead?.firstContactAt).toEqual(firstContactAt);
    expect(result.after.lead?.firstResponseAt).toEqual(firstResponseAt);
  });

  it("F) lead fields reset correctly (status/product/score/qualifiedAt/bookingStartedAt/bookedAt/meetingAt) even with Phase 4 residue present", async () => {
    const deps = makeDeps();
    const { lead, conversation } = await seedLeadAndConversation(deps, {
      status: "BOOKED", productInterest: "GMM", productVertical: "GMM", score: 81, scoreClass: "A",
      qualifiedAt: new Date("2026-08-01T00:00:00.000Z"), bookingStartedAt: new Date("2026-08-02T00:00:00.000Z"),
      bookedAt: new Date("2026-08-03T00:00:00.000Z"), meetingAt: new Date("2026-08-28T15:30:00.000Z"),
    });
    const oldAppointment = await deps.appointments.create({ leadId: lead.id, status: "RESCHEDULED", startsAt: new Date("2026-08-27T15:00:00.000Z"), endsAt: new Date("2026-08-27T15:30:00.000Z"), timezone: "America/Mexico_City" });
    await deps.appointments.create({ leadId: lead.id, status: "BOOKED", rescheduledFrom: oldAppointment.id, startsAt: new Date("2026-08-28T15:30:00.000Z"), endsAt: new Date("2026-08-28T16:00:00.000Z"), timezone: "America/Mexico_City" });

    const result = await runConfirmedReset(deps, lead.id, conversation.id, makeRealisticRpc(deps));

    expect(result.after.lead?.status).toBe("CONTACTED");
    expect(result.after.lead?.productInterest).toBeUndefined();
    expect(result.after.lead?.productVertical).toBe("UNKNOWN");
    expect(result.after.lead?.score).toBe(0);
    expect(result.after.lead?.scoreClass).toBeUndefined();
    expect(result.after.lead?.qualifiedAt).toBeUndefined();
    expect(result.after.lead?.bookingStartedAt).toBeUndefined();
    expect(result.after.lead?.bookedAt).toBeUndefined();
    expect(result.after.lead?.meetingAt).toBeUndefined();
  });

  it("G) a failing RPC call leaves the before-state completely intact (mirrors the real RPC's single-transaction atomicity -- an exception anywhere inside the Postgres function aborts the whole transaction, nothing partial ever persists)", async () => {
    const deps = makeDeps();
    const { lead, conversation } = await seedLeadAndConversation(deps, { status: "BOOKED" });
    const appointment = await deps.appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-08-28T15:00:00.000Z"), endsAt: new Date("2026-08-28T15:30:00.000Z"), timezone: "America/Mexico_City" });
    const reschedule = await deps.appointmentReschedules.tryCreate({
      leadId: lead.id, oldAppointmentId: appointment.id,
      idempotencyKey: `whatsapp-reschedule:${lead.id}:${appointment.id}:some-offered-slot-id`,
    });
    expect(reschedule).not.toBeNull();

    const failingRpc: ResetTestLeadRpcCaller = async () => {
      throw new Error("reset_test_lead RPC failed: simulated Postgres connection error");
    };

    await expect(runConfirmedReset(deps, lead.id, conversation.id, failingRpc)).rejects.toThrow(
      "simulated Postgres connection error",
    );

    // Nothing partial persisted: the lead, the appointment, and the reschedule row are all
    // exactly as they were before the failed call.
    const reloadedLead = await deps.leads.findById(lead.id);
    expect(reloadedLead?.status).toBe("BOOKED");
    const reloadedAppointments = await deps.appointments.listAllByLeadId(lead.id);
    expect(reloadedAppointments).toHaveLength(1);
    expect(reloadedAppointments[0]?.status).toBe("BOOKED");
    const reloadedReschedules = await deps.appointmentReschedules.listByLeadId(lead.id);
    expect(reloadedReschedules).toHaveLength(1);
  });

  it("H) dry-run reports total/status appointment counts and Phase 4 operation counts, not just the single active appointment", async () => {
    const deps = makeDeps();
    const { lead, conversation } = await seedLeadAndConversation(deps, { status: "BOOKED" });
    const oldAppointment = await deps.appointments.create({ leadId: lead.id, status: "RESCHEDULED", startsAt: new Date("2026-08-27T15:00:00.000Z"), endsAt: new Date("2026-08-27T15:30:00.000Z"), timezone: "America/Mexico_City" });
    const newAppointment = await deps.appointments.create({ leadId: lead.id, status: "BOOKED", rescheduledFrom: oldAppointment.id, startsAt: new Date("2026-08-28T15:00:00.000Z"), endsAt: new Date("2026-08-28T15:30:00.000Z"), timezone: "America/Mexico_City" });
    const reschedule = await deps.appointmentReschedules.tryCreate({
      leadId: lead.id, oldAppointmentId: oldAppointment.id,
      idempotencyKey: `whatsapp-reschedule:${lead.id}:${oldAppointment.id}:some-offered-slot-id`,
    });
    await deps.appointmentReschedules.update(reschedule!.id, { newAppointmentId: newAppointment.id, phaseAStatus: "COMPLETED", status: "COMPLETED" });

    const snapshot = await runDryRun(deps, lead.id, conversation.id);

    // The exact regression this hardening pass closes: previously the dry-run only ever showed
    // "appointments (active) = 1", completely missing the old RESCHEDULED row and the reschedule
    // operation -- exactly the discrepancy the real lead's dry-run showed pre-launch.
    expect(snapshot.appointmentsByStatus).toEqual({ total: 2, booked: 1, rescheduled: 1, cancelled: 0, other: 0 });
    expect(snapshot.appointmentReschedulesCount).toBe(1);
    expect(snapshot.appointmentCancellationsCount).toBe(0);

    const formatted = formatSnapshot(snapshot);
    expect(formatted).toContain("appointments total      = 2 (BOOKED = 1, RESCHEDULED = 1, CANCELLED = 0, other = 0)");
    expect(formatted).toContain("appointment_reschedules = 1");
    expect(formatted).toContain("appointment_cancellations = 0");
  });
});
