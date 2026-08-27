import type { LeadRepository, ConversationRepository, MessagingProvider, MessageRepository, LeadStatusHistoryRepository, Logger } from "./ports.js";
import type { Lead, LeadStatus } from "../domain/lead.js";
import type { Appointment } from "../domain/appointment.js";
import { assertTransition } from "../domain/state-machine.js";
import { sendAndPersistReply } from "./whatsapp-inbound-service.js";
import type { SlotOfferOutcome } from "./slot-offering-service.js";
import { recordLeadStatusTransition } from "./lead-status-audit.js";
import {
  buildSlotOfferMessage, SLOT_UNAVAILABLE_INTRO, buildExistingBookingMessage, formatSlotForDisplay,
  BOOKING_NO_AVAILABILITY_MESSAGE, QUALIFIER_HUMAN_HANDOFF_MESSAGE,
} from "../domain/message-templates.js";

export interface BookingOutcomeDeps {
  leads: LeadRepository;
  conversations: ConversationRepository;
  messaging: MessagingProvider;
  messages: MessageRepository;
  leadStatusHistory: LeadStatusHistoryRepository;
  logger: Logger;
}

/**
 * Idempotent, self-healing confirmation step. Shared by WhatsAppBookingHandler (every "an
 * appointment already/just exists" branch) and WhatsAppQualificationHandler's
 * dispatchSlotOfferOutcome (ALREADY_BOOKED) -- both must reconcile the lead against the real
 * appointment identically.
 *
 * status: set to BOOKED only if not already (no write, no assertTransition call, when it's
 * already BOOKED -- matches the pre-existing idempotent contract).
 *
 * bookedAt / meetingAt: the PRIMARY write for a fresh, successful booking happens inside
 * AppointmentService.completeBooking (bookedAt=now, meetingAt=appointment.startsAt), in the same
 * domain-layer call that creates the appointment -- never duplicated here. This function only
 * BACKFILLS either field when it's still missing on the lead passed in, which self-heals the
 * exact drift a live appointment can be found to have (e.g. completeBooking's own best-effort
 * leads.update failed after the appointment was already durably created -- see its TODO comment)
 * without ever overwriting a value that's already correctly set.
 *
 * Phase 4A: records exactly one lead_status_history row when this call actually performs the
 * BOOKED transition (never on a pure bookedAt/meetingAt backfill with no status change, and never
 * on the fully-idempotent no-op below).
 */
export async function markLeadBooked(
  deps: Pick<BookingOutcomeDeps, "leads" | "leadStatusHistory" | "logger">,
  lead: Lead,
  appointment: Appointment,
): Promise<Lead> {
  const patch: Partial<Lead> = {};
  const wasBooked = lead.status === "BOOKED";
  if (!wasBooked) {
    assertTransition(lead.status, "BOOKED");
    patch.status = "BOOKED";
  }
  if (!lead.bookedAt) patch.bookedAt = new Date();
  if (!lead.meetingAt) patch.meetingAt = appointment.startsAt;
  if (Object.keys(patch).length === 0) return lead; // fully idempotent no-op -- nothing missing to backfill
  const updated = await deps.leads.update(lead.id, patch);
  if (!wasBooked) {
    await recordLeadStatusTransition(deps.leadStatusHistory, deps.logger, {
      leadId: lead.id,
      fromStatus: lead.status,
      toStatus: "BOOKED",
      eventType: "BOOKING_CONFIRMED",
    });
  }
  return updated;
}

/**
 * Escalates lead+conversation to HUMAN_HANDOFF with the standard handoff copy. Shared for the
 * same reason as markLeadBooked above: MAX_ROUNDS_REACHED and the booking consistency errors
 * (ActiveOfferInconsistentError, BookingAttemptInconsistentError) can surface from either
 * WhatsAppQualificationHandler (right after qualification completes) or WhatsAppBookingHandler
 * (on a later BOOKING_PENDING turn), and both must escalate identically -- one message, lead and
 * conversation both HUMAN_HANDOFF, score/scoreClass untouched (this never writes to those
 * fields).
 */
export async function escalateToHuman(
  deps: BookingOutcomeDeps,
  lead: Lead,
  conversationId: string,
  whatsappUserId: string,
  eventType: string = "BOOKING_INCONSISTENCY_HANDOFF",
): Promise<void> {
  const target: LeadStatus = "HUMAN_HANDOFF";
  if (lead.status !== target) {
    assertTransition(lead.status, target);
    await deps.leads.update(lead.id, { status: target });
    await recordLeadStatusTransition(deps.leadStatusHistory, deps.logger, {
      leadId: lead.id,
      fromStatus: lead.status,
      toStatus: target,
      eventType,
    });
  }
  await deps.conversations.update(conversationId, { status: "HUMAN_HANDOFF" });
  await sendAndPersistReply(deps, lead.id, conversationId, whatsappUserId, QUALIFIER_HUMAN_HANDOFF_MESSAGE);
}

/**
 * Given a SlotOfferOutcome (from SlotOfferingService.getOrCreateOffer/replaceOffer), sends
 * exactly the right message and applies the right side effect. Shared by
 * WhatsAppQualificationHandler (immediately after qualification completes for QUALIFIED_A/B) and
 * WhatsAppBookingHandler (on every BOOKING_PENDING turn) so this outcome -> behavior mapping is
 * defined in exactly one place, never duplicated.
 */
export async function dispatchSlotOfferOutcome(
  deps: BookingOutcomeDeps,
  outcome: SlotOfferOutcome,
  lead: Lead,
  conversationId: string,
  whatsappUserId: string,
  advisorTimezone: string,
  reason?: "slot_unavailable",
): Promise<void> {
  switch (outcome.type) {
    case "CREATED":
    case "REUSED": {
      const message =
        reason === "slot_unavailable"
          ? buildSlotOfferMessage(outcome.slots, advisorTimezone, SLOT_UNAVAILABLE_INTRO)
          : buildSlotOfferMessage(outcome.slots, advisorTimezone);
      await sendAndPersistReply(deps, lead.id, conversationId, whatsappUserId, message);
      return;
    }
    case "ALREADY_BOOKED": {
      await markLeadBooked(deps, lead, outcome.appointment);
      const when = formatSlotForDisplay(outcome.appointment.startsAt, advisorTimezone);
      await sendAndPersistReply(deps, lead.id, conversationId, whatsappUserId, buildExistingBookingMessage(when, outcome.appointment.meetingUrl));
      return;
    }
    case "NO_AVAILABILITY":
      await sendAndPersistReply(deps, lead.id, conversationId, whatsappUserId, BOOKING_NO_AVAILABILITY_MESSAGE);
      return;
    case "MAX_ROUNDS_REACHED":
      await escalateToHuman(deps, lead, conversationId, whatsappUserId);
      return;
  }
}
