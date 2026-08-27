/**
 * Deterministic, keyword-based detection of a cancellation request -- never delegated to an LLM,
 * same safety posture as opt-out-detection.ts and qualification-handoff-triggers.ts. Only ever
 * checked for a lead currently BOOKED (see whatsapp-cancellation-handler.ts), so the narrow
 * routing context already bounds false-positive risk; patterns are still kept reasonably specific
 * (require "cita" alongside "cancelar", or an explicit "ya no puedo asistir/ir") rather than
 * matching a bare "cancelar", which stays intentionally ambiguous.
 *
 * Verified non-collision with opt-out-detection.ts's OPT_OUT_PATTERNS: its only "cancelar" entry
 * is the exact substring "cancelar mensajes", which none of these patterns can match.
 */
const CANCELLATION_PATTERNS: RegExp[] = [
  /cancelar\s+(mi\s+)?cita/i,
  /cancela\s+(mi\s+)?cita/i,
  /quiero\s+cancelar/i,
  /ya no puedo asistir/i,
  /ya no puedo ir/i,
];

export function isCancellationRequest(text: string): boolean {
  return CANCELLATION_PATTERNS.some((pattern) => pattern.test(text));
}
