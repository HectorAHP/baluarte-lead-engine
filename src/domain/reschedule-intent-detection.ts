/**
 * Deterministic, keyword-based detection of a reschedule request -- never delegated to an LLM,
 * same safety posture as cancellation-intent-detection.ts / opt-out-detection.ts. Only ever
 * checked for a lead currently BOOKED (see whatsapp-inbound-service.ts, checked BEFORE
 * isCancellationRequest for that same turn), so the narrow routing context already bounds
 * false-positive risk.
 *
 * PRE-LAUNCH REGRESSION FIX: a real smoke-test lead sent the single bare word "Reagendar" (no
 * "quiero" prefix, no "cita" suffix) and it fell through to the BOOKED generic fallback instead of
 * triggering WhatsAppRescheduleHandler -- the old pattern list required one of those two extra
 * words alongside "reagendar" and had no standalone-word pattern at all. `\breagendar\b` below
 * replaces the old `quiero\s+reagendar` / `reagendar\s+(mi\s+)?cita` pair (which it fully subsumes
 * -- both still match, plus the bare word alone) and is already case-insensitive (`/i`) and
 * naturally trim-tolerant (an unanchored regex matches "reagendar" as a substring regardless of
 * surrounding whitespace, so "  Reagendar  " needs no separate normalization step).
 *
 * This is the SOLE detector for reschedule intent -- whatsapp-inbound-service.ts's BOOKED routing
 * check and whatsapp-reactivation-handler.ts's CANCELLED-lead reframing check both call this same
 * function, never a second/divergent parser, so this one fix covers both call sites at once.
 *
 * Verified non-collision with cancellation-intent-detection.ts's CANCELLATION_PATTERNS: none of
 * these patterns contain "cancelar"/"cancela", and none of CANCELLATION_PATTERNS' phrases
 * ("cancelar/cancela cita", bare "cancelar"/"cancela", "ya no puedo asistir/ir") match any pattern
 * here. Also verified non-collision with opt-out-detection.ts's OPT_OUT_PATTERNS (no "baja"/
 * "stop"/"detener"/"cancelar mensajes"/"no me escriban"/"no me contacten" substrings anywhere
 * below) and with new-booking-intent-detection.ts's NEW_BOOKING_PATTERNS (no "agendar" substring
 * below -- "reagendar" and "agendar" share no common regex token here).
 */
const RESCHEDULE_PATTERNS: RegExp[] = [
  /quiero\s+cambiar\s+(mi\s+)?cita/i,
  /\breagendar\b/i,
  /cambiar\s+(mi\s+)?horario/i,
  /no puedo a esa hora/i,
];

export function isRescheduleRequest(text: string): boolean {
  return RESCHEDULE_PATTERNS.some((pattern) => pattern.test(text));
}
