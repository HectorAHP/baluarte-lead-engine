import type { Lead } from "../domain/lead.js";
import { isCancellationRequest } from "../domain/cancellation-intent-detection.js";
import { isRescheduleRequest } from "../domain/reschedule-intent-detection.js";
import { isNewBookingRequest } from "../domain/new-booking-intent-detection.js";
import { detectQualifiedLeadIntent } from "../domain/qualified-lead-intent-detection.js";
import { qualifiedMainMenuMetadata, qualifiedOptionsMenuMetadata } from "../domain/qualified-lead-menu-state.js";
import { pastBookedReactivationMetadata, hasPastBookedReactivationBeenShown } from "../domain/past-booked-reactivation-state.js";
import {
  resolvePendingTopicFollowup, detectFollowupBranch, buildFollowupBranchAnswer, buildFollowupClarifyMessage,
  classifyShortResponse, topicFollowupMetadata, FOLLOWUP_CLOSING_MESSAGE, type QualifiedLeadFollowupTopic,
} from "../domain/qualified-lead-topic-followup.js";
import { sendAndPersistReply } from "./whatsapp-inbound-service.js";
import { escalateToHuman, dispatchSlotOfferOutcome, type BookingOutcomeDeps } from "./booking-outcome-dispatch.js";
import type { SlotOfferingService } from "./slot-offering-service.js";
import { ActiveOfferInconsistentError, SlotOfferClaimInProgressError } from "../domain/errors.js";
import {
  PAST_BOOKED_GENERIC_INBOUND_MESSAGE, PAST_BOOKED_RESCHEDULE_TO_NEW_BOOKING_MESSAGE, PAST_BOOKED_CANCELLATION_MESSAGE,
  RESCHEDULE_IN_PROGRESS_MESSAGE, RESCHEDULE_TECHNICAL_ERROR_MESSAGE, buildQualifiedLeadTopicAnswer, buildQualifiedLeadOptionsMessage,
  QUALIFIED_LEAD_IDENTITY_ANSWER_MESSAGE, QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE,
} from "../domain/message-templates.js";
import { config } from "../config.js";

export interface WhatsAppPastBookedRecoveryHandlerDeps extends BookingOutcomeDeps {
  slotOffering: SlotOfferingService;
}

export interface PastBookedRecoveryTurnHandler {
  handleTurn(params: {
    lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date;
    /** Fase 6E.2: mirrors the qualified-lead router's own `!!fiscalContext` -- the ONLY thing
     * allowed to influence the ORDER of the "opciones" reply (see buildQualifiedLeadOptionsMessage's
     * doc comment). Never score/band/HOT-WARM-NURTURE. Optional/defaults to false so this stays
     * backward-compatible with any caller that predates this field. */
    hasFiscalContext?: boolean;
  }): Promise<void>;
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

  async handleTurn(params: {
    lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date;
    hasFiscalContext?: boolean;
  }): Promise<void> {
    const { lead, conversationId, whatsappUserId, inboundText, now, hasFiscalContext = false } = params;

    // Guard: this handler only ever acts on a BOOKED lead. The caller (whatsapp-inbound-service.ts)
    // already confirmed the appointment is not upcoming before dispatching here, but this guard
    // stays anyway, matching every other handler's own no-op-on-mismatch convention.
    if (lead.status !== "BOOKED") return;

    try {
      // Cancellation-intent -- non-destructive, idempotent: nothing exists to cancel. Checked
      // FIRST so it can never be misread as anything else -- an explicit "cancelar" always wins,
      // even mid-followup.
      if (isCancellationRequest(inboundText)) {
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, PAST_BOOKED_CANCELLATION_MESSAGE);
        return;
      }

      // "Quiero reagendar" -- there is nothing left to move (the old time already passed), so
      // this is explicitly reframed as a new-booking intent, with an acknowledgment sent before
      // the slot offer so the lead understands why. Checked BEFORE isNewBookingRequest so
      // "reagendar" is never swallowed by the broader booking-keyword check below (both handle
      // booking-adjacent text, but only this branch sends the acknowledgment first).
      if (isRescheduleRequest(inboundText)) {
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, PAST_BOOKED_RESCHEDULE_TO_NEW_BOOKING_MESSAGE);
        await this.startNewBooking(lead, conversationId, whatsappUserId, now);
        return;
      }

      // Explicit new-booking intent -- start the booking round directly, no extra acknowledgment
      // needed (the intent is already unambiguous). Fase 6E.2: isNewBookingRequest now recognizes
      // a bare "agendar" (see that module's doc comment) -- this is THE fix for the reported
      // production loop, where the lead was told to type exactly this word and it was never
      // recognized. Fase 6E.3: startNewBooking now passes skipRoundCap (see that method's doc
      // comment) -- this is THE fix for "agendar" landing on HUMAN_HANDOFF instead of real
      // availability.
      if (isNewBookingRequest(inboundText)) {
        await this.startNewBooking(lead, conversationId, whatsappUserId, now);
        return;
      }

      // Fase 6E.3: a pending topic-followup (e.g. PPR's "¿Quieres que te explique primero cómo
      // funciona el beneficio fiscal o cómo se construye el ahorro para el retiro?") takes
      // priority over generic intent detection, so a short reply ("1", "beneficio fiscal", "Sí",
      // "Ok") resolves against THAT specific question instead of falling through to UNKNOWN and
      // re-triggering PAST_BOOKED_GENERIC_INBOUND_MESSAGE -- the exact reported bug. Checked here
      // (after the unambiguous cancellation/reschedule/booking keywords, before the generic
      // detectQualifiedLeadIntent pass) because a genuinely unambiguous "cancelar"/"agendar" must
      // always win, but a short/ambiguous reply must be interpreted against the pending question,
      // never against a stale/nonexistent numbered menu.
      const priorMessages = await this.deps.messages.listByConversationId(conversationId);
      const pendingFollowup = resolvePendingTopicFollowup(priorMessages);
      if (pendingFollowup) {
        const branch = detectFollowupBranch(pendingFollowup, inboundText);
        switch (branch) {
          case "PRIMARY":
          case "SECONDARY":
            // Resolved -- state naturally consumed: this reply carries no followup metadata, so a
            // LATER bare "1" is genuinely ambiguous again (item 7's "no interpretar dígitos fuera
            // de contexto"), never reinterpreted as this same branch indefinitely.
            await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildFollowupBranchAnswer(pendingFollowup, branch));
            return;
          case "CLARIFY_EXPLICIT":
          case "CLARIFY_GENERIC":
            // "Sí"/"Ok" -- ambiguous between the two branches on offer, so ask which one,
            // KEEPING the same pending state (item 4: "Mantener el mismo pending state").
            await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildFollowupClarifyMessage(pendingFollowup, branch), topicFollowupMetadata(pendingFollowup));
            return;
          case "CLOSING":
            // "No"/"gracias" -- a closing remark, not a request for more detail. Consumes the
            // pending state (no metadata on this reply), never past-booked.
            await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, FOLLOWUP_CLOSING_MESSAGE);
            return;
          case "UNKNOWN":
            break; // falls through to normal keyword detection below
        }
      }

      // Fase 6E.2: reuses the qualified-lead router's own deterministic keyword detection (never
      // AI) so a past-booked lead's real question ("¿Cómo funciona el PPR?"), "conocer opciones",
      // an equivalent booking phrasing this router's own keyword set catches, or "¿quién eres?"
      // gets a real, useful answer -- never PAST_BOOKED_GENERIC_INBOUND_MESSAGE again. A past
      // appointment is CONTEXT, not a routing dead end (see the Fase 6E.2 report, item 2/5). No
      // pending-menu digit resolution is attempted here (second argument `null`): this flow never
      // shows a numbered 1/2/3 menu, so a bare digit has no menu to resolve against and correctly
      // falls through to UNKNOWN below (never guessed at -- item 7's "no interpretar dígitos fuera
      // de un menú que realmente haya sido mostrado").
      const intent = detectQualifiedLeadIntent(inboundText, null);
      switch (intent.kind) {
        case "QUESTION": {
          // Fase 6E.3: PPR/GMM answers now END by marking topicFollowupMetadata() -- see that
          // module's doc comment for why SAVINGS is deliberately excluded (its own follow-up
          // question is open-ended, not a two-branch choice).
          const followupTopic: QualifiedLeadFollowupTopic | undefined = intent.topic === "PPR" || intent.topic === "GMM" ? intent.topic : undefined;
          await sendAndPersistReply(
            this.deps, lead.id, conversationId, whatsappUserId,
            buildQualifiedLeadTopicAnswer(intent.topic),
            followupTopic ? topicFollowupMetadata(followupTopic) : undefined,
          );
          return;
        }
        case "EXPLORE_OPTIONS":
          await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildQualifiedLeadOptionsMessage(hasFiscalContext), qualifiedOptionsMenuMetadata());
          return;
        case "BOOKING":
          // Reached only for booking-adjacent phrasing this router's own keyword set (BOOKING_
          // KEYWORDS) catches but isNewBookingRequest's phrase list above didn't -- same action,
          // no separate acknowledgment (the intent is already unambiguous, same reasoning as the
          // isNewBookingRequest branch above).
          await this.startNewBooking(lead, conversationId, whatsappUserId, now);
          return;
        case "IDENTITY":
          await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, QUALIFIED_LEAD_IDENTITY_ANSWER_MESSAGE);
          return;
        case "MENU_QUESTION":
        case "UNKNOWN":
          break; // falls through to the short-response/generic fallback below
      }

      // Fase 6E.3, item 10: a short reply with NO pending followup state (sí/ok/va/perfecto or
      // no/gracias) never falls back to PAST_BOOKED_GENERIC_INBOUND_MESSAGE -- these carry no
      // content to explain the past appointment against. An affirmative-but-unspecified reply
      // gets the same topic-agnostic redirect as an already-shown episode (below); a closing
      // remark gets the shared closer, no metadata.
      const shortResponse = classifyShortResponse(inboundText);
      if (shortResponse === "CLOSING") {
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, FOLLOWUP_CLOSING_MESSAGE);
        return;
      }
      if (shortResponse === "AFFIRMATIVE") {
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE, qualifiedMainMenuMetadata());
        return;
      }

      // Genuinely unrecognized text (never a short-response token). Fase 6E.3, item 6:
      // PAST_BOOKED_GENERIC_INBOUND_MESSAGE is shown at most ONCE per reactivation episode -- once
      // it has already appeared anywhere in this conversation's history, a LATER unrecognized
      // reply gets the topic-agnostic QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE instead (never
      // repeats "tu cita anterior ya pasó" after the lead has already engaged normally).
      if (hasPastBookedReactivationBeenShown(priorMessages)) {
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE, qualifiedMainMenuMetadata());
      } else {
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, PAST_BOOKED_GENERIC_INBOUND_MESSAGE, pastBookedReactivationMetadata());
      }
    } catch (err) {
      await this.handleError(err, lead, conversationId, whatsappUserId);
    }
  }

  /**
   * Reuses SlotOfferingService's BOOKED -> BOOKING_PENDING transition + audit event (see the
   * class doc comment above) -- no bespoke transition-writing logic here. mode is omitted (plain
   * booking mode): the new offered_slots round gets reschedule_context_id IS NULL, exactly what
   * WhatsAppBookingHandler's own slot-selection lookup expects to find -- unchanged from before
   * Fase 6E.3. The stale appointment row is never referenced, restored, or touched by any of this.
   *
   * Fase 6E.3: passes `skipRoundCap: true` -- see SlotOfferParams.skipRoundCap's doc comment in
   * slot-offering-service.ts for the full root-cause this closes (a rebooking attempt was
   * inheriting the ORIGINAL, already-concluded booking's round count, which could immediately
   * exhaust MAX_OFFER_ROUNDS and escalate straight to HUMAN_HANDOFF). Every call into this method
   * is, by construction, a past-booked rebooking (the class-level `lead.status !== "BOOKED"`
   * guard above already ensures that), so `skipRoundCap: true` is unconditional here -- there is
   * no other kind of call this method ever makes.
   */
  private async startNewBooking(lead: Lead, conversationId: string, whatsappUserId: string, now: Date): Promise<void> {
    const outcome = await this.deps.slotOffering.getOrCreateOffer({ lead, conversationId, now, skipRoundCap: true });
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
