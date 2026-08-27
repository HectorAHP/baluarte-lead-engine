/**
 * Deterministic, keyword-based opt-out detection -- never delegated to an LLM. An LLM could be
 * prompt-injected or simply wrong about something this consequential (a missed opt-out means we
 * keep contacting someone who explicitly asked us to stop), so this is a plain regex check.
 * Some patterns (e.g. "detener", "baja") are broad and can false-positive in unrelated Spanish
 * sentences -- that's the intentional, safer failure mode (same principle as health-redaction:
 * over-flagging is acceptable, under-flagging is not).
 */
const OPT_OUT_PATTERNS: RegExp[] = [
  /no me escriban/i,
  /no me contacten/i,
  /ya no quiero informaci[oó]n/i,
  /\bbaja\b/i,
  /\bstop\b/i,
  /\bdetener\b/i,
  /cancelar mensajes/i,
];

export function isOptOutMessage(text: string): boolean {
  return OPT_OUT_PATTERNS.some((pattern) => pattern.test(text));
}
