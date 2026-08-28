import type { Lead } from "../domain/lead.js";
import { isCancellationRequest } from "../domain/cancellation-intent-detection.js";
import { isRescheduleRequest } from "../domain/reschedule-intent-detection.js";
import { isNewBookingRequest } from "../domain/new-booking-intent-detection.js";
import { sendAndPersistReply } from "./whatsapp-inbound-service.js";
import { escalateToHuman, dispatchSlotOfferOutcome, type BookingOutcomeDeps } from "./booking-outcome-dispatch.js";
import type { SlotOfferingService } from "./slot-offering-service.js";
import { ActiveOfferInconsistentError, SlotOfferClaimInProgressError } from "../domain/errors.js";
import {
  CANCELLED_GENERIC_INBOUND_MESSAGE, CANCELLED_RESCHEDULE_TO_NEW_BOOKING_MESSAGE, CANCELLED_ALREADY_MESSAGE,
  RESCHEDULE_IN_PROGRESS_MESSAGE, RESCHEDULE_TECHNICAL_ERROR_MESSAGE,
} from "../domain/message-templates.js";
import { config } from "../config.js";

export interface WhatsAppReactivationHandlerDeps extends BookingOutcomeDeps {
  slotOffering: SlotOfferingService;
}

export interface ReactivationTurnHandler {
  handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date }): Promise<void>;
}

/**
 * Handles ONE inbound WhatsApp turn for a lead that is CANCELLED -- item 2/3/4 of the pre-launch
 * hardening spec ("reactivate cancelled leads"). Deliberately does NOT reuse
 * WhatsAppRescheduleHandler: a CANCELLED lead has no active appointment to move, so "reagendar"
 * intent is reframed here as a brand-new booking, never a reschedule (see
 * CANCELLED_RESCHEDULE_TO_NEW_BOOKING_MESSAGE).
 *
 * Architecture: this handler owns ONLY intent classification and kicking off the offer --
 * starting a booking round for a CANCELLED lead is the EXACT SAME mechanism SlotOfferingService
 * already uses for a QUALIFIED_A/B lead (CANCELLED was added to OFFERABLE_LEAD_STATUSES / the
 * transition it performs is the pre-existing CANCELLED -> BOOKING_PENDING state-machine edge from
 * Phase 4A, reusing the existing BOOKING_OFFER_STARTED audit event -- no new state, no new event
 * vocabulary). Once the lead reaches BOOKING_PENDING, the SELECTION turn is already fully owned,
 * unmodified, by the existing WhatsAppBookingHandler/AppointmentService.book() -- this handler
 * never touches appointment creation, Calendar, or booking_attempts directly. The old (CANCELLED)
 * appointment is never referenced, restored, or CAS'd by any of this -- AppointmentService.book()
 * creates a wholly independent new appointment with no rescheduledFrom, exactly like a lead's very
 * first booking.
 *
 * Wired into whatsapp-inbound-service.ts (routed only for lead.status === "CANCELLED") and
 * constructed in app.ts only when WHATSAPP_BOOKING_ENABLED is true -- the reactivation flow is
 * fundamentally dependent on the booking flow being fully operational end to end (the SELECTION
 * turn requires bookingHandler to be wired), so reusing that flag (rather than inventing a new
 * one) is the only configuration that can never leave a lead offered slots with no way to select
 * one.
 */
export class WhatsAppReactivationHandler implements ReactivationTurnHandler {
  constructor(
    private readonly deps: WhatsAppReactivationHandlerDeps,
    private readonly advisorTimezone: string = config.ADVISOR_TIMEZONE,
  ) {}

  async handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date }): Promise<void> {
    const { lead, conversationId, whatsappUserId, inboundText, now } = params;

    // Guard: this handler only ever acts on a CANCELLED lead. Anything else is a no-op -- no
    // Calendar call, no message, no state change of any kind.
    if (lead.status !== "CANCELLED") return;

    try {
      // Item 4: "quiero cancelar" from a CANCELLED lead -- non-destructive, idempotent, no state
      // change, no Calendar call. Checked FIRST so it can never be misread as anything else.
      if (isCancellationRequest(inboundText)) {
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, CANCELLED_ALREADY_MESSAGE);
        return;
      }

      // Item 3: "quiero reagendar" -- there is no active appointment to move, so this is
      // explicitly reframed as a new-booking intent (never WhatsAppRescheduleHandler), with an
      // acknowledgment sent before the slot offer so the lead understands why.
      if (isRescheduleRequest(inboundText)) {
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, CANCELLED_RESCHEDULE_TO_NEW_BOOKING_MESSAGE);
        await this.startNewBooking(lead, conversationId, whatsappUserId, now);
        return;
      }

      // Item 2: explicit new-booking intent -- start the booking round directly, no extra
      // acknowledgment needed (the intent is already unambiguous).
      if (isNewBookingRequest(inboundText)) {
        await this.startNewBooking(lead, conversationId, whatsappUserId, now);
        return;
      }

      // Item 1: generic inbound, no clear intent -- reactivation fallback only, no state change,
      // no offer.
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, CANCELLED_GENERIC_INBOUND_MESSAGE);
    } catch (err) {
      await this.handleError(err, lead, conversationId, whatsappUserId);
    }
  }

  /** Reuses SlotOfferingService's existing CANCELLED -> BOOKING_PENDING transition + audit event
   * (see the class doc comment) -- no bespoke transition-writing logic here. mode is omitted
   * (booking mode, the default): every new offered_slots row gets reschedule_context_id IS NULL,
   * never treated as -- or counted against -- any reschedule episode's round budget. */
  private async startNewBooking(lead: Lead, conversationId: string, whatsappUserId: string, now: Date): Promise<void> {
    const outcome = await this.deps.slotOffering.getOrCreateOffer({ lead, conversationId, now });
    await dispatchSlotOfferOutcome(this.deps, outcome, lead, conversationId, whatsappUserId, this.advisorTimezone);
  }

  /**
   * Two categories:
   *  - ActiveOfferInconsistentError: genuine data-consistency violation -- conservative
   *    HUMAN_HANDOFF, never a silent retry.
   *  - Anything else (SlotOfferClaimInProgressError, CalendarProviderError, transient DB
   *    failures, ...): recoverable technical condition -- message only, no state change.
   */
  private async handleError(err: unknown, lead: Lead, conversationId: string, whatsappUserId: string): Promise<void> {
    if (err instanceof ActiveOfferInconsistentError) {
      this.deps.logger.warn(
        { leadId: lead.id, conversationId, errorName: err.name },
        "Reactivation slot-offer data-consistency error -- escalating to human handoff instead of retrying automatically.",
      );
      await escalateToHuman(this.deps, lead, conversationId, whatsappUserId, "REACTIVATION_OFFER_INCONSISTENCY");
      return;
    }
    if (err instanceof SlotOfferClaimInProgressError) {
      this.deps.logger.warn(
        { leadId: lead.id, conversationId, errorName: err.name },
        "Slot-offering claim in progress (concurrent request) while reactivating a cancelled lead -- asking the lead to retry shortly, no state change.",
      );
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, RESCHEDULE_IN_PROGRESS_MESSAGE);
      return;
    }
    this.deps.logger.warn(
      { leadId: lead.id, conversationId, errorName: err instanceof Error ? err.name : "unknown" },
      "Recoverable technical error while reactivating a cancelled lead; no state change.",
    );
    await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, RESCHEDULE_TECHNICAL_ERROR_MESSAGE);
  }
}
