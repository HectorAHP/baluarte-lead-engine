/**
 * Deterministic, keyword-based detection of a reschedule request -- never delegated to an LLM,
 * same safety posture as cancellation-intent-detection.ts / opt-out-detection.ts. Only ever
 * checked for a lead currently BOOKED (see whatsapp-inbound-service.ts, checked BEFORE
 * isCancellationRequest for that same turn), so the narrow routing context already bounds
 * false-positive risk.
 *
 * Verified non-collision with cancellation-intent-detection.ts's CANCELLATION_PATTERNS: none of
 * these patterns contain "cancelar"/"cancela", and none of CANCELLATION_PATTERNS' phrases
 * ("cancelar/cancela cita", "quiero cancelar", "ya no puedo asistir/ir") match any pattern here.
 * Also verified non-collision with opt-out-detection.ts's OPT_OUT_PATTERNS (no "baja"/"stop"/
 * "detener"/"cancelar mensajes"/"no me escriban"/"no me contacten" substrings anywhere below).
 */
const RESCHEDULE_PATTERNS: RegExp[] = [
  /quiero\s+cambiar\s+(mi\s+)?cita/i,
  /quiero\s+reagendar/i,
  /reagendar\s+(mi\s+)?cita/i,
  /cambiar\s+(mi\s+)?horario/i,
  /no puedo a esa hora/i,
];

export function isRescheduleRequest(text: string): boolean {
  return RESCHEDULE_PATTERNS.some((pattern) => pattern.test(text));
}
