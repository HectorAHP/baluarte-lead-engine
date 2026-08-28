/**
 * Reusable logic for the test-lead reset tool: argument parsing, snapshot capture/formatting,
 * the dry-run/confirmed-reset orchestration, and the real-Supabase `main()` that the CLI
 * entrypoint (scripts/reset-test-lead.ts) invokes.
 *
 * Administrative reset for a SINGLE test lead/conversation, EXCLUSIVELY for Phase 3C E2E test
 * data -- never intended to run against a real lead.
 *
 * Usage (via the entrypoint):
 *   npm.cmd run reset:test-lead -- --lead-id <uuid> --conversation-id <uuid>            (dry run)
 *   npm.cmd run reset:test-lead -- --lead-id <uuid> --conversation-id <uuid> --confirm   (reset)
 *
 * Without --confirm: read-only. Prints the current state and what WOULD be deleted/reset, and
 * makes no changes whatsoever.
 *
 * With --confirm: validates that the given conversation actually belongs to the given lead
 * (aborting, unchanged, if not), then calls the `reset_test_lead` Postgres RPC (migration 012),
 * which performs the entire reset as one atomic transaction -- see that migration for exactly
 * what it deletes/resets and why an RPC (not a sequence of separate supabase-js calls) is
 * necessary for atomicity.
 *
 * This module has no top-level side effects on import -- everything is a named export, and
 * nothing runs automatically -- so it's safe for tests/reset-test-lead.test.ts to import
 * everything below (including `main`) without triggering a real CLI run. The actual CLI
 * entrypoint lives in scripts/reset-test-lead.ts, which does nothing except call `main()`.
 */
import type {
  LeadRepository, ConversationRepository, QualificationAnswerRepository, LeadScoreRepository,
  OfferedSlotRepository, AppointmentRepository, BookingAttemptRepository, SlotOfferClaimRepository,
  MessageRepository, AppointmentCancellationRepository, AppointmentRescheduleRepository,
} from "../src/application/ports.js";
import type { Lead } from "../src/domain/lead.js";
import type { Conversation } from "../src/domain/conversation.js";
import type { Appointment } from "../src/domain/appointment.js";
import type { SlotOfferClaim } from "../src/domain/slot-offer-claim.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ResetTestLeadUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetTestLeadUsageError";
  }
}

export class ResetTestLeadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetTestLeadValidationError";
  }
}

export interface ResetTestLeadArgs {
  leadId: string;
  conversationId: string;
  confirm: boolean;
}

/** Deliberately no external CLI-parsing dependency -- this project has none, and the surface
 * here (two required UUID flags + one boolean flag) doesn't warrant adding one. */
export function parseArgs(argv: string[]): ResetTestLeadArgs {
  let leadId: string | undefined;
  let conversationId: string | undefined;
  let confirm = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--lead-id") {
      leadId = argv[++i];
    } else if (arg === "--conversation-id") {
      conversationId = argv[++i];
    } else if (arg === "--confirm") {
      confirm = true;
    } else {
      throw new ResetTestLeadUsageError(`Unrecognized argument: ${arg}`);
    }
  }

  if (!leadId) throw new ResetTestLeadUsageError("--lead-id is required");
  if (!conversationId) throw new ResetTestLeadUsageError("--conversation-id is required");
  if (!UUID_PATTERN.test(leadId)) throw new ResetTestLeadUsageError(`--lead-id is not a valid UUID: ${leadId}`);
  if (!UUID_PATTERN.test(conversationId)) throw new ResetTestLeadUsageError(`--conversation-id is not a valid UUID: ${conversationId}`);

  return { leadId, conversationId, confirm };
}

export interface ResetTestLeadDeps {
  leads: LeadRepository;
  conversations: ConversationRepository;
  qualificationAnswers: QualificationAnswerRepository;
  leadScores: LeadScoreRepository;
  offeredSlots: OfferedSlotRepository;
  appointments: AppointmentRepository;
  bookingAttempts: BookingAttemptRepository;
  slotOfferClaims: SlotOfferClaimRepository;
  messages: MessageRepository;
  appointmentCancellations: AppointmentCancellationRepository;
  appointmentReschedules: AppointmentRescheduleRepository;
}

/** Every appointment for a lead, ANY status, broken down -- see
 * AppointmentRepository.listAllByLeadId. Pre-launch hardening: this replaces the old
 * "activeAppointment only" view, which silently missed Phase 4B/4C residue like an old
 * RESCHEDULED row sitting alongside a new BOOKED one. */
export interface AppointmentStatusBreakdown {
  total: number;
  booked: number;
  rescheduled: number;
  cancelled: number;
  other: number;
}

function summarizeAppointmentsByStatus(appointments: Appointment[]): AppointmentStatusBreakdown {
  let booked = 0, rescheduled = 0, cancelled = 0, other = 0;
  for (const a of appointments) {
    if (a.status === "BOOKED") booked++;
    else if (a.status === "RESCHEDULED") rescheduled++;
    else if (a.status === "CANCELLED") cancelled++;
    else other++;
  }
  return { total: appointments.length, booked, rescheduled, cancelled, other };
}

export interface ResetTestLeadSnapshot {
  lead: Lead | null;
  conversation: Conversation | null;
  qualificationAnswersCount: number;
  leadScoresCount: number;
  /** Distinct offered_slots rounds for this conversation (all-time) -- offered_slots has no
   * "list every historical row" method on OfferedSlotRepository (by design, matching every other
   * caller's needs), so a total row count isn't available here; round count plus the
   * currently-active count below is the closest accurate signal without inventing one. */
  offeredSlotsRoundCount: number;
  offeredSlotsActiveCount: number;
  /** Every appointment for this lead, ANY status (see AppointmentRepository.listAllByLeadId) --
   * this is what the RPC's own `delete from appointments where lead_id = ...` will remove, in
   * full, regardless of status. */
  appointments: Appointment[];
  appointmentsByStatus: AppointmentStatusBreakdown;
  /** Convenience accessor, unchanged in meaning from before this hardening pass: the lead's
   * single currently-BOOKED appointment (most recently created, if more than one -- see
   * AppointmentRepository.findActiveByLeadId's doc comment on the brief Phase 4C coexistence
   * window). Kept alongside `appointments`/`appointmentsByStatus` above, which are now the
   * authoritative full picture -- this field alone was previously the ONLY appointment visibility
   * the dry-run had, which is exactly what let Phase 4B/4C residue go unnoticed. */
  activeAppointment: Appointment | null;
  bookingAttemptsCount: number;
  slotOfferClaim: SlotOfferClaim | null;
  messagesCount: number;
  /** Phase 4C reschedule-operation rows for this lead -- see AppointmentRescheduleRepository.
   * These are cascade-deleted (not directly, via appointment_reschedules.old_appointment_id/
   * new_appointment_id `on delete cascade`) whenever the appointments they reference are deleted. */
  appointmentReschedulesCount: number;
  /** Phase 4B cancellation-operation rows for this lead -- see AppointmentCancellationRepository.
   * Same cascade-deletion note as appointmentReschedulesCount above. */
  appointmentCancellationsCount: number;
}

export async function captureSnapshot(
  deps: ResetTestLeadDeps,
  leadId: string,
  conversationId: string,
  now: Date = new Date(),
): Promise<ResetTestLeadSnapshot> {
  const [
    lead, conversation, qualificationAnswers, leadScores, offeredSlotsActive, offeredSlotsRounds,
    activeAppointment, allAppointments, bookingAttempts, slotOfferClaim, messages,
    appointmentReschedules, appointmentCancellations,
  ] = await Promise.all([
      deps.leads.findById(leadId),
      deps.conversations.findById(conversationId),
      deps.qualificationAnswers.listByLeadId(leadId),
      deps.leadScores.listByLeadId(leadId),
      deps.offeredSlots.listActiveByConversationId(conversationId, now),
      deps.offeredSlots.listRoundIdsByConversationId(conversationId),
      deps.appointments.findActiveByLeadId(leadId),
      deps.appointments.listAllByLeadId(leadId),
      deps.bookingAttempts.listByLeadId(leadId),
      deps.slotOfferClaims.findByConversationId(conversationId),
      deps.messages.listByConversationId(conversationId),
      deps.appointmentReschedules.listByLeadId(leadId),
      deps.appointmentCancellations.listByLeadId(leadId),
    ]);

  return {
    lead,
    conversation,
    qualificationAnswersCount: qualificationAnswers.length,
    leadScoresCount: leadScores.length,
    offeredSlotsRoundCount: offeredSlotsRounds.length,
    offeredSlotsActiveCount: offeredSlotsActive.length,
    appointments: allAppointments,
    appointmentsByStatus: summarizeAppointmentsByStatus(allAppointments),
    activeAppointment,
    bookingAttemptsCount: bookingAttempts.length,
    slotOfferClaim,
    messagesCount: messages.length,
    appointmentReschedulesCount: appointmentReschedules.length,
    appointmentCancellationsCount: appointmentCancellations.length,
  };
}

/** Aborts loudly (never silently resets the wrong rows) if the lead/conversation don't exist, or
 * the conversation doesn't actually belong to the given lead. */
export function assertConversationBelongsToLead(snapshot: ResetTestLeadSnapshot, leadId: string, conversationId: string): void {
  if (!snapshot.lead) throw new ResetTestLeadValidationError(`No existe un lead con id ${leadId}`);
  if (!snapshot.conversation) throw new ResetTestLeadValidationError(`No existe una conversation con id ${conversationId}`);
  if (snapshot.conversation.leadId !== leadId) {
    throw new ResetTestLeadValidationError(
      `La conversation ${conversationId} pertenece al lead ${snapshot.conversation.leadId}, no a ${leadId} -- abortando, no se modifica nada.`,
    );
  }
}

export function formatSnapshot(snapshot: ResetTestLeadSnapshot): string {
  const lead = snapshot.lead;
  const conversation = snapshot.conversation;
  const byStatus = snapshot.appointmentsByStatus;
  return [
    `  lead.status            = ${lead?.status ?? "(not found)"}`,
    `  lead.productInterest    = ${lead?.productInterest ?? "null"}`,
    `  lead.productVertical    = ${lead?.productVertical ?? "-"}`,
    `  lead.score / scoreClass = ${lead?.score ?? "-"} / ${lead?.scoreClass ?? "null"}`,
    `  lead.qualifiedAt        = ${lead?.qualifiedAt?.toISOString() ?? "null"}`,
    `  lead.bookingStartedAt   = ${lead?.bookingStartedAt?.toISOString() ?? "null"}`,
    `  lead.bookedAt           = ${lead?.bookedAt?.toISOString() ?? "null"}`,
    `  lead.meetingAt          = ${lead?.meetingAt?.toISOString() ?? "null"}`,
    `  lead.firstContactAt     = ${lead?.firstContactAt?.toISOString() ?? "null"} (preserved, never reset)`,
    `  lead.firstResponseAt    = ${lead?.firstResponseAt?.toISOString() ?? "null"} (preserved, never reset)`,
    `  conversation.status     = ${conversation?.status ?? "(not found)"}`,
    `  qualification_answers   = ${snapshot.qualificationAnswersCount}`,
    `  lead_scores             = ${snapshot.leadScoresCount}`,
    `  offered_slots           = ${snapshot.offeredSlotsRoundCount} round(s), ${snapshot.offeredSlotsActiveCount} currently active`,
    `  appointments total      = ${byStatus.total} (BOOKED = ${byStatus.booked}, RESCHEDULED = ${byStatus.rescheduled}, CANCELLED = ${byStatus.cancelled}, other = ${byStatus.other})`,
    `  appointments (active)   = ${snapshot.activeAppointment ? `1 (id ${snapshot.activeAppointment.id})` : "0"}`,
    `  appointment_reschedules = ${snapshot.appointmentReschedulesCount}`,
    `  appointment_cancellations = ${snapshot.appointmentCancellationsCount}`,
    `  booking_attempts        = ${snapshot.bookingAttemptsCount}`,
    `  slot_offer_claims       = ${snapshot.slotOfferClaim ? `1 (owner ${snapshot.slotOfferClaim.ownerToken})` : "0"}`,
    `  messages (preserved)    = ${snapshot.messagesCount}`,
  ].join("\n");
}

export interface ResetTestLeadRpcResult {
  leadId: string;
  conversationId: string;
  /** Pre-launch hardening: the RPC (migration 016) now reports what it saw BEFORE deleting
   * anything, mirroring ResetTestLeadSnapshot.appointmentsByStatus/appointmentReschedulesCount/
   * appointmentCancellationsCount above -- so a completed reset's own return value is a
   * self-sufficient audit record, not just the TypeScript-side "before" snapshot. */
  appointmentsBeforeReset: AppointmentStatusBreakdown;
  phase4OperationsBeforeReset: {
    appointmentReschedules: number;
    appointmentCancellations: number;
    appointmentStatusHistory: number;
    appointmentMessageDeliveries: number;
  };
  deleted: {
    leadScores: number;
    qualificationAnswers: number;
    offeredSlots: number;
    appointments: number;
    bookingAttempts: number;
    slotOfferClaims: number;
    /** These four are never deleted by a direct DELETE statement -- they're removed by cascade
     * off the `appointments` delete above (see migrations 013/014/015's `on delete cascade`
     * FKs). Counted before the cascade happens, same values as phase4OperationsBeforeReset. */
    appointmentReschedulesCascaded: number;
    appointmentCancellationsCascaded: number;
    appointmentStatusHistoryCascaded: number;
    appointmentMessageDeliveriesCascaded: number;
  };
}

export type ResetTestLeadRpcCaller = (leadId: string, conversationId: string) => Promise<ResetTestLeadRpcResult>;

/** Read-only: captures + validates, never writes anything. Safe to call any number of times. */
export async function runDryRun(deps: ResetTestLeadDeps, leadId: string, conversationId: string): Promise<ResetTestLeadSnapshot> {
  const snapshot = await captureSnapshot(deps, leadId, conversationId);
  assertConversationBelongsToLead(snapshot, leadId, conversationId);
  return snapshot;
}

export interface ResetTestLeadRunResult {
  before: ResetTestLeadSnapshot;
  rpcResult: ResetTestLeadRpcResult;
  after: ResetTestLeadSnapshot;
}

/** Validates BEFORE ever calling the RPC -- an invalid lead/conversation pair never reaches
 * Postgres at all (the RPC itself also validates, as a second, independent layer, but the script
 * fails fast with a clear message instead of surfacing a raw Postgres exception). */
export async function runConfirmedReset(
  deps: ResetTestLeadDeps,
  leadId: string,
  conversationId: string,
  callRpc: ResetTestLeadRpcCaller,
): Promise<ResetTestLeadRunResult> {
  const before = await captureSnapshot(deps, leadId, conversationId);
  assertConversationBelongsToLead(before, leadId, conversationId);
  const rpcResult = await callRpc(leadId, conversationId);
  const after = await captureSnapshot(deps, leadId, conversationId);
  return { before, rpcResult, after };
}

/**
 * Real-Supabase CLI orchestration: parses argv, wires up real repositories, and either prints a
 * dry-run preview (no --confirm) or performs the confirmed reset via the `reset_test_lead` RPC
 * (--confirm). The repository classes are dynamically imported so that merely importing this
 * module (as tests do) never touches src/infrastructure/supabase-client.js or reads Supabase
 * env vars -- that only happens once this function actually runs.
 */
export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const { createSupabaseClient } = await import("../src/infrastructure/supabase-client.js");
  const { SupabaseLeadRepository } = await import("../src/infrastructure/supabase-lead-repository.js");
  const { SupabaseConversationRepository } = await import("../src/infrastructure/supabase-conversation-repository.js");
  const { SupabaseQualificationAnswerRepository } = await import("../src/infrastructure/supabase-qualification-answer-repository.js");
  const { SupabaseLeadScoreRepository } = await import("../src/infrastructure/supabase-lead-score-repository.js");
  const { SupabaseOfferedSlotRepository } = await import("../src/infrastructure/supabase-offered-slot-repository.js");
  const { SupabaseAppointmentRepository } = await import("../src/infrastructure/supabase-appointment-repository.js");
  const { SupabaseBookingAttemptRepository } = await import("../src/infrastructure/supabase-booking-attempt-repository.js");
  const { SupabaseSlotOfferClaimRepository } = await import("../src/infrastructure/supabase-slot-offer-claim-repository.js");
  const { SupabaseMessageRepository } = await import("../src/infrastructure/supabase-message-repository.js");
  const { SupabaseAppointmentCancellationRepository } = await import("../src/infrastructure/supabase-appointment-cancellation-repository.js");
  const { SupabaseAppointmentRescheduleRepository } = await import("../src/infrastructure/supabase-appointment-reschedule-repository.js");

  const client = createSupabaseClient();
  const deps: ResetTestLeadDeps = {
    leads: new SupabaseLeadRepository(client),
    conversations: new SupabaseConversationRepository(client),
    qualificationAnswers: new SupabaseQualificationAnswerRepository(client),
    leadScores: new SupabaseLeadScoreRepository(client),
    offeredSlots: new SupabaseOfferedSlotRepository(client),
    appointments: new SupabaseAppointmentRepository(client),
    bookingAttempts: new SupabaseBookingAttemptRepository(client),
    slotOfferClaims: new SupabaseSlotOfferClaimRepository(client),
    messages: new SupabaseMessageRepository(client),
    appointmentCancellations: new SupabaseAppointmentCancellationRepository(client),
    appointmentReschedules: new SupabaseAppointmentRescheduleRepository(client),
  };

  console.log(`lead-id:         ${args.leadId}`);
  console.log(`conversation-id: ${args.conversationId}`);
  console.log("");

  if (!args.confirm) {
    console.log("DRY RUN -- no changes will be made. Pass --confirm to actually reset.\n");
    const snapshot = await runDryRun(deps, args.leadId, args.conversationId);
    console.log("Current state:");
    console.log(formatSnapshot(snapshot));
    if (snapshot.appointmentsByStatus.total > 1 || snapshot.appointmentReschedulesCount > 0 || snapshot.appointmentCancellationsCount > 0) {
      console.log("\n*** Phase 4B/4C residue detected on this lead (more than one appointment and/or");
      console.log("*** appointment_reschedules/appointment_cancellations rows) -- see the breakdown above.");
      console.log("*** If the currently-BOOKED appointment (if any) has a real Google Calendar event,");
      console.log("*** decide what to do with that event BEFORE running --confirm: this tool never calls");
      console.log("*** Calendar, so --confirm will delete the DB row but leave any live Calendar event");
      console.log("*** orphaned.");
    }
    console.log("\nWith --confirm, this tool would DELETE the qualification_answers, lead_scores,");
    console.log("offered_slots, ALL appointments (any status) and their Phase 4B/4C operation rows");
    console.log("(appointment_reschedules/appointment_cancellations, removed via cascade -- see");
    console.log("migration 016), booking_attempts, and slot_offer_claims rows for this lead/conversation,");
    console.log("reset the lead to CONTACTED with no product/score, and leave conversation.status =");
    console.log("ACTIVE. messages and lead_status_history are never touched. This tool never calls");
    console.log("Google Calendar -- any live Calendar event for a deleted appointment is NOT cleaned up");
    console.log("by this reset and must be handled separately, deliberately, beforehand if needed.");
    return;
  }

  console.log("CONFIRMED RESET -- this will permanently delete test data for this lead/conversation.\n");
  const callRpc: ResetTestLeadRpcCaller = async (leadId, conversationId) => {
    const { data, error } = await client.rpc("reset_test_lead", { p_lead_id: leadId, p_conversation_id: conversationId });
    if (error) throw new Error(`reset_test_lead RPC failed: ${error.message}`);
    return data as ResetTestLeadRpcResult;
  };

  const result = await runConfirmedReset(deps, args.leadId, args.conversationId, callRpc);
  console.log("Before:");
  console.log(formatSnapshot(result.before));
  console.log("\nDeleted:");
  console.log(`  lead_scores           = ${result.rpcResult.deleted.leadScores}`);
  console.log(`  qualification_answers = ${result.rpcResult.deleted.qualificationAnswers}`);
  console.log(`  offered_slots         = ${result.rpcResult.deleted.offeredSlots}`);
  console.log(`  appointments          = ${result.rpcResult.deleted.appointments} (BOOKED = ${result.rpcResult.appointmentsBeforeReset.booked}, RESCHEDULED = ${result.rpcResult.appointmentsBeforeReset.rescheduled}, CANCELLED = ${result.rpcResult.appointmentsBeforeReset.cancelled}, other = ${result.rpcResult.appointmentsBeforeReset.other})`);
  console.log(`  booking_attempts      = ${result.rpcResult.deleted.bookingAttempts}`);
  console.log(`  slot_offer_claims     = ${result.rpcResult.deleted.slotOfferClaims}`);
  console.log(`  appointment_reschedules (cascaded)    = ${result.rpcResult.deleted.appointmentReschedulesCascaded}`);
  console.log(`  appointment_cancellations (cascaded)  = ${result.rpcResult.deleted.appointmentCancellationsCascaded}`);
  console.log("\nAfter:");
  console.log(formatSnapshot(result.after));
}
