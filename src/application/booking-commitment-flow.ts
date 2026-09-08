import type { Lead } from "../domain/lead.js";
import type { OfferedSlot } from "../domain/offered-slot.js";
import type { DatePreference } from "../domain/date-preference.js";
import { parseDaypartReply } from "../domain/daypart-preference-detection.js";
import { parseDatePreference } from "../domain/date-preference-parser.js";
import { classifyCommitmentReply } from "../domain/booking-commitment-detection.js";
import {
  daypartQuestionMetadata, bookingCommitmentMetadata,
  type PendingDaypartQuestion, type PendingBookingCommitment, type BookingFlowMode,
} from "../domain/booking-flow-state.js";
import { sendAndPersistReply } from "./whatsapp-inbound-service.js";
import { escalateToHuman, dispatchSlotOfferOutcome, type BookingOutcomeDeps } from "./booking-outcome-dispatch.js";
import type { SlotOfferingService, SlotOfferParams } from "./slot-offering-service.js";
import type { OfferedSlotRepository } from "./ports.js";
import { isSocialAcknowledgement, isBareGreeting, isVagueInformationRequest } from "../domain/social-acknowledgement-detection.js";
import { isNewBookingRequest } from "../domain/new-booking-intent-detection.js";
import {
  DAYPART_QUESTION_MESSAGE, buildCommitmentCheckMessage, COMMITMENT_CLARIFICATION_MESSAGE,
  buildCommitmentObstacleMessage, COMMITMENT_OBSTACLE_NO_SLOTS_MESSAGE, UNKNOWN_INTENT_HANDOFF_MESSAGE,
} from "../domain/message-templates.js";

/**
 * Fase 7K -- "Sandler Booking Flow" (spec sections 2-17). Shared, mode-agnostic (BOOKING vs
 * RESCHEDULE) flow logic for the two new conversational turns this feature introduces, reused by
 * WhatsAppBookingHandler, WhatsAppRescheduleHandler, WhatsAppPastBookedRecoveryHandler.startNewBooking
 * and WhatsAppReactivationHandler.startNewBooking -- never a second, divergent implementation per
 * handler (mirrors the existing booking-outcome-dispatch.ts precedent for cross-handler reuse).
 *
 * Deliberately does NOT own "how to actually book a confirmed slot" -- that differs between
 * BOOKING (AppointmentService.book()) and RESCHEDULE (AppointmentRescheduleService.reschedule()).
 * handleCommitmentReply's CONFIRMED branch instead re-finds the still-active OfferedSlot and
 * delegates to a caller-supplied `commitSlot` callback -- in practice each handler's own EXISTING,
 * UNCHANGED handleSelection method, so this module never duplicates the Calendar-level final
 * revalidation (isWithinBusinessHours + isSlotAvailable) AppointmentService.completeBooking()
 * already performs -- see the module's own audit notes for why that satisfies spec section 17
 * without any new revalidation logic here.
 */

export interface CommitmentFlowDeps extends BookingOutcomeDeps {
  offeredSlots: OfferedSlotRepository;
  slotOffering: SlotOfferingService;
}

function toSlotOfferMode(mode: BookingFlowMode, oldAppointmentId?: string): SlotOfferParams["mode"] {
  return mode === "RESCHEDULE" ? { type: "RESCHEDULE", oldAppointmentId: oldAppointmentId! } : undefined;
}

/** Fase 7K section 30 -- safe (no PII, no message text, no score/band) observability events for
 * this module's own branches. Logger only exposes warn() in this codebase (see ports.ts) -- every
 * other structured event here (whatsapp-inbound-service.ts's logBranch included) already reuses
 * that same method for non-error, informational checkpoints, so this follows the same convention
 * rather than inventing a new logging channel. */
function logBookingFlowEvent(deps: CommitmentFlowDeps, event: string, leadId: string, conversationId: string, extra: Record<string, unknown> = {}): void {
  deps.logger.warn({ event, leadIdLast8: leadId.slice(-8), conversationIdLast8: conversationId.slice(-8), ...extra }, `whatsapp booking flow: ${event}`);
}

/** Section 2/3/8 -- decides whether to ask the daypart question or go straight to offering.
 * `datePreference` is whatever the caller already parsed from the triggering inbound text (may be
 * undefined). When it already carries a daypart, this behaves exactly like the pre-7K call
 * (getOrCreateOffer/replaceOffer, dispatch) -- byte-identical for a lead who states a full
 * preference up front (e.g. "el sábado por la mañana"). Otherwise, persists
 * AWAITING_DAYPART_PREFERENCE (carrying forward any targetDate/weekday already parsed) and asks
 * the daypart question instead of creating any round -- so a round is NEVER created without a
 * known daypart once this gate is in place (section 8's ordering requirement). */
export async function offerWithDaypartGate(
  deps: CommitmentFlowDeps,
  params: {
    lead: Lead; conversationId: string; whatsappUserId: string; now: Date;
    datePreference: DatePreference | undefined;
    mode: BookingFlowMode;
    oldAppointmentId?: string;
    offerAction: "NEW" | "REPLACE";
    advisorTimezone: string;
    /** Passed straight through to getOrCreateOffer's own SlotOfferParams.skipRoundCap once the
     * round is actually created -- see that field's own doc comment. Never applies to a REPLACE
     * (replaceOffer never accepts it either). */
    skipRoundCap?: boolean;
  },
): Promise<void> {
  const { lead, conversationId, whatsappUserId, now, datePreference, mode, oldAppointmentId, offerAction, advisorTimezone, skipRoundCap } = params;

  if (datePreference?.daypart !== undefined) {
    await createOrReplaceOffer(deps, { lead, conversationId, whatsappUserId, now, datePreference, mode, oldAppointmentId, offerAction, advisorTimezone, skipRoundCap });
    return;
  }

  const pending: PendingDaypartQuestion = { mode, offerAction };
  if (oldAppointmentId !== undefined) pending.oldAppointmentId = oldAppointmentId;
  if (datePreference?.targetDate !== undefined) pending.targetDate = datePreference.targetDate;
  if (datePreference?.weekday !== undefined) pending.weekday = datePreference.weekday;
  if (skipRoundCap !== undefined) pending.skipRoundCap = skipRoundCap;

  // CRITICAL: transition the lead into BOOKING_PENDING HERE, before any round exists -- exactly
  // the same transition getOrCreateOffer/replaceOffer would otherwise perform once a round is
  // finally created. Without this, a lead answering the daypart question below would still be
  // sitting on QUALIFIED_A/B/NURTURE_C/CANCELLED/BOOKED, and whatsapp-inbound-service.ts's
  // status-based routing would send that answer to the wrong handler entirely (e.g. the
  // qualified-lead menu) instead of back into this same booking flow. Reuses
  // SlotOfferingService's own transition method -- never a second, divergent implementation --
  // and is itself idempotent (a no-op once already BOOKING_PENDING, e.g. a mid-round preference
  // change asking daypart again).
  const slotOfferMode = toSlotOfferMode(mode, oldAppointmentId);
  await deps.slotOffering.ensureOfferableLeadStatus(lead, now, slotOfferMode);

  logBookingFlowEvent(deps, "booking-daypart-requested", lead.id, conversationId, { mode });
  await sendAndPersistReply(deps, lead.id, conversationId, whatsappUserId, DAYPART_QUESTION_MESSAGE, daypartQuestionMetadata(pending));
}

async function createOrReplaceOffer(
  deps: CommitmentFlowDeps,
  params: {
    lead: Lead; conversationId: string; whatsappUserId: string; now: Date;
    datePreference: DatePreference | undefined;
    mode: BookingFlowMode; oldAppointmentId?: string; offerAction: "NEW" | "REPLACE"; advisorTimezone: string;
    skipRoundCap?: boolean;
  },
): Promise<void> {
  const { lead, conversationId, whatsappUserId, now, datePreference, mode, oldAppointmentId, offerAction, advisorTimezone, skipRoundCap } = params;
  const slotOfferMode = toSlotOfferMode(mode, oldAppointmentId);
  const outcome =
    offerAction === "NEW"
      ? await deps.slotOffering.getOrCreateOffer({ lead, conversationId, now, mode: slotOfferMode, datePreference, skipRoundCap })
      : await deps.slotOffering.replaceOffer({ lead, conversationId, now, mode: slotOfferMode, datePreference });
  if ((outcome.type === "CREATED" || outcome.type === "REUSED") && datePreference?.targetDate === undefined && datePreference?.weekday === undefined) {
    // Section 6/7 -- diversity applies exactly when neither an explicit date nor weekday was
    // pinned (the same gate availability.ts's own computeAvailableSlots uses).
    logBookingFlowEvent(deps, "booking-slot-offer-diversified", lead.id, conversationId, { slotCount: outcome.slots.length });
  }
  await dispatchSlotOfferOutcome(deps, outcome, lead, conversationId, whatsappUserId, advisorTimezone);
}

/** Section 2/3/4/27 -- handles a reply while AWAITING_DAYPART_PREFERENCE. Tries
 * parseDaypartReply first (contextual "mañana"/"tarde"/"1"/"2"/"temprano"); ALSO re-parses the
 * SAME reply with parseDatePreference so a lead who answers with a fuller preference ("el sábado
 * por la tarde") doesn't lose the day they just named -- the explicit reply's own targetDate/
 * weekday wins over whatever was pending (a lead correcting themselves takes priority), falling
 * back to the pending values otherwise. When neither resolves a daypart, applies the same
 * "stays generic vs escalates" classifier Fase 7J/7J.1/7J.3 already established -- reused
 * verbatim, never a second classifier. */
export async function handleDaypartReply(
  deps: CommitmentFlowDeps,
  params: {
    lead: Lead; conversationId: string; whatsappUserId: string; now: Date; inboundText: string;
    pending: PendingDaypartQuestion; advisorTimezone: string;
  },
): Promise<void> {
  const { lead, conversationId, whatsappUserId, now, inboundText, pending, advisorTimezone } = params;

  const daypart = parseDaypartReply(inboundText);
  if (daypart === null) {
    // Section 3/23: a reply that changes the DATE without answering the daypart question itself
    // (e.g. "mejor domingo") must never be misread as unrelated content -- update the pending
    // target date/weekday and ask again, rather than escalating a perfectly sensible follow-up.
    const dateOnly = parseDatePreference(inboundText, now, advisorTimezone);
    if (dateOnly?.targetDate !== undefined || dateOnly?.weekday !== undefined) {
      const updated: PendingDaypartQuestion = { mode: pending.mode, offerAction: pending.offerAction };
      if (pending.oldAppointmentId !== undefined) updated.oldAppointmentId = pending.oldAppointmentId;
      if (pending.skipRoundCap !== undefined) updated.skipRoundCap = pending.skipRoundCap;
      if (dateOnly.targetDate !== undefined) updated.targetDate = dateOnly.targetDate;
      else if (dateOnly.weekday !== undefined) updated.weekday = dateOnly.weekday;
      await sendAndPersistReply(deps, lead.id, conversationId, whatsappUserId, DAYPART_QUESTION_MESSAGE, daypartQuestionMetadata(updated));
      return;
    }
    const staysGeneric =
      isSocialAcknowledgement(inboundText)
      || isBareGreeting(inboundText)
      || isVagueInformationRequest(inboundText)
      || isNewBookingRequest(inboundText);
    if (staysGeneric) {
      // Re-ask, never silently drop the pending state -- a vague/trivial reply doesn't answer
      // the question, so it's repeated exactly like BOOKING_PENDING's own INVALID-but-safe reply
      // restates the active options (buildBookingPendingFallbackMessage precedent).
      await sendAndPersistReply(deps, lead.id, conversationId, whatsappUserId, DAYPART_QUESTION_MESSAGE, daypartQuestionMetadata(pending));
      return;
    }
    await escalateToHuman(deps, lead, conversationId, whatsappUserId, "UNKNOWN_INTENT_HANDOFF", UNKNOWN_INTENT_HANDOFF_MESSAGE);
    return;
  }

  logBookingFlowEvent(deps, "booking-daypart-selected", lead.id, conversationId, { daypart });
  const explicit = parseDatePreference(inboundText, now, advisorTimezone);
  const datePreference: DatePreference = { daypart };
  if (explicit?.targetDate !== undefined) datePreference.targetDate = explicit.targetDate;
  else if (pending.targetDate !== undefined) datePreference.targetDate = pending.targetDate;
  if (datePreference.targetDate === undefined) {
    if (explicit?.weekday !== undefined) datePreference.weekday = explicit.weekday;
    else if (pending.weekday !== undefined) datePreference.weekday = pending.weekday;
  }

  await createOrReplaceOffer(deps, {
    lead, conversationId, whatsappUserId, now, datePreference,
    mode: pending.mode, oldAppointmentId: pending.oldAppointmentId, offerAction: pending.offerAction, advisorTimezone,
    skipRoundCap: pending.skipRoundCap,
  });
}

/** Section 11/12/13 -- called instead of immediately booking a SELECTED slot. Persists
 * AWAITING_BOOKING_COMMITMENT (section 13's exact field list) and asks the Sandler commitment
 * question -- no Calendar mutation, no appointment created here. */
export async function initiateCommitmentCheck(
  deps: CommitmentFlowDeps,
  params: {
    lead: Lead; conversationId: string; whatsappUserId: string; now: Date;
    slot: OfferedSlot; mode: BookingFlowMode; oldAppointmentId?: string; advisorTimezone: string;
    /** The DatePreference that produced this round -- carried forward so a later OBSTACLE reply
     * can re-offer honoring the same daypart/date (section 15/21). Always has `daypart` set:
     * every round is created only after offerWithDaypartGate resolves one. */
    datePreference: DatePreference & { daypart: NonNullable<DatePreference["daypart"]> };
  },
): Promise<void> {
  const { lead, conversationId, whatsappUserId, now, slot, mode, oldAppointmentId, advisorTimezone, datePreference } = params;
  const pending: PendingBookingCommitment = {
    selectedSlotId: slot.id,
    slotStart: slot.slotStart.toISOString(),
    slotEnd: slot.slotEnd.toISOString(),
    slotOfferRoundId: slot.roundId,
    mode,
    timestamp: now.toISOString(),
    clarificationAsked: false,
    daypart: datePreference.daypart,
  };
  if (oldAppointmentId !== undefined) pending.oldAppointmentId = oldAppointmentId;
  if (datePreference.targetDate !== undefined) pending.targetDate = datePreference.targetDate;
  if (datePreference.weekday !== undefined) pending.weekday = datePreference.weekday;

  logBookingFlowEvent(deps, "booking-commitment-requested", lead.id, conversationId, { mode });
  await sendAndPersistReply(
    deps, lead.id, conversationId, whatsappUserId,
    buildCommitmentCheckMessage(slot.slotStart, advisorTimezone),
    bookingCommitmentMetadata(pending),
  );
}

/** Section 14/15/16/17/26 -- handles a reply while AWAITING_BOOKING_COMMITMENT.
 *  - CONFIRMED: re-finds the slot among the CURRENT active offered_slots (never trusts the
 *    persisted snapshot alone -- section 17's revalidation). If it's gone (expired/superseded --
 *    e.g. TTL elapsed per section 25, or a concurrent turn already consumed/replaced the round),
 *    a fresh, daypart-respecting offer is made instead of silently booking something else.
 *    Otherwise delegates to the caller's `commitSlot` -- the handler's own existing
 *    handleSelection, which performs the full Calendar-level revalidation via
 *    AppointmentService.book()/completeBooking() before ever creating the event (see this
 *    module's own doc comment for why that's sufficient and nothing is duplicated here).
 *  - OBSTACLE: never books. Empathetic message + a fresh offer in the same reply (see
 *    buildCommitmentObstacleMessage's own doc comment for why this is a deliberate, disclosed
 *    deviation from the spec's literal two-step example copy).
 *  - AMBIGUOUS: clarify once (section 16); a second AMBIGUOUS in a row (clarificationAsked
 *    already true) escalates via the existing UNKNOWN_INTENT_HANDOFF path -- section 28's "reuse
 *    the existing advisor alert, no new mechanism" falls out of this for free, since
 *    escalateToHuman already owns that gating. */
export async function handleCommitmentReply(
  deps: CommitmentFlowDeps,
  params: {
    lead: Lead; conversationId: string; whatsappUserId: string; now: Date; inboundText: string;
    pending: PendingBookingCommitment; advisorTimezone: string;
    commitSlot: (slot: OfferedSlot, activeSlots: OfferedSlot[]) => Promise<void>;
  },
): Promise<void> {
  const { lead, conversationId, whatsappUserId, now, inboundText, pending, advisorTimezone, commitSlot } = params;
  const classification = classifyCommitmentReply(inboundText);

  if (classification === "OBSTACLE") {
    logBookingFlowEvent(deps, "booking-commitment-obstacle", lead.id, conversationId, { mode: pending.mode });
    const slotOfferMode = toSlotOfferMode(pending.mode, pending.oldAppointmentId);
    const reofferPreference: DatePreference = { daypart: pending.daypart };
    if (pending.targetDate !== undefined) reofferPreference.targetDate = pending.targetDate;
    else if (pending.weekday !== undefined) reofferPreference.weekday = pending.weekday;
    const outcome = await deps.slotOffering.replaceOffer({ lead, conversationId, now, mode: slotOfferMode, datePreference: reofferPreference });
    if (outcome.type === "CREATED" || outcome.type === "REUSED") {
      if (outcome.slots.length === 0) {
        await sendAndPersistReply(deps, lead.id, conversationId, whatsappUserId, COMMITMENT_OBSTACLE_NO_SLOTS_MESSAGE);
        return;
      }
      await sendAndPersistReply(deps, lead.id, conversationId, whatsappUserId, buildCommitmentObstacleMessage(outcome.slots, advisorTimezone));
      return;
    }
    // NO_AVAILABILITY / MAX_ROUNDS_REACHED / REQUESTED_DATE_UNAVAILABLE / ALREADY_BOOKED -- reuse
    // the shared outcome dispatcher so those (comparatively rare) branches get their own already-
    // correct handling instead of a duplicated, narrower copy here.
    await dispatchSlotOfferOutcome(deps, outcome, lead, conversationId, whatsappUserId, advisorTimezone);
    return;
  }

  if (classification === "AMBIGUOUS") {
    if (!pending.clarificationAsked) {
      logBookingFlowEvent(deps, "booking-commitment-clarification", lead.id, conversationId, { mode: pending.mode });
      await sendAndPersistReply(
        deps, lead.id, conversationId, whatsappUserId,
        COMMITMENT_CLARIFICATION_MESSAGE,
        bookingCommitmentMetadata({ ...pending, clarificationAsked: true }),
      );
      return;
    }
    await escalateToHuman(deps, lead, conversationId, whatsappUserId, "UNKNOWN_INTENT_HANDOFF", UNKNOWN_INTENT_HANDOFF_MESSAGE);
    return;
  }

  // CONFIRMED -- section 17: revalidate against the CURRENT active offered_slots before ever
  // delegating to commitSlot. rescheduleContextIdOf-equivalent scoping: booking mode passes
  // undefined (NULL rows only), reschedule mode passes the old appointment id.
  const rescheduleContextId = pending.mode === "RESCHEDULE" ? pending.oldAppointmentId : undefined;
  const activeSlots = await deps.offeredSlots.listActiveByConversationId(conversationId, now, rescheduleContextId);
  const slot = activeSlots.find((s) => s.id === pending.selectedSlotId);
  if (!slot) {
    logBookingFlowEvent(deps, "booking-final-slot-unavailable", lead.id, conversationId, { mode: pending.mode });
    const slotOfferMode = toSlotOfferMode(pending.mode, pending.oldAppointmentId);
    const replacement = await deps.slotOffering.replaceOffer({ lead, conversationId, now, mode: slotOfferMode });
    await dispatchSlotOfferOutcome(deps, replacement, lead, conversationId, whatsappUserId, advisorTimezone, "slot_unavailable");
    return;
  }
  logBookingFlowEvent(deps, "booking-commitment-confirmed", lead.id, conversationId, { mode: pending.mode });
  await commitSlot(slot, activeSlots);
}
