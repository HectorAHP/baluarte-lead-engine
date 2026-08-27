import type { LeadRepository, ConversationRepository, MessagingProvider, MessageRepository, Logger } from "./ports.js";
import type { Lead, LeadStatus } from "../domain/lead.js";
import { assertTransition } from "../domain/state-machine.js";
import { sendAndPersistReply } from "./whatsapp-inbound-service.js";
import type { SlotOfferOutcome } from "./slot-offering-service.js";
import {
  buildSlotOfferMessage, SLOT_UNAVAILABLE_INTRO, buildExistingBookingMessage, formatSlotForDisplay,
  BOOKING_NO_AVAILABILITY_MESSAGE, QUALIFIER_HUMAN_HANDOFF_MESSAGE,
} from "../domain/message-templates.js";

export interface BookingOutcomeDeps {
  leads: LeadRepository;
  conversations: ConversationRepository;
  messaging: MessagingProvider;
  messages: MessageRepository;
  logger: Logger;
}

/**
 * Idempotent: a lead already BOOKED is left untouched (no write, no assertTransition call).
 * Shared by WhatsAppBookingHandler and WhatsAppQualificationHandler -- both can reach an
 * ALREADY_BOOKED SlotOfferOutcome (a defensive, "appointment already exists" branch of
 * SlotOfferingService) and must transition the lead the exact same way.
 */
export async function markLeadBooked(leads: LeadRepository, lead: Lead): Promise<Lead> {
  if (lead.status === "BOOKED") return lead;
  assertTransition(lead.status, "BOOKED");
  return leads.update(lead.id, { status: "BOOKED" });
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
export async function escalateToHuman(deps: BookingOutcomeDeps, lead: Lead, conversationId: string, whatsappUserId: string): Promise<void> {
  const target: LeadStatus = "HUMAN_HANDOFF";
  if (lead.status !== target) {
    assertTransition(lead.status, target);
    await deps.leads.update(lead.id, { status: target });
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
      await markLeadBooked(deps.leads, lead);
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
