import type {
  LeadRepository, ConversationRepository, MessageRepository, OfferedSlotRepository,
  AppointmentRepository, MessagingProvider, LeadStatusHistoryRepository, Logger,
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
import { targetStatusForScore, type AppointmentService } from "./services.js";
import { parseSlotSelection } from "../domain/slot-selection-parser.js";
import { markLeadBooked, escalateToHuman, dispatchSlotOfferOutcome } from "./booking-outcome-dispatch.js";
import { isBookingAbandonRequest } from "../domain/booking-abandon-intent-detection.js";
import { isNewBookingRequest } from "../domain/new-booking-intent-detection.js";
import { isUpcomingBooked } from "../domain/appointment-timing.js";
import { conversationalFirstName } from "../domain/conversation-name.js";
import { assertTransition } from "../domain/state-machine.js";
import { recordLeadStatusTransition } from "./lead-status-audit.js";
import {
  buildInvalidSelectionMessage, buildBookingConfirmedMessage, buildExistingBookingMessage,
  buildBookingPendingFallbackMessage, BOOKING_ABANDONED_MESSAGE,
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
  leadStatusHistory: LeadStatusHistoryRepository;
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

  /**
   * Returns whether this call actually acted on the turn (and therefore already sent exactly one
   * reply) -- `true` for BOOKING_PENDING (handleTurnInner/handleError always reply on every
   * internal branch) and for a QUALIFIED_A/QUALIFIED_B/NURTURE_C lead with genuine new-booking
   * intent (startNewBooking/handleError, same guarantee); `false` for anything else, i.e. a pure
   * no-op. Pre-launch hardening (qualified-lead generic fallback): the caller
   * (whatsapp-inbound-service.ts) uses this to know whether it must still send its own fallback
   * reply for a QUALIFIED_A/QUALIFIED_B/NURTURE_C lead's non-booking text, WITHOUT this handler
   * itself becoming a generic conversational handler -- it still only ever knows about booking.
   */
  async handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date; bookingIntentOverride?: boolean }): Promise<boolean> {
    const { lead, conversationId, whatsappUserId, inboundText, now, bookingIntentOverride } = params;

    if (lead.status === "BOOKING_PENDING") {
      try {
        await this.handleTurnInner(lead, conversationId, whatsappUserId, inboundText, now);
      } catch (err) {
        await this.handleError(err, lead, conversationId, whatsappUserId);
      }
      return true;
    }

    // Pre-launch hardening: a QUALIFIED_A/QUALIFIED_B/NURTURE_C lead explicitly asking to book
    // (most commonly right after abandoning a prior BOOKING_PENDING round -- see
    // abandonBookingPending below) starts/reuses an offer. Anything else from these statuses is a
    // no-op (signaled via the `false` return below) -- the caller decides what, if anything, to
    // do about a no-op; this only ADDS the explicit new-booking-intent capability, never broadens
    // what else this handler itself replies to. whatsapp-inbound-service.ts dispatches to this
    // handler unconditionally on status alone for these three (mirroring the CANCELLED ->
    // WhatsAppReactivationHandler precedent), so the intent check lives here, not duplicated at
    // the routing layer.
    //
    // Fase 6D: `bookingIntentOverride` (see BookingTurnHandler's doc comment) covers what
    // isNewBookingRequest's narrow phrase list structurally cannot -- e.g. a bare "3" against the
    // qualified-lead menu -- without loosening isNewBookingRequest itself (still exactly as
    // narrow/deterministic as before, unaffected for every OTHER caller/context).
    if ((lead.status === "QUALIFIED_A" || lead.status === "QUALIFIED_B" || lead.status === "NURTURE_C") && (isNewBookingRequest(inboundText) || bookingIntentOverride)) {
      try {
        await this.startNewBooking(lead, conversationId, whatsappUserId, now);
      } catch (err) {
        await this.handleError(err, lead, conversationId, whatsappUserId);
      }
      return true;
    }

    return false;
  }

  /** Reuses SlotOfferingService's existing QUALIFIED_A/B/NURTURE_C -> BOOKING_PENDING transition
   * (booking mode, the default -- no `mode` param) -- no bespoke transition-writing logic here,
   * same pattern as WhatsAppReactivationHandler.startNewBooking. If an active round from before an
   * abandon is still live (within its TTL), getOrCreateOffer reuses it as-is (item C.4 of the
   * pre-launch spec: "reofrecer/reutilizar ronda vigente si corresponde") -- otherwise a fresh one
   * is created, subject to the same MAX_OFFER_ROUNDS budget as any other booking round. */
  private async startNewBooking(lead: Lead, conversationId: string, whatsappUserId: string, now: Date): Promise<void> {
    const outcome = await this.deps.slotOffering.getOrCreateOffer({ lead, conversationId, now });
    await dispatchSlotOfferOutcome(this.deps, outcome, lead, conversationId, whatsappUserId, this.advisorTimezone);
  }

  private async handleTurnInner(lead: Lead, conversationId: string, whatsappUserId: string, inboundText: string, now: Date): Promise<void> {
    // Appointment guard, ahead of everything else: a genuinely UPCOMING BOOKED appointment for
    // this lead already existing (from this turn's own earlier attempt, or any other path)
    // always wins -- never re-run Calendar/booking logic once a real appointment exists. A stale
    // PAST BOOKED row (see isUpcomingBooked) is deliberately never treated as blocking here: a
    // lead can only reach BOOKING_PENDING with such a row still lying around via
    // WhatsAppPastBookedRecoveryHandler.startNewBooking, which exists specifically so a past
    // appointment never permanently traps a lead into a false "already booked" reply.
    const existingAppointment = await this.deps.appointments.findActiveByLeadId(lead.id);
    if (existingAppointment && isUpcomingBooked(existingAppointment, now)) {
      await markLeadBooked(this.deps, lead, existingAppointment);
      await this.replyExistingBooking(lead, conversationId, whatsappUserId, existingAppointment);
      return;
    }

    // Pre-launch hardening (item C.2): "cancelar"/"ya no"/"salir" while BOOKING_PENDING -- checked
    // BEFORE ever attempting to parse the text as a slot selection, same precedence discipline as
    // WhatsAppRescheduleHandler checking cancellation-intent before parseSlotSelection. No
    // appointment exists at this point (the guard immediately above already returned if one did),
    // so this can never be mistaken for an appointment cancellation.
    if (isBookingAbandonRequest(inboundText)) {
      await this.abandonBookingPending(lead, conversationId, whatsappUserId);
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
      // Pre-launch hardening (item C.3): a general question ("¿Cuáles son los servicios?") or any
      // other unrecognized text no longer gets the terse "Por favor responde 1, 2 o 3" reminder --
      // buildBookingPendingFallbackMessage restates the SAME active options (so item C.4's
      // "reofrecer ronda vigente" still holds for a vague retry) but frames it informatively and
      // names the abandon escape hatch, instead of only ever repeating the same instruction.
      // Reuses the SAME active offered_slots already loaded above -- never a new round, never a
      // new Calendar call.
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildBookingPendingFallbackMessage(activeSlots, this.advisorTimezone));
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

    // B. Appointment guard, once more, immediately before booking -- same isUpcomingBooked
    // reasoning as handleTurnInner's guard above (a stale PAST row never blocks this).
    const existingAppointment = await this.deps.appointments.findActiveByLeadId(lead.id);
    if (existingAppointment && isUpcomingBooked(existingAppointment, now)) {
      await markLeadBooked(this.deps, lead, existingAppointment);
      await this.replyExistingBooking(lead, conversationId, whatsappUserId, existingAppointment);
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
    await markLeadBooked(this.deps, lead, appointment);
    await this.replyBookingConfirmed(lead, conversationId, whatsappUserId, appointment);
  }

  /**
   * Item C.2 (pre-launch hardening): "cancelar"/"ya no"/"salir" during BOOKING_PENDING means
   * abandon the booking PROCESS, never cancel an appointment -- no appointment exists yet at this
   * point (handleTurnInner's existingAppointment guard already returned if one did). Returns the
   * lead to its TRUE prior qualified tier via targetStatusForScore(lead.scoreClass) -- the EXACT
   * SAME mapping LeadService uses to land a freshly-scored lead on QUALIFIED_A/QUALIFIED_B/
   * NURTURE_C -- rather than collapsing every tier into NURTURE_C. product/score/scoreClass/
   * qualification_answers/lead_scores/qualifiedAt are all untouched: this method writes only
   * leads.status.
   *
   * Re-fetches the lead's current status before writing -- same stale-snapshot discipline as
   * WhatsAppRescheduleHandler's ensureLeadBookedAfterReschedule/handOffToCancellation: if a
   * concurrent turn already moved the lead elsewhere (e.g. a race just booked it), this leaves it
   * alone rather than writing a misleading transition on top of what already happened.
   */
  private async abandonBookingPending(lead: Lead, conversationId: string, whatsappUserId: string): Promise<void> {
    const current = (await this.deps.leads.findById(lead.id)) ?? lead;
    if (current.status !== "BOOKING_PENDING") {
      this.deps.logger.warn(
        { leadId: lead.id, expectedStatus: "BOOKING_PENDING", actualStatus: current.status },
        "Booking-abandon intent arrived for a lead no longer BOOKING_PENDING (a concurrent turn already resolved it) -- left unactioned.",
      );
      return;
    }
    const target = targetStatusForScore(current.scoreClass ?? "C");
    assertTransition(current.status, target);
    await this.deps.leads.update(lead.id, { status: target });
    await recordLeadStatusTransition(this.deps.leadStatusHistory, this.deps.logger, {
      leadId: lead.id,
      fromStatus: current.status,
      toStatus: target,
      eventType: "BOOKING_ABANDONED",
    });
    await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, BOOKING_ABANDONED_MESSAGE);
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

  private async replyExistingBooking(lead: Lead, conversationId: string, whatsappUserId: string, appointment: Appointment): Promise<void> {
    const when = formatSlotForDisplay(appointment.startsAt, this.advisorTimezone);
    await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildExistingBookingMessage(when, appointment.meetingUrl, conversationalFirstName(lead)));
  }

  private async replyBookingConfirmed(lead: Lead, conversationId: string, whatsappUserId: string, appointment: Appointment): Promise<void> {
    const when = formatSlotForDisplay(appointment.startsAt, this.advisorTimezone);
    await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildBookingConfirmedMessage(when, appointment.meetingUrl, conversationalFirstName(lead)));
  }
}
