import type { Lead } from "../domain/lead.js";
import { isCancellationRequest } from "../domain/cancellation-intent-detection.js";
import { isRescheduleRequest } from "../domain/reschedule-intent-detection.js";
import { isNewBookingRequest } from "../domain/new-booking-intent-detection.js";
import { sendAndPersistReply } from "./whatsapp-inbound-service.js";
import { escalateToHuman, dispatchSlotOfferOutcome, type BookingOutcomeDeps } from "./booking-outcome-dispatch.js";
import type { SlotOfferingService } from "./slot-offering-service.js";
import { ActiveOfferInconsistentError, SlotOfferClaimInProgressError } from "../domain/errors.js";
import {
  PAST_BOOKED_GENERIC_INBOUND_MESSAGE, PAST_BOOKED_RESCHEDULE_TO_NEW_BOOKING_MESSAGE, PAST_BOOKED_CANCELLATION_MESSAGE,
  RESCHEDULE_IN_PROGRESS_MESSAGE, RESCHEDULE_TECHNICAL_ERROR_MESSAGE,
} from "../domain/message-templates.js";
import { config } from "../config.js";

export interface WhatsAppPastBookedRecoveryHandlerDeps extends BookingOutcomeDeps {
  slotOffering: SlotOfferingService;
}

export interface PastBookedRecoveryTurnHandler {
  handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date }): Promise<void>;
}

/**
 * Pre-launch hardening: handles ONE inbound WhatsApp turn for a lead whose `lead.status` is
 * `BOOKED` but whose appointment is stale/past -- `appointment.status` is still `BOOKED`, but
 * `endsAt` has already elapsed (see `isUpcomingBooked`). whatsapp-inbound-service.ts computes
 * this precondition ONCE (an extra `appointments.findActiveByLeadId` read, gated on this
 * handler's own presence) and routes here INSTEAD of the reschedule-intent /
 * cancellation-fallback / generic-BOOKED-fallback branches, which all previously treated ANY
 * `status === "BOOKED"` row as a genuine, current commitment -- exactly the bug this closes.
 *
 * Deliberately does NOT reuse WhatsAppRescheduleHandler or WhatsAppCancellationHandler: there is
 * no genuinely-upcoming appointment to move or cancel, so both "reagendar" and "cancelar" intent
 * are reframed here as either a safe no-op reply (cancellation -- nothing to cancel) or a
 * brand-new booking (reschedule -- nothing left to move, same as
 * WhatsAppReactivationHandler.startNewBooking's reasoning for a CANCELLED lead). NEVER mutates
 * the stale appointment row, NEVER calls Google Calendar, NEVER marks it COMPLETED/NO_SHOW --
 * this project deliberately does not infer a meeting outcome from a mere time comparison (see
 * isUpcomingBooked's doc comment).
 *
 * Architecture: mirrors WhatsAppReactivationHandler almost exactly (same classification order,
 * same startNewBooking mechanism via SlotOfferingService.getOrCreateOffer in booking mode). The
 * key structural difference is state-machine-only: the lead here is still BOOKED (never CANCELLED
 * by anything in this codebase for a stale appointment), so BOOKED -> BOOKING_PENDING is the new
 * edge this flow relies on (see slot-offering-service.ts's OFFERABLE_LEAD_STATUSES doc comment on
 * "BOOKED" for why this can never produce a double future booking: its `activeAppointment` guard
 * is itself isUpcomingBooked-aware).
 *
 * Wired into whatsapp-inbound-service.ts (routed only when lead.status === "BOOKED" AND the
 * lead's current appointment is NOT upcoming) and constructed in app.ts only when
 * WHATSAPP_BOOKING_ENABLED is true -- same reasoning as WhatsAppReactivationHandler: this flow's
 * only real action (starting a new booking) is fundamentally dependent on the booking flow being
 * fully operational end to end.
 */
export class WhatsAppPastBookedRecoveryHandler implements PastBookedRecoveryTurnHandler {
  constructor(
    private readonly deps: WhatsAppPastBookedRecoveryHandlerDeps,
    private readonly advisorTimezone: string = config.ADVISOR_TIMEZONE,
  ) {}

  async handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date }): Promise<void> {
    const { lead, conversationId, whatsappUserId, inboundText, now } = params;

    // Guard: this handler only ever acts on a BOOKED lead. The caller (whatsapp-inbound-service.ts)
    // already confirmed the appointment is not upcoming before dispatching here, but this guard
    // stays anyway, matching every other handler's own no-op-on-mismatch convention.
    if (lead.status !== "BOOKED") return;

    try {
      // Cancellation-intent -- non-destructive, idempotent: nothing exists to cancel. Checked
      // FIRST so it can never be misread as anything else.
      if (isCancellationRequest(inboundText)) {
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, PAST_BOOKED_CANCELLATION_MESSAGE);
        return;
      }

      // "Quiero reagendar" -- there is nothing left to move (the old time already passed), so
      // this is explicitly reframed as a new-booking intent, with an acknowledgment sent before
      // the slot offer so the lead understands why.
      if (isRescheduleRequest(inboundText)) {
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, PAST_BOOKED_RESCHEDULE_TO_NEW_BOOKING_MESSAGE);
        await this.startNewBooking(lead, conversationId, whatsappUserId, now);
        return;
      }

      // Explicit new-booking intent -- start the booking round directly, no extra acknowledgment
      // needed (the intent is already unambiguous).
      if (isNewBookingRequest(inboundText)) {
        await this.startNewBooking(lead, conversationId, whatsappUserId, now);
        return;
      }

      // Generic inbound, no clear intent -- informative fallback only, no state change, no offer.
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, PAST_BOOKED_GENERIC_INBOUND_MESSAGE);
    } catch (err) {
      await this.handleError(err, lead, conversationId, whatsappUserId);
    }
  }

  /** Reuses SlotOfferingService's BOOKED -> BOOKING_PENDING transition + audit event (see the
   * class doc comment above) -- no bespoke transition-writing logic here. mode is omitted
   * (booking mode, the default): the new offered_slots round gets reschedule_context_id IS NULL,
   * a genuinely independent new booking, never counted against any prior round budget. The stale
   * appointment row is never referenced, restored, or touched by any of this. */
  private async startNewBooking(lead: Lead, conversationId: string, whatsappUserId: string, now: Date): Promise<void> {
    const outcome = await this.deps.slotOffering.getOrCreateOffer({ lead, conversationId, now });
    await dispatchSlotOfferOutcome(this.deps, outcome, lead, conversationId, whatsappUserId, this.advisorTimezone);
  }

  /**
   * Two categories, same discipline as WhatsAppReactivationHandler.handleError:
   *  - ActiveOfferInconsistentError: genuine data-consistency violation -- conservative
   *    HUMAN_HANDOFF, never a silent retry.
   *  - Anything else (SlotOfferClaimInProgressError, CalendarProviderError, transient DB
   *    failures, ...): recoverable technical condition -- message only, no state change.
   */
  private async handleError(err: unknown, lead: Lead, conversationId: string, whatsappUserId: string): Promise<void> {
    if (err instanceof ActiveOfferInconsistentError) {
      this.deps.logger.warn(
        { leadId: lead.id, conversationId, errorName: err.name },
        "Past-booked-recovery slot-offer data-consistency error -- escalating to human handoff instead of retrying automatically.",
      );
      await escalateToHuman(this.deps, lead, conversationId, whatsappUserId, "PAST_BOOKED_RECOVERY_OFFER_INCONSISTENCY");
      return;
    }
    if (err instanceof SlotOfferClaimInProgressError) {
      this.deps.logger.warn(
        { leadId: lead.id, conversationId, errorName: err.name },
        "Slot-offering claim in progress (concurrent request) while recovering a past-booked lead -- asking the lead to retry shortly, no state change.",
      );
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, RESCHEDULE_IN_PROGRESS_MESSAGE);
      return;
    }
    this.deps.logger.warn(
      { leadId: lead.id, conversationId, errorName: err instanceof Error ? err.name : "unknown" },
      "Recoverable technical error while recovering a past-booked lead; no state change.",
    );
    await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, RESCHEDULE_TECHNICAL_ERROR_MESSAGE);
  }
}
