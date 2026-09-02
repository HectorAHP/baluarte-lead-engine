/**
 * Fase 6B -- deterministic, keyword-based detection of whether an inbound WhatsApp message
 * suggests the sender is following up on the fiscal calculator (impuestos.html) -- either the
 * exact prefilled CTA text ("Hola, acabo de realizar mi estimación fiscal en Baluarte Capital y
 * quiero revisar mi resultado.") or a close variant that still names the estimation. Never
 * delegated to an LLM (AI_PROVIDER stays unused for this) -- same determinism principle as
 * isOptOutMessage/isCancellationRequest/isRescheduleRequest.
 *
 * Used ONLY to decide whether the very first welcome reply may acknowledge fiscal-calculator
 * origin (see buildFiscalContextWelcomeMessage in message-templates.ts) -- never to change lead
 * status, score, or any other lifecycle field, and never on its own (a FiscalLeadContext must
 * ALSO have been recovered -- see whatsapp-inbound-service.ts).
 */
const FISCAL_CALCULATOR_ORIGIN_PATTERNS: RegExp[] = [
  /estimaci[oó]n fiscal/i,
  /calculadora fiscal/i,
  /revisar mi resultado/i,
];

export function looksLikeFiscalCalculatorOrigin(text: string): boolean {
  return FISCAL_CALCULATOR_ORIGIN_PATTERNS.some((pattern) => pattern.test(text));
}
