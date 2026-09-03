/**
 * Deterministic, keyword-based detection of a NEW-booking request -- never delegated to an LLM,
 * same safety posture as reschedule-intent-detection.ts / cancellation-intent-detection.ts. Used
 * for a CANCELLED lead (WhatsAppReactivationHandler) AND, as of Fase 6E.2, a BOOKED lead whose
 * appointment is stale/past (WhatsAppPastBookedRecoveryHandler) -- NOT for a BOOKED lead with a
 * genuinely UPCOMING appointment (that lead already has an active commitment; "quiero agendar"
 * there falls through to the generic BOOKED fallback, never triggers a second booking -- see
 * whatsapp-inbound-service.ts's isUpcomingBooked-gated routing).
 *
 * FASE 6E.2 FIX: both CANCELLED_GENERIC_INBOUND_MESSAGE and PAST_BOOKED_GENERIC_INBOUND_MESSAGE
 * (message-templates.ts) explicitly tell the lead to reply with the single word "agendar" -- but
 * the original pattern list below required "quiero agendar" or "agendar (una) cita", so a bare
 * "agendar" (exactly what the copy instructed) was NEVER recognized, and the lead was shown the
 * exact same message again -- the reported production loop. Fixed by adding a bare `\bagendar\b`
 * pattern (plus "nueva cita"/"otra cita" without a "quiero" prefix, per the Fase 6E.2 spec's
 * example phrase list) -- this also fixes the identical, previously-unreported trap in the
 * CANCELLED-reactivation flow, which shares this exact function.
 *
 * Verified non-collision with cancellation-intent-detection.ts's CANCELLATION_PATTERNS (no
 * "cancelar"/"cancela" substrings below) and reschedule-intent-detection.ts's RESCHEDULE_PATTERNS
 * (no "reagendar"/"cambiar" substrings below -- WhatsAppReactivationHandler/
 * WhatsAppPastBookedRecoveryHandler both check isRescheduleRequest BEFORE isNewBookingRequest, so
 * "quiero reagendar" is always classified as reschedule-after-cancel/past, never generic
 * new-booking, regardless of any lexical overlap). The `\b` word boundaries below specifically
 * prevent "agendar" from matching as a false-positive substring inside "reagendar" (no word
 * boundary exists between the "re" and "agendar" in "reagendar" -- both are word characters).
 */
const NEW_BOOKING_PATTERNS: RegExp[] = [
  /quiero\s+agendar/i,
  /quiero\s+(una\s+)?nueva\s+cita/i,
  /quiero\s+volver\s+a\s+agendar/i,
  /\bagendar\s+(una\s+)?cita/i,
  /quiero\s+una\s+cita/i,
  // Fase 6E.2 additions -- see doc comment above.
  /\bagendar\b/i, // bare "agendar", "agendar otra", "quiero agendar una asesoría" (already covered by the first pattern too, harmlessly redundant here)
  /\bnueva\s+cita\b/i, // "nueva cita" without a "quiero" prefix
  /\botra\s+cita\b/i, // "otra cita"
];

export function isNewBookingRequest(text: string): boolean {
  return NEW_BOOKING_PATTERNS.some((pattern) => pattern.test(text));
}
