/**
 * Deterministic, keyword-based detection of "I want to stop this booking process" while a lead is
 * BOOKING_PENDING -- never delegated to an LLM, same safety posture as
 * cancellation-intent-detection.ts / reschedule-intent-detection.ts / new-booking-intent-detection.ts.
 * Only ever checked for a lead currently BOOKING_PENDING (see WhatsAppBookingHandler), and ONLY
 * AFTER the existingAppointment guard has already run -- so this can never fire once a real
 * appointment exists for this lead; there is nothing to "cancel" in the appointment sense at the
 * point this is checked, only a pending booking round to abandon.
 *
 * PRE-LAUNCH HARDENING: closes the "BOOKING_PENDING trap" -- previously ANY inbound text that
 * wasn't a valid slot number or an exact DECLINED_PHRASES match (see slot-selection-parser.ts) was
 * treated as an invalid selection attempt and re-sent the same "responde 1, 2 o 3" reminder,
 * including an explicit "Cancelar". This detector is checked BEFORE parseSlotSelection is even
 * called, so a genuine abandon-intent message never reaches the selection parser at all.
 *
 * Intentional overlap with cancellation-intent-detection.ts's bare "cancelar"/"cancela" patterns:
 * the same word means "stop this" in both contexts, but each detector is checked in a disjoint
 * lead-status context (BOOKING_PENDING here vs BOOKED/CANCEL_PENDING there) and drives a
 * DIFFERENT action (abandon the pending booking process, no appointment ever existed, here vs
 * cancel a real, already-BOOKED appointment via AppointmentCancellationService there) -- never
 * both evaluated for the same turn. Verified non-collision with reschedule-intent-detection.ts's
 * RESCHEDULE_PATTERNS and new-booking-intent-detection.ts's NEW_BOOKING_PATTERNS (no "reagendar"/
 * "agendar" substrings below).
 */
const BOOKING_ABANDON_PATTERNS: RegExp[] = [
  /\bcancelar\b/i,
  /\bcancela\b/i,
  /\bsalir\b/i,
  /\bya no\b/i,
  /\bno quiero\b/i,
  /\bmejor no\b/i,
  /\bahora no\b/i,
];

export function isBookingAbandonRequest(text: string): boolean {
  return BOOKING_ABANDON_PATTERNS.some((pattern) => pattern.test(text));
}
