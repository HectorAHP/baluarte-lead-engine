/**
 * Administrative reset for a SINGLE test lead/conversation, EXCLUSIVELY for Phase 3C E2E test
 * data -- never intended to run against a real lead.
 *
 * Usage:
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
 * This file is split into small, independently-testable functions (parseArgs, captureSnapshot,
 * assertConversationBelongsToLead, runDryRun, runConfirmedReset) plus a thin `main()` that wires
 * up the real Supabase client -- see tests/reset-test-lead.test.ts, which exercises all of the
 * above against in-memory repositories, never real Supabase.
 */
import type {
  LeadRepository, ConversationRepository, QualificationAnswerRepository, LeadScoreRepository,
  OfferedSlotRepository, AppointmentRepository, BookingAttemptRepository, SlotOfferClaimRepository,
  MessageRepository,
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
  /** Only the lead's currently-BOOKED appointment, if any -- AppointmentRepository has no
   * "list every historical row" method either. A stray CANCELLED appointment (rare in normal
   * test usage) would not show here even though the RPC deletes it too. */
  activeAppointment: Appointment | null;
  bookingAttemptsCount: number;
  slotOfferClaim: SlotOfferClaim | null;
  messagesCount: number;
}

export async function captureSnapshot(
  deps: ResetTestLeadDeps,
  leadId: string,
  conversationId: string,
  now: Date = new Date(),
): Promise<ResetTestLeadSnapshot> {
  const [lead, conversation, qualificationAnswers, leadScores, offeredSlotsActive, offeredSlotsRounds, activeAppointment, bookingAttempts, slotOfferClaim, messages] =
    await Promise.all([
      deps.leads.findById(leadId),
      deps.conversations.findById(conversationId),
      deps.qualificationAnswers.listByLeadId(leadId),
      deps.leadScores.listByLeadId(leadId),
      deps.offeredSlots.listActiveByConversationId(conversationId, now),
      deps.offeredSlots.listRoundIdsByConversationId(conversationId),
      deps.appointments.findActiveByLeadId(leadId),
      deps.bookingAttempts.listByLeadId(leadId),
      deps.slotOfferClaims.findByConversationId(conversationId),
      deps.messages.listByConversationId(conversationId),
    ]);

  return {
    lead,
    conversation,
    qualificationAnswersCount: qualificationAnswers.length,
    leadScoresCount: leadScores.length,
    offeredSlotsRoundCount: offeredSlotsRounds.length,
    offeredSlotsActiveCount: offeredSlotsActive.length,
    activeAppointment,
    bookingAttemptsCount: bookingAttempts.length,
    slotOfferClaim,
    messagesCount: messages.length,
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
    `  appointments (active)   = ${snapshot.activeAppointment ? `1 (id ${snapshot.activeAppointment.id})` : "0"}`,
    `  booking_attempts        = ${snapshot.bookingAttemptsCount}`,
    `  slot_offer_claims       = ${snapshot.slotOfferClaim ? `1 (owner ${snapshot.slotOfferClaim.ownerToken})` : "0"}`,
    `  messages (preserved)    = ${snapshot.messagesCount}`,
  ].join("\n");
}

export interface ResetTestLeadRpcResult {
  leadId: string;
  conversationId: string;
  deleted: {
    leadScores: number;
    qualificationAnswers: number;
    offeredSlots: number;
    appointments: number;
    bookingAttempts: number;
    slotOfferClaims: number;
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

// -------------------------------------------------------------------------------------------
// CLI entry point -- only runs when this file is executed directly (`npm run reset:test-lead`),
// never when imported by tests.
// -------------------------------------------------------------------------------------------

async function main(): Promise<void> {
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
  };

  console.log(`lead-id:         ${args.leadId}`);
  console.log(`conversation-id: ${args.conversationId}`);
  console.log("");

  if (!args.confirm) {
    console.log("DRY RUN -- no changes will be made. Pass --confirm to actually reset.\n");
    const snapshot = await runDryRun(deps, args.leadId, args.conversationId);
    console.log("Current state:");
    console.log(formatSnapshot(snapshot));
    console.log("\nWith --confirm, this tool would DELETE the qualification_answers, lead_scores,");
    console.log("offered_slots, appointments, booking_attempts, and slot_offer_claims rows listed");
    console.log("above (scoped to this lead/conversation only), reset the lead to CONTACTED with no");
    console.log("product/score, and leave conversation.status = ACTIVE. messages are never touched.");
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
  console.log(`  appointments          = ${result.rpcResult.deleted.appointments}`);
  console.log(`  booking_attempts      = ${result.rpcResult.deleted.bookingAttempts}`);
  console.log(`  slot_offer_claims     = ${result.rpcResult.deleted.slotOfferClaims}`);
  console.log("\nAfter:");
  console.log(formatSnapshot(result.after));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
