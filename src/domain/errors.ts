export class LeadNotFoundError extends Error {
  constructor(public readonly leadId: string) {
    super(`LEAD_NOT_FOUND: ${leadId}`);
    this.name = "LeadNotFoundError";
  }
}

export class InvalidLeadTransitionError extends Error {
  constructor(public readonly from: string, public readonly to: string) {
    super(`Invalid lead transition: ${from} -> ${to}`);
    this.name = "InvalidLeadTransitionError";
  }
}

export class SlotUnavailableError extends Error {
  constructor(message = "The requested time slot is no longer available") {
    super(message);
    this.name = "SlotUnavailableError";
  }
}

export class CalendarProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CalendarProviderError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`Idempotency-Key ${idempotencyKey} was reused with a different request payload`);
    this.name = "IdempotencyConflictError";
  }
}

/**
 * Thrown by BookingAttemptRepository.create() when a Postgres unique-violation (23505) on
 * idempotency_key means another request already won the race to create this booking_attempts
 * row. AppointmentService.book() is the one that decides what to do next (re-fetch and dispatch
 * on the existing row's status) -- this error only reports what happened, deliberately not
 * swallowed or silently converted to a generic error.
 */
export class BookingAttemptKeyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`booking_attempts.idempotency_key ${idempotencyKey} was created concurrently by another request`);
    this.name = "BookingAttemptKeyConflictError";
  }
}

/**
 * Thrown when a booking_attempts row is genuinely owned by another request right now (a fresh
 * PENDING, or the loser of a claimTransition CAS). The caller never calls Google or creates an
 * appointment in this case -- it's a "someone else is handling this, back off" signal, not an
 * error condition to retry blindly.
 */
export class BookingInProgressError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`A booking attempt for idempotency key ${idempotencyKey} is already in progress`);
    this.name = "BookingInProgressError";
  }
}

/**
 * Thrown when a booking_attempts row is COMPLETED with an appointmentId that no longer resolves
 * to a real appointment (data corruption / manual deletion, not a normal runtime condition).
 * Deliberately never auto-recovered -- recreating an appointment or re-calling Google here could
 * produce a duplicate; this needs human reconciliation.
 */
export class BookingAttemptInconsistentError extends Error {
  constructor(public readonly bookingAttemptId: string) {
    super(`booking_attempts ${bookingAttemptId} is COMPLETED but its appointment could not be found`);
    this.name = "BookingAttemptInconsistentError";
  }
}

/**
 * Thrown by SlotOfferingService.getOrCreateOffer/replaceOffer when called for a lead whose
 * current status is not eligible for slot offering (must be QUALIFIED_A, QUALIFIED_B, or
 * BOOKING_PENDING). This is a caller precondition violation, not a normal business outcome --
 * unlike ALREADY_BOOKED/NO_AVAILABILITY/MAX_ROUNDS_REACHED (modeled as SlotOfferOutcome values
 * because a caller must handle them as expected, non-exceptional branches), a lead in
 * HUMAN_HANDOFF/DO_NOT_CONTACT/NURTURE_C/BOOKED (or any earlier pre-qualification status) should
 * never reach this service at all -- the caller already knows the lead's status from whatever
 * triggered it.
 */
export class LeadNotOfferableError extends Error {
  constructor(public readonly leadId: string, public readonly status: string) {
    super(`Lead ${leadId} is not in an offerable status for slot offering (status=${status})`);
    this.name = "LeadNotOfferableError";
  }
}

/**
 * Thrown by SlotOfferingService when listActiveByConversationId returns active offered_slots
 * spanning more than one round_id for the same conversation -- a data-consistency violation that
 * should never happen through this service's own successful code paths, but could arise if e.g.
 * replaceOffer persisted a new round and then failed to expire the previous one (see
 * replaceOffer's documented residual risk), or from direct manual data manipulation. Never
 * silently picks one round and discards/ignores the other -- that risks presenting or booking
 * against slots the caller no longer intends to be valid. Requires manual reconciliation
 * (explicitly expiring the stale round) before offering can resume for this conversation.
 */
export class ActiveOfferInconsistentError extends Error {
  constructor(public readonly conversationId: string, public readonly roundIds: string[]) {
    super(`conversation ${conversationId} has active offered_slots spanning multiple rounds: ${roundIds.join(", ")}`);
    this.name = "ActiveOfferInconsistentError";
  }
}

/**
 * Thrown by SlotOfferingService when a caller loses the race to create a new round AND the
 * winner (a) hasn't finished within the bounded polling window and (b) still holds a genuinely
 * fresh slot_offer_claims row -- i.e. someone else is legitimately working on it right now. This
 * is a concurrency signal, never a data-consistency problem (contrast with
 * ActiveOfferInconsistentError) -- the caller should treat it as a recoverable technical
 * condition (the existing generic "unexpected error" handling in WhatsAppBookingHandler /
 * WhatsAppQualificationHandler already does this correctly with no changes needed there).
 */
export class SlotOfferClaimInProgressError extends Error {
  constructor(public readonly conversationId: string) {
    super(`A slot-offering claim for conversation ${conversationId} is already in progress`);
    this.name = "SlotOfferClaimInProgressError";
  }
}

/**
 * Thrown by AppointmentCancellationService/WhatsAppCancellationHandler when the source of truth
 * (appointments table, never inferred from messages) doesn't match what a cancellation flow
 * requires: no BOOKED appointment exists for the lead, more than one does (data-consistency
 * violation, never silently picks one), or a compare-and-set lost the race against a status that
 * is neither BOOKED nor CANCELLED (unexpected in Phase 4B -- no reschedule path exists yet).
 * Always escalates to HUMAN_HANDOFF -- never auto-retried, never silently ignored.
 */
export class AppointmentCancellationInconsistentError extends Error {
  constructor(public readonly leadId: string, public readonly reason: "NO_APPOINTMENT" | "MULTIPLE_APPOINTMENTS" | "UNEXPECTED_STATUS") {
    super(`Appointment cancellation inconsistency for lead ${leadId}: ${reason}`);
    this.name = "AppointmentCancellationInconsistentError";
  }
}

/**
 * Thrown by AppointmentRescheduleService/WhatsAppRescheduleHandler when the source of truth
 * (appointments table, never inferred from messages) doesn't match what a reschedule flow
 * requires: no BOOKED appointment exists for the lead, more than one does (data-consistency
 * violation, never silently picks one), or the old appointment is neither BOOKED nor already
 * RESCHEDULED-by-this-exact-operation (e.g. it was CANCELLED by a concurrent request). Always
 * escalates to HUMAN_HANDOFF -- never auto-retried, never silently ignored.
 */
export class AppointmentRescheduleInconsistentError extends Error {
  constructor(public readonly leadId: string, public readonly reason: "NO_APPOINTMENT" | "MULTIPLE_APPOINTMENTS" | "UNEXPECTED_STATUS") {
    super(`Appointment reschedule inconsistency for lead ${leadId}: ${reason}`);
    this.name = "AppointmentRescheduleInconsistentError";
  }
}

/**
 * Thrown when a reschedule operation row (appointment_reschedules, keyed by
 * `whatsapp-reschedule:{leadId}:{oldAppointmentId}:{offeredSlotId}`) is genuinely owned by another
 * request right now -- the row exists but its new appointment hasn't been persisted yet. Mirrors
 * BookingInProgressError's exact "someone else is handling this, back off" semantics. Deliberately
 * has NO stale-reclaim path (contrast with AppointmentService.claimExistingAttempt): reclaiming an
 * abandoned Phase A attempt safely would need its own compare-and-set state machine, and the
 * failure mode without one is bounded and self-healing -- the specific offered_slots row this key
 * is scoped to expires within OFFERED_SLOT_TTL_MS regardless, after which the lead's next
 * reschedule attempt gets a fresh round and a fresh idempotency key. See the Phase 4C report.
 */
export class RescheduleInProgressError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`A reschedule attempt for idempotency key ${idempotencyKey} is already in progress`);
    this.name = "RescheduleInProgressError";
  }
}

export class InvalidQualificationFieldError extends Error {
  constructor(public readonly vertical: string, public readonly fieldName: string) {
    super(`Field "${fieldName}" is not in the allowed qualification whitelist for ${vertical}`);
    this.name = "InvalidQualificationFieldError";
  }
}

export class DuplicateMessageError extends Error {
  constructor(public readonly channel: string, public readonly providerMessageId: string) {
    super(`Message with providerMessageId ${providerMessageId} on channel ${channel} was already ingested`);
    this.name = "DuplicateMessageError";
  }
}

export class MessagingProviderError extends Error {
  /** HTTP status Meta returned, when known. */
  public readonly httpStatus?: number;
  /** Meta's numeric error taxonomy code (e.g. 190 = invalid/expired OAuth token). Public API
   * error code, not a secret -- safe to surface in diagnostics. */
  public readonly metaErrorCode?: number;
  /** Meta's error type string (e.g. "OAuthException"). Also public taxonomy, not a secret. */
  public readonly metaErrorType?: string;
  /** Static, code-derived diagnosis text (see diagnoseMetaError) -- never Meta's raw error.message. */
  public readonly sanitizedDiagnosis?: string;
  /** Last 4 characters of the WHATSAPP_PHONE_NUMBER_ID used for the request, for log correlation
   * without exposing the full id. */
  public readonly phoneNumberIdLast4?: string;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      httpStatus?: number;
      metaErrorCode?: number;
      metaErrorType?: string;
      sanitizedDiagnosis?: string;
      phoneNumberIdLast4?: string;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MessagingProviderError";
    this.httpStatus = options?.httpStatus;
    this.metaErrorCode = options?.metaErrorCode;
    this.metaErrorType = options?.metaErrorType;
    this.sanitizedDiagnosis = options?.sanitizedDiagnosis;
    this.phoneNumberIdLast4 = options?.phoneNumberIdLast4;
  }
}
