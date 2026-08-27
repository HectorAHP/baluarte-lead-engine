import type {
  LeadRepository, ConversationRepository, MessageRepository, OfferedSlotRepository,
  AppointmentRepository, MessagingProvider, Logger,
} from "./ports.js";
import type { Lead } from "../domain/lead.js";
import type { Appointment } from "../domain/appointment.js";
import type { OfferedSlot } from "../domain/offered-slot.js";
import {
  BookingInProgressError, SlotUnavailableError, ActiveOfferInconsistentError, BookingAttemptInconsistentError,
  SlotOfferClaimInProgressError,
} from "../domain/errors.js";
import { sendAndPersistReply, type BookingTurnHandler } from "./whatsapp-inbound-service.js";
import type { SlotOfferingService } from "./slot-offering-service.js";
import type { AppointmentService } from "./services.js";
import { parseSlotSelection } from "../domain/slot-selection-parser.js";
import { markLeadBooked, escalateToHuman, dispatchSlotOfferOutcome } from "./booking-outcome-dispatch.js";
import {
  buildInvalidSelectionMessage, buildBookingConfirmedMessage, buildExistingBookingMessage,
  BOOKING_IN_PROGRESS_MESSAGE, BOOKING_TECHNICAL_ERROR_MESSAGE, SLOT_OFFER_CLAIM_IN_PROGRESS_MESSAGE,
  formatSlotForDisplay,
} from "../domain/message-templates.js";
import { config } from "../config.js";

export interface WhatsAppBookingHandlerDeps {
  leads: LeadRepository;
  conversations: ConversationRepository;
  appointments: AppointmentRepository;
  offeredSlots: OfferedSlotRepository;
  slotOffering: SlotOfferingService;
  appointmentService: AppointmentService;
  messaging: MessagingProvider;
  messages: MessageRepository;
  logger: Logger;
}

/**
 * Handles ONE inbound WhatsApp turn for a lead that is (or should be) in BOOKING_PENDING.
 * Reuses sendAndPersistReply for all outbound transport/persistence, and
 * booking-outcome-dispatch.ts's markLeadBooked/escalateToHuman/dispatchSlotOfferOutcome for
 * everything WhatsAppQualificationHandler also needs -- no send/dedup/outcome-mapping logic is
 * reimplemented here. Deliberately depends on LeadRepository/AppointmentRepository directly (not
 * LeadService), matching the pattern SlotOfferingService already established for this layer.
 *
 * Wired into whatsapp-inbound-service.ts (routed only when lead.status === "BOOKING_PENDING")
 * and constructed in app.ts only when WHATSAPP_BOOKING_ENABLED is true.
 */
export class WhatsAppBookingHandler implements BookingTurnHandler {
  constructor(
    private readonly deps: WhatsAppBookingHandlerDeps,
    private readonly advisorTimezone: string = config.ADVISOR_TIMEZONE,
  ) {}

  async handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date }): Promise<void> {
    const { lead, conversationId, whatsappUserId, inboundText, now } = params;

    // Guard: this handler only ever acts on a lead currently in BOOKING_PENDING. Anything else
    // (still QUALIFIED_A/B, already BOOKED, HUMAN_HANDOFF, ...) is a no-op -- no Calendar call,
    // no message, no state change of any kind.
    if (lead.status !== "BOOKING_PENDING") return;

    try {
      await this.handleTurnInner(lead, conversationId, whatsappUserId, inboundText, now);
    } catch (err) {
      await this.handleError(err, lead, conversationId, whatsappUserId);
    }
  }

  private async handleTurnInner(lead: Lead, conversationId: string, whatsappUserId: string, inboundText: string, now: Date): Promise<void> {
    // Appointment guard, ahead of everything else: a BOOKED appointment for this lead already
    // existing (from this turn's own earlier attempt, or any other path) always wins -- never
    // re-run Calendar/booking logic once a real appointment exists.
    const existingAppointment = await this.deps.appointments.findActiveByLeadId(lead.id);
    if (existingAppointment) {
      await markLeadBooked(this.deps.leads, lead, existingAppointment);
      await this.replyExistingBooking(lead.id, conversationId, whatsappUserId, existingAppointment);
      return;
    }

    const activeSlots = await this.deps.offeredSlots.listActiveByConversationId(conversationId, now);

    if (activeSlots.length === 0) {
      // Nothing to interpret the inbound text against yet -- get (or create) an offer first.
      // Never attempts to parse inboundText as a selection when there was no active offer to
      // select from.
      const outcome = await this.deps.slotOffering.getOrCreateOffer({ lead, conversationId, now });
      await dispatchSlotOfferOutcome(this.deps, outcome, lead, conversationId, whatsappUserId, this.advisorTimezone);
      return;
    }

    const selection = parseSlotSelection(inboundText, activeSlots, now);

    if (selection.type === "INVALID") {
      // Reuses the SAME active offered_slots already loaded above -- never a new round, never a
      // new Calendar call, just the same options restated.
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildInvalidSelectionMessage(activeSlots, this.advisorTimezone));
      return;
    }

    if (selection.type === "DECLINED") {
      const replacement = await this.deps.slotOffering.replaceOffer({ lead, conversationId, now });
      await dispatchSlotOfferOutcome(this.deps, replacement, lead, conversationId, whatsappUserId, this.advisorTimezone);
      return;
    }

    await this.handleSelection(selection.slot, activeSlots, lead, conversationId, whatsappUserId, now);
  }

  private async handleSelection(
    slot: OfferedSlot,
    activeSlots: OfferedSlot[],
    lead: Lead,
    conversationId: string,
    whatsappUserId: string,
    now: Date,
  ): Promise<void> {
    // A. Revalidate. parseSlotSelection already guarantees this for any SELECTED result (see its
    // own tests) -- this can never actually trigger through the normal flow. Kept as a cheap,
    // explicit second check per the Phase 3C spec, and as insurance against a future change to
    // the parser silently loosening that guarantee.
    if (slot.selected || !(slot.expiresAt > now)) {
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildInvalidSelectionMessage(activeSlots, this.advisorTimezone));
      return;
    }

    // B. Appointment guard, once more, immediately before booking.
    const existingAppointment = await this.deps.appointments.findActiveByLeadId(lead.id);
    if (existingAppointment) {
      await markLeadBooked(this.deps.leads, lead, existingAppointment);
      await this.replyExistingBooking(lead.id, conversationId, whatsappUserId, existingAppointment);
      return;
    }

    // C. Deterministic idempotency key: same lead + same offered slot always maps to the same
    // key, so a reprocessed/duplicate inbound for the same selection can never create a second
    // appointment or a second Google event -- AppointmentService.book() itself owns that
    // guarantee end-to-end (see the booking-ownership design).
    const idempotencyKey = `whatsapp-booking:${lead.id}:${slot.id}`;

    let appointment: Appointment;
    try {
      // D. Reuses BookInput's real shape -- no invented fields. attendeeEmail is lead.email
      // as-is (string | undefined): BookInput.attendeeEmail is optional, Google Calendar's
      // createEvent omits the `attendees` array entirely when it's undefined and still creates
      // the event with its Meet link (see GoogleCalendarProvider.createEvent) -- a lead with no
      // email on file can still be booked by WhatsApp; no placeholder/invented email is ever
      // substituted.
      appointment = await this.deps.appointmentService.book(
        {
          leadId: lead.id,
          title: `Cita con Héctor Herrera${lead.firstName ? ` - ${lead.firstName}` : ""}`,
          description: "Cita agendada automáticamente vía WhatsApp (Baluarte Capital).",
          start: slot.slotStart,
          end: slot.slotEnd,
          attendeeEmail: lead.email,
          timezone: this.advisorTimezone,
        },
        idempotencyKey,
      );
    } catch (err) {
      if (err instanceof BookingInProgressError) {
        // Someone else (a concurrent/duplicate turn) already owns this exact booking attempt --
        // create nothing, replace nothing, mark nothing selected. Just ask the lead to wait.
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, BOOKING_IN_PROGRESS_MESSAGE);
        return;
      }
      if (err instanceof SlotUnavailableError) {
        // The slot was taken between offer and selection. Never mark it selected. Exactly one
        // replaceOffer call for this inbound -- no automatic retry loop.
        const replacement = await this.deps.slotOffering.replaceOffer({ lead, conversationId, now });
        await dispatchSlotOfferOutcome(this.deps, replacement, lead, conversationId, whatsappUserId, this.advisorTimezone, "slot_unavailable");
        return;
      }
      throw err; // CalendarProviderError / any other technical failure -- handled generically by handleError.
    }

    // Success. Idempotent by construction: whether book() just created this appointment or
    // returned an existing one for the same idempotency key (a reprocessed inbound), the steps
    // below are identical and safe to repeat -- update(selected:true) is a plain overwrite (not
    // an increment/toggle), and markLeadBooked no-ops once the lead is already BOOKED.
    await this.deps.offeredSlots.update(slot.id, { selected: true });
    await markLeadBooked(this.deps.leads, lead, appointment);
    await this.replyBookingConfirmed(lead.id, conversationId, whatsappUserId, appointment);
  }

  /**
   * Errors that reach here always came from inside handleTurnInner's try block: SlotOfferingService
   * (getOrCreateOffer/replaceOffer), the parser's assertSingleActiveRound check, or a technical
   * failure re-thrown from handleSelection's book() call. BookingInProgressError and
   * SlotUnavailableError are already handled at their specific call site and never reach here.
   *
   * Three DISTINCT categories, deliberately never conflated:
   *
   *  - SlotOfferClaimInProgressError: a concurrency signal, not a problem -- another concurrent
   *    request is (or was, moments ago) legitimately creating this conversation's offer.
   *    No HUMAN_HANDOFF, no replaceOffer, no new round, no appointment -- the lead simply stays
   *    BOOKING_PENDING and is asked to retry in a few seconds, exactly once.
   *
   *  - ActiveOfferInconsistentError / BookingAttemptInconsistentError: genuine data-consistency
   *    violations -- conservative HUMAN_HANDOFF, never a silent retry. Logged with a sanitized
   *    reason string only (error name, leadId, conversationId) -- never the raw error message or
   *    any slot/appointment payload.
   *
   *  - Anything else (CalendarProviderError, transient DB failures, ...): a recoverable technical
   *    error -- message only, no state change, lead stays BOOKING_PENDING.
   */
  private async handleError(err: unknown, lead: Lead, conversationId: string, whatsappUserId: string): Promise<void> {
    if (err instanceof SlotOfferClaimInProgressError) {
      this.deps.logger.warn(
        { leadId: lead.id, conversationId, errorName: err.name },
        "Slot-offering claim in progress (concurrent request) -- asking the lead to retry shortly, no state change.",
      );
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, SLOT_OFFER_CLAIM_IN_PROGRESS_MESSAGE);
      return;
    }
    if (err instanceof ActiveOfferInconsistentError || err instanceof BookingAttemptInconsistentError) {
      this.deps.logger.warn(
        { leadId: lead.id, conversationId, errorName: err.name },
        "Booking data-consistency error -- escalating to human handoff instead of retrying automatically.",
      );
      await escalateToHuman(this.deps, lead, conversationId, whatsappUserId);
      return;
    }
    this.deps.logger.warn(
      { leadId: lead.id, conversationId, errorName: err instanceof Error ? err.name : "unknown" },
      "Recoverable technical error while offering/booking a slot; the lead remains BOOKING_PENDING.",
    );
    await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, BOOKING_TECHNICAL_ERROR_MESSAGE);
  }

  private async replyExistingBooking(leadId: string, conversationId: string, whatsappUserId: string, appointment: Appointment): Promise<void> {
    const when = formatSlotForDisplay(appointment.startsAt, this.advisorTimezone);
    await sendAndPersistReply(this.deps, leadId, conversationId, whatsappUserId, buildExistingBookingMessage(when, appointment.meetingUrl));
  }

  private async replyBookingConfirmed(leadId: string, conversationId: string, whatsappUserId: string, appointment: Appointment): Promise<void> {
    const when = formatSlotForDisplay(appointment.startsAt, this.advisorTimezone);
    await sendAndPersistReply(this.deps, leadId, conversationId, whatsappUserId, buildBookingConfirmedMessage(when, appointment.meetingUrl));
  }
}
