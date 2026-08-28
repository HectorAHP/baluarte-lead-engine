/**
 * Deterministic, keyword-based detection of a NEW-booking request -- never delegated to an LLM,
 * same safety posture as reschedule-intent-detection.ts / cancellation-intent-detection.ts. Only
 * ever checked for a lead currently CANCELLED (see WhatsAppReactivationHandler) -- explicitly NOT
 * used for a BOOKED lead (that lead already has an active appointment; "quiero agendar" from a
 * BOOKED lead falls through to the generic BOOKED fallback, never triggers a second booking).
 *
 * Verified non-collision with cancellation-intent-detection.ts's CANCELLATION_PATTERNS (no
 * "cancelar"/"cancela" substrings below) and reschedule-intent-detection.ts's RESCHEDULE_PATTERNS
 * (no "reagendar"/"cambiar" substrings below -- WhatsAppReactivationHandler checks
 * isRescheduleRequest BEFORE isNewBookingRequest for a CANCELLED lead, so "quiero reagendar" is
 * always classified as reschedule-after-cancel, never generic new-booking, regardless of any
 * lexical overlap). The `\b` word boundaries below specifically prevent "agendar cita" from
 * matching as a false-positive substring inside "reagendar cita".
 */
const NEW_BOOKING_PATTERNS: RegExp[] = [
  /quiero\s+agendar/i,
  /quiero\s+(una\s+)?nueva\s+cita/i,
  /quiero\s+volver\s+a\s+agendar/i,
  /\bagendar\s+(una\s+)?cita/i,
  /quiero\s+una\s+cita/i,
];

export function isNewBookingRequest(text: string): boolean {
  return NEW_BOOKING_PATTERNS.some((pattern) => pattern.test(text));
}
