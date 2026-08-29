import type { AppointmentRepository, OfferedSlotRepository, Logger } from "./ports.js";
import type { Lead } from "../domain/lead.js";
import type { Appointment } from "../domain/appointment.js";
import type { OfferedSlot } from "../domain/offered-slot.js";
import { assertTransition } from "../domain/state-machine.js";
import {
  AppointmentRescheduleInconsistentError, RescheduleInProgressError,
  ActiveOfferInconsistentError, SlotOfferClaimInProgressError,
} from "../domain/errors.js";
import { isCancellationRequest } from "../domain/cancellation-intent-detection.js";
import { recordLeadStatusTransition } from "./lead-status-audit.js";
import { sendAndPersistReply } from "./whatsapp-inbound-service.js";
import { escalateToHuman, dispatchSlotOfferOutcome, type BookingOutcomeDeps } from "./booking-outcome-dispatch.js";
import type { SlotOfferingService } from "./slot-offering-service.js";
import type { AppointmentRescheduleService } from "./appointment-reschedule-service.js";
import { parseSlotSelection } from "../domain/slot-selection-parser.js";
import {
  RESCHEDULE_INTRO_MESSAGE, buildRescheduleConfirmedMessage, RESCHEDULE_TECHNICAL_ERROR_MESSAGE,
  RESCHEDULE_IN_PROGRESS_MESSAGE, buildInvalidSelectionMessage, buildReschedulePendingFallbackMessage,
  buildCancelConfirmationPromptMessage, formatSlotForDisplay,
} from "../domain/message-templates.js";
import { config } from "../config.js";

export interface WhatsAppRescheduleHandlerDeps extends BookingOutcomeDeps {
  appointments: AppointmentRepository;
  offeredSlots: OfferedSlotRepository;
  slotOffering: SlotOfferingService;
  rescheduleService: AppointmentRescheduleService;
}

export interface RescheduleTurnHandler {
  handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date }): Promise<void>;
}

/**
 * Handles ONE inbound WhatsApp turn for a lead that is BOOKED (reschedule-intent already
 * confirmed by whatsapp-inbound-service.ts's precedence check, BEFORE cancellation-intent -- see
 * that file) or RESCHEDULE_REQUESTED (picking a new slot, or -- item 13 of the Phase 4C spec --
 * asking to cancel instead). Reuses sendAndPersistReply, booking-outcome-dispatch.ts's
 * escalateToHuman/dispatchSlotOfferOutcome, and SlotOfferingService's "RESCHEDULE" mode -- no
 * send/dedup/outcome-mapping/claim-concurrency logic reimplemented here, same pattern as
 * WhatsAppBookingHandler/WhatsAppCancellationHandler.
 *
 * The source of truth for "which appointment" is always AppointmentRepository -- never inferred
 * from message history (same discipline as WhatsAppCancellationHandler).
 *
 * Item 13 (cancellation during reschedule): rather than a second, parallel cancel UX, this
 * handler transitions RESCHEDULE_REQUESTED -> CANCEL_PENDING and sends the EXACT SAME
 * confirmation prompt WhatsAppCancellationHandler sends from BOOKED -- the next turn is then
 * routed to WhatsAppCancellationHandler as normal (CANCEL_PENDING is already in its routing
 * condition), reusing its entire confirm/decline machinery unmodified.
 *
 * Wired into whatsapp-inbound-service.ts (routed for BOOKED-with-reschedule-intent and
 * RESCHEDULE_REQUESTED) and constructed in app.ts only when WHATSAPP_RESCHEDULE_ENABLED is true.
 */
export class WhatsAppRescheduleHandler implements RescheduleTurnHandler {
  constructor(
    private readonly deps: WhatsAppRescheduleHandlerDeps,
    private readonly advisorTimezone: string = config.ADVISOR_TIMEZONE,
  ) {}

  async handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date }): Promise<void> {
    const { lead, conversationId, whatsappUserId, inboundText, now } = params;

    // Guard: this handler only ever acts on BOOKED (reschedule-intent already confirmed by the
    // caller) or RESCHEDULE_REQUESTED. Anything else is a no-op.
    if (lead.status !== "BOOKED" && lead.status !== "RESCHEDULE_REQUESTED") return;

    try {
      if (lead.status === "BOOKED") {
        await this.handleIntentTurn(lead, conversationId, whatsappUserId, now);
      } else {
        await this.handleRescheduleRequestedTurn(lead, conversationId, whatsappUserId, inboundText, now);
      }
    } catch (err) {
      await this.handleError(err, lead, conversationId, whatsappUserId);
    }
  }

  /**
   * BOOKED: whatsapp-inbound-service.ts already decided this turn is reschedule-intent before
   * dispatching here (the single, top-level precedence decision between reschedule-intent and
   * cancellation-intent for a BOOKED lead's free text lives there, not duplicated per-handler --
   * see that file's routing comment). This method's job is purely: find the target appointment,
   * transition the lead, and kick off slot offering in RESCHEDULE mode.
   */
  private async handleIntentTurn(lead: Lead, conversationId: string, whatsappUserId: string, now: Date): Promise<void> {
    const oldAppointment = await this.findTargetAppointment(lead.id);
    if (oldAppointment === "INCONSISTENT") throw new AppointmentRescheduleInconsistentError(lead.id, "MULTIPLE_APPOINTMENTS");
    if (!oldAppointment) throw new AppointmentRescheduleInconsistentError(lead.id, "NO_APPOINTMENT");

    const updatedLead = await this.transitionLead(lead, "RESCHEDULE_REQUESTED", "RESCHEDULE_REQUESTED");
    await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, RESCHEDULE_INTRO_MESSAGE);

    const outcome = await this.deps.slotOffering.getOrCreateOffer({ lead: updatedLead, conversationId, now, mode: { type: "RESCHEDULE", oldAppointmentId: oldAppointment.id } });
    await dispatchSlotOfferOutcome(this.deps, outcome, updatedLead, conversationId, whatsappUserId, this.advisorTimezone);
  }

  /** RESCHEDULE_REQUESTED: cancellation-intent is checked FIRST, before ever trying to parse a
   * slot selection -- item 13 of the Phase 4C spec. The target (old) appointment is resolved once
   * here (source of truth, never inferred) and its id threads into every SlotOfferingService call
   * below as the reschedule context, so MAX_OFFER_ROUNDS is scoped to THIS reschedule episode. */
  private async handleRescheduleRequestedTurn(lead: Lead, conversationId: string, whatsappUserId: string, inboundText: string, now: Date): Promise<void> {
    if (isCancellationRequest(inboundText)) {
      await this.handOffToCancellation(lead, conversationId, whatsappUserId);
      return;
    }

    const oldAppointment = await this.findTargetAppointment(lead.id);
    if (oldAppointment === "INCONSISTENT") throw new AppointmentRescheduleInconsistentError(lead.id, "MULTIPLE_APPOINTMENTS");
    if (!oldAppointment) throw new AppointmentRescheduleInconsistentError(lead.id, "NO_APPOINTMENT");
    const rescheduleMode = { type: "RESCHEDULE" as const, oldAppointmentId: oldAppointment.id };

    // Phase 4C post-mortem fix: MUST be scoped by reschedule context -- an unscoped call here was
    // the actual root cause of a reschedule silently reusing unselected leftover slots from the
    // conversation's ORIGINAL booking round (whenever that round hadn't fully expired yet).
    const activeSlots = await this.deps.offeredSlots.listActiveByConversationId(conversationId, now, oldAppointment.id);

    if (activeSlots.length === 0) {
      // Nothing to interpret the inbound text against (e.g. the round expired, or this is a
      // recovery retry) -- get (or create) a fresh offer first, same bootstrap as
      // WhatsAppBookingHandler.
      const outcome = await this.deps.slotOffering.getOrCreateOffer({ lead, conversationId, now, mode: rescheduleMode });
      await dispatchSlotOfferOutcome(this.deps, outcome, lead, conversationId, whatsappUserId, this.advisorTimezone);
      return;
    }

    const selection = parseSlotSelection(inboundText, activeSlots, now);

    if (selection.type === "INVALID") {
      // Pre-launch hardening (same fix as WhatsAppBookingHandler's identical BOOKING_PENDING
      // trap): a general question no longer gets the terse "Por favor responde 1, 2 o 3"
      // reminder -- buildReschedulePendingFallbackMessage restates the same active options but
      // names the REAL escape hatch here (cancellation-intent is already checked above this
      // method's active-round lookup and hands off into CANCEL_PENDING -- see
      // handOffToCancellation), instead of only ever repeating the same instruction.
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildReschedulePendingFallbackMessage(activeSlots, this.advisorTimezone));
      return;
    }

    if (selection.type === "DECLINED") {
      const replacement = await this.deps.slotOffering.replaceOffer({ lead, conversationId, now, mode: rescheduleMode });
      await dispatchSlotOfferOutcome(this.deps, replacement, lead, conversationId, whatsappUserId, this.advisorTimezone, "slot_unavailable");
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
    if (slot.selected || !(slot.expiresAt > now)) {
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildInvalidSelectionMessage(activeSlots, this.advisorTimezone));
      return;
    }

    // Source-of-truth guard, once more, immediately before rescheduling -- same discipline as
    // WhatsAppBookingHandler's "appointment guard, once more, immediately before booking".
    const oldAppointment = await this.findTargetAppointment(lead.id);
    if (oldAppointment === "INCONSISTENT") throw new AppointmentRescheduleInconsistentError(lead.id, "MULTIPLE_APPOINTMENTS");
    if (!oldAppointment) throw new AppointmentRescheduleInconsistentError(lead.id, "NO_APPOINTMENT");

    // MANDATORY invariant (Phase 4C hardening, post-mortem item 9): a selected offered slot for a
    // RESCHEDULE_REQUESTED turn must belong to THIS exact reschedule episode -- never a booking-
    // context slot (rescheduleContextId undefined/null) and never a DIFFERENT reschedule episode's
    // slot (a stale oldAppointmentId from an earlier attempt). Defense-in-depth: with
    // listActiveByConversationId now correctly scoped by context (see the fix above this class),
    // `slot` should already be structurally guaranteed to match -- this check exists so a future
    // regression in that scoping can never again result in creating a Calendar event or an
    // appointment, or touching the old appointment, from a slot that doesn't genuinely belong
    // here. Never partially acts: no Calendar call, no appointment, no CAS on old -- treated
    // exactly like an expired/already-selected slot (see the check just above).
    if (slot.rescheduleContextId !== oldAppointment.id) {
      this.deps.logger.warn(
        { leadId: lead.id, slotId: slot.id, expectedContext: oldAppointment.id, actualContext: slot.rescheduleContextId ?? null },
        "Selected offered slot's reschedule context does not match the current old appointment -- refusing to reschedule from it (never creating Calendar/appointment side effects), treating as stale/invalid.",
      );
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildInvalidSelectionMessage(activeSlots, this.advisorTimezone));
      return;
    }

    let outcome;
    try {
      outcome = await this.deps.rescheduleService.reschedule({
        leadId: lead.id,
        oldAppointment,
        offeredSlotId: slot.id,
        start: slot.slotStart,
        end: slot.slotEnd,
        title: `Cita con Héctor Herrera${lead.firstName ? ` - ${lead.firstName}` : ""}`,
        description: "Cita reagendada automáticamente vía WhatsApp (Baluarte Capital).",
        attendeeEmail: lead.email,
        timezone: this.advisorTimezone,
      });
    } catch (err) {
      if (err instanceof RescheduleInProgressError) {
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, RESCHEDULE_IN_PROGRESS_MESSAGE);
        return;
      }
      throw err; // CalendarProviderError / any other technical failure -- handled generically by handleError.
    }

    if (outcome.type === "INCONSISTENT") throw new AppointmentRescheduleInconsistentError(lead.id, "UNEXPECTED_STATUS");

    await this.deps.offeredSlots.update(slot.id, { selected: true });
    const updatedLead = await this.ensureLeadBookedAfterReschedule(lead, outcome.newAppointment);
    await this.replyRescheduleConfirmed(updatedLead.id, conversationId, whatsappUserId, outcome.newAppointment);
  }

  /**
   * The source of truth for "which appointment this reschedule is about" -- never inferred from
   * messages. Exactly one BOOKED appointment: return it. Zero or more than one: escalate.
   * Deliberately simpler than WhatsAppCancellationHandler's equivalent (no
   * already-CANCELLED/idempotent-retry fallback branch): a reschedule's OWN idempotency
   * (AppointmentRescheduleService, keyed by leadId+oldAppointmentId+offeredSlotId) already fully
   * owns duplicate-retry safety independent of the old appointment's current status -- this
   * method only ever needs to find the CURRENTLY active appointment for a fresh attempt.
   */
  private async findTargetAppointment(leadId: string): Promise<Appointment | "INCONSISTENT" | null> {
    const active = await this.deps.appointments.listActiveByLeadId(leadId);
    if (active.length > 1) return "INCONSISTENT";
    if (active.length === 1) return active[0];
    return null;
  }

  /** `extraPatch` merges into the SAME write as the status change (never a second update call) --
   * used only by ensureLeadBookedAfterReschedule below to sync meetingAt atomically with the
   * RESCHEDULE_REQUESTED -> BOOKED transition. Every other caller omits it, unchanged. */
  private async transitionLead(lead: Lead, target: Lead["status"], eventType: string, extraPatch: Partial<Lead> = {}): Promise<Lead> {
    assertTransition(lead.status, target);
    const updated = await this.deps.leads.update(lead.id, { ...extraPatch, status: target });
    await recordLeadStatusTransition(this.deps.leadStatusHistory, this.deps.logger, {
      leadId: lead.id, fromStatus: lead.status, toStatus: target, eventType,
    });
    return updated;
  }

  /**
   * Set-once/idempotent, and re-fetches the lead's current status before deciding -- same
   * defensive discipline as WhatsAppCancellationHandler.ensureLeadCancelled (see its doc comment
   * for the general stale-snapshot race this guards against).
   *
   * Item 13 hardening: ONLY forces BOOKED when the current status is still RESCHEDULE_REQUESTED
   * (the expected precondition). Any OTHER current status -- concretely, CANCEL_PENDING, reached
   * via a concurrent "cancelar cita" turn (handOffToCancellation below) racing this exact
   * reschedule selection -- is left COMPLETELY untouched, status AND meetingAt both: without this
   * check, a reschedule finishing AFTER a concurrent cancellation-handoff already moved the lead
   * to CANCEL_PENDING would silently force it back to BOOKED (and now, with the fix below, ALSO
   * silently rewrite meetingAt), discarding the user's pending cancellation question. The
   * reschedule's own DB-side effects (new appointment BOOKED, old RESCHEDULED) are NEVER rolled
   * back here regardless -- they already durably happened and are correct; only the LEAD's fields
   * are left alone in that race.
   *
   * meetingAt sync (this hardening pass): a lead's meetingAt means "the date/time of the next
   * appointment" -- after a successful reschedule that must be `newAppointment.startsAt`, not the
   * OLD appointment's time it was set to at the original booking. bookedAt is a DIFFERENT field
   * ("when the original booking was first confirmed") and is deliberately NEVER touched here --
   * the reschedule event itself is already fully audited in lead_status_history,
   * appointment_status_history, and appointment_reschedules, so there is no need for a separate
   * "rescheduled_at" derived field.
   *
   * Idempotency/self-heal: if the lead is ALREADY BOOKED (a duplicate/retry turn for the same
   * reschedule, or a crash previously left meetingAt stale/null after the status write landed),
   * meetingAt is corrected to `newAppointment.startsAt` -- the appointment THIS call's caller just
   * had confirmed as active by AppointmentRescheduleService (never inferred from messages, never
   * the OLD appointment). No-ops (no write at all) when meetingAt already matches, so a plain
   * retry never produces a redundant write or a history row (status unchanged -> unchanged is
   * already a no-op for recordLeadStatusTransition, and this self-heal path never calls it).
   */
  private async ensureLeadBookedAfterReschedule(lead: Lead, newAppointment: Appointment): Promise<Lead> {
    const current = (await this.deps.leads.findById(lead.id)) ?? lead;

    if (current.status === "BOOKED") {
      if (current.meetingAt?.getTime() === newAppointment.startsAt.getTime()) return current; // already correct -- true no-op
      return this.deps.leads.update(lead.id, { meetingAt: newAppointment.startsAt });
    }

    if (current.status !== "RESCHEDULE_REQUESTED") {
      this.deps.logger.warn(
        { leadId: lead.id, expectedStatus: "RESCHEDULE_REQUESTED", actualStatus: current.status },
        "Lead status changed to something other than RESCHEDULE_REQUESTED/BOOKED by a concurrent turn while a reschedule was completing; leaving it exactly as that concurrent turn set it instead of forcing BOOKED.",
      );
      return current;
    }

    return this.transitionLead(current, "BOOKED", "RESCHEDULE_CONFIRMED", { meetingAt: newAppointment.startsAt });
  }

  /** Item 13: hands off to the SAME CANCEL_PENDING confirm/decline flow BOOKED already uses --
   * never a second cancellation UX. The next turn routes to WhatsAppCancellationHandler
   * (unmodified) since CANCEL_PENDING is already in its routing condition. */
  private async handOffToCancellation(lead: Lead, conversationId: string, whatsappUserId: string): Promise<void> {
    // Re-fetch and re-verify BEFORE transitioning -- symmetric with
    // ensureLeadBookedAfterReschedule's hardening above. If a concurrent slot-selection turn
    // already completed the reschedule (lead now BOOKED with a NEW active appointment) between
    // when this turn started and now, blindly transitioning from the stale RESCHEDULE_REQUESTED
    // snapshot would write a CANCEL_PENDING with a wrong fromStatus in the audit trail and could
    // target a display appointment that's already stale. Safer to leave this "cancelar cita" text
    // unactioned for THIS turn -- no state change, no message -- than to write something
    // misleading; the lead is already correctly BOOKED with its new appointment, and the user can
    // simply send "cancelar cita" again if they still want to.
    const current = (await this.deps.leads.findById(lead.id)) ?? lead;
    if (current.status !== "RESCHEDULE_REQUESTED") {
      this.deps.logger.warn(
        { leadId: lead.id, expectedStatus: "RESCHEDULE_REQUESTED", actualStatus: current.status },
        "Cancellation-intent text arrived for a lead no longer RESCHEDULE_REQUESTED (a concurrent reschedule selection already resolved it) -- left unactioned rather than writing a misleading CANCEL_PENDING transition.",
      );
      return;
    }

    const appointment = await this.findTargetAppointment(lead.id);
    if (appointment === "INCONSISTENT") throw new AppointmentRescheduleInconsistentError(lead.id, "MULTIPLE_APPOINTMENTS");
    if (!appointment) throw new AppointmentRescheduleInconsistentError(lead.id, "NO_APPOINTMENT");

    // Same eventType 4B already uses for BOOKED -> CANCEL_PENDING -- no new vocabulary for the
    // same real-world event ("the lead asked to cancel").
    await this.transitionLead(current, "CANCEL_PENDING", "CANCELLATION_REQUESTED");
    const when = formatSlotForDisplay(appointment.startsAt, this.advisorTimezone);
    await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildCancelConfirmationPromptMessage(when));
  }

  private async replyRescheduleConfirmed(leadId: string, conversationId: string, whatsappUserId: string, appointment: Appointment): Promise<void> {
    const when = formatSlotForDisplay(appointment.startsAt, this.advisorTimezone);
    await sendAndPersistReply(this.deps, leadId, conversationId, whatsappUserId, buildRescheduleConfirmedMessage(when, appointment.meetingUrl));
  }

  /**
   * Three categories, same discipline as WhatsAppBookingHandler.handleError:
   *  - AppointmentRescheduleInconsistentError: genuine data-consistency violation -- conservative
   *    HUMAN_HANDOFF, never a silent retry.
   *  - LeadNotOfferableError / ActiveOfferInconsistentError / SlotOfferClaimInProgressError /
   *    BookingInProgressError / SlotUnavailableError surfaced from SlotOfferingService: handled
   *    the same way dispatchSlotOfferOutcome/the caller already would for booking -- recoverable
   *    technical condition, message only, no state change. (SlotOfferClaimInProgressError gets its
   *    own message, matching WhatsAppBookingHandler's precedent.)
   *  - Anything else (CalendarProviderError, transient DB failures, ...): recoverable technical
   *    error -- message only, no state change, lead stays where it was.
   */
  private async handleError(err: unknown, lead: Lead, conversationId: string, whatsappUserId: string): Promise<void> {
    if (err instanceof AppointmentRescheduleInconsistentError) {
      this.deps.logger.warn(
        { leadId: lead.id, conversationId, errorName: err.name, reason: err.reason },
        "Appointment reschedule data-consistency error -- escalating to human handoff instead of retrying automatically.",
      );
      await escalateToHuman(this.deps, lead, conversationId, whatsappUserId, "RESCHEDULE_APPOINTMENT_INCONSISTENCY");
      return;
    }
    if (err instanceof SlotOfferClaimInProgressError) {
      this.deps.logger.warn(
        { leadId: lead.id, conversationId, errorName: err.name },
        "Slot-offering claim in progress (concurrent request) while rescheduling -- asking the lead to retry shortly, no state change.",
      );
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, RESCHEDULE_IN_PROGRESS_MESSAGE);
      return;
    }
    if (err instanceof ActiveOfferInconsistentError) {
      this.deps.logger.warn(
        { leadId: lead.id, conversationId, errorName: err.name },
        "Reschedule slot-offer data-consistency error -- escalating to human handoff instead of retrying automatically.",
      );
      await escalateToHuman(this.deps, lead, conversationId, whatsappUserId, "RESCHEDULE_OFFER_INCONSISTENCY");
      return;
    }
    // Anything else -- including LeadNotOfferableError, which should never actually occur through
    // normal routing (RESCHEDULE mode's assertOfferable requires exactly RESCHEDULE_REQUESTED,
    // which is exactly the status this handler is invoked with) -- is a recoverable technical
    // error: message only, no state change, kept generic as insurance against a future change
    // loosening that guarantee, same posture as WhatsAppBookingHandler's slot-selection
    // revalidation comment.
    this.deps.logger.warn(
      { leadId: lead.id, conversationId, errorName: err instanceof Error ? err.name : "unknown" },
      "Recoverable technical error while processing a reschedule; no state change.",
    );
    await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, RESCHEDULE_TECHNICAL_ERROR_MESSAGE);
  }
}
