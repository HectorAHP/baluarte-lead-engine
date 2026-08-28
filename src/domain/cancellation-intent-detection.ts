/**
 * Deterministic, keyword-based detection of a cancellation request -- never delegated to an LLM,
 * same safety posture as opt-out-detection.ts and qualification-handoff-triggers.ts. Only ever
 * checked for a lead currently BOOKED/CANCELLED (see whatsapp-cancellation-handler.ts,
 * whatsapp-inbound-service.ts, whatsapp-reactivation-handler.ts), so the narrow routing context
 * already bounds false-positive risk.
 *
 * PRE-LAUNCH REGRESSION FIX: same root cause and same fix shape as
 * reschedule-intent-detection.ts's `\breagendar\b` fix -- a bare "Cancelar" (no "cita" alongside
 * it, no "quiero" prefix) previously matched NO pattern here, which meant it fell through to the
 * BOOKED generic fallback in whatsapp-inbound-service.ts instead of reaching
 * WhatsAppCancellationHandler. `\bcancelar\b` / `\bcancela\b` below replace the old
 * `cancelar\s+(mi\s+)?cita` / `cancela\s+(mi\s+)?cita` / `quiero\s+cancelar` trio (fully subsumed
 * -- all three still match, plus each bare verb form alone), already case-insensitive (`/i`) and
 * naturally trim-tolerant. The narrow BOOKED/CANCELLED-lead routing context this is exclusively
 * used in (see call sites above) is exactly what makes a bare "cancelar" unambiguous here, even
 * though it would be too broad a signal to act on outside that context.
 *
 * Verified non-collision with opt-out-detection.ts's OPT_OUT_PATTERNS: its only "cancelar" entry
 * is the exact substring "cancelar mensajes", and isOptOutMessage is checked unconditionally
 * BEFORE any status-based routing in whatsapp-inbound-service.ts, so a message matching that
 * opt-out phrase is always claimed there first -- isCancellationRequest is never even evaluated
 * for it.
 */
const CANCELLATION_PATTERNS: RegExp[] = [
  /\bcancelar\b/i,
  /\bcancela\b/i,
  /ya no puedo asistir/i,
  /ya no puedo ir/i,
];

export function isCancellationRequest(text: string): boolean {
  return CANCELLATION_PATTERNS.some((pattern) => pattern.test(text));
}
