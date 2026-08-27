/**
 * Deterministic, keyword-based escalation triggers for the qualification flow -- distinct from
 * health-redaction.ts (medical content) and opt-out-detection.ts (do-not-contact), both of which
 * the qualifier reuses separately. Same safety posture: over-flagging to a human is the safe
 * failure mode, under-flagging is not.
 */
export type HandoffReason =
  | "COMPLAINT_OR_CLAIM"
  | "REQUESTS_HUMAN"
  | "FISCAL_ADVICE_REQUEST"
  | "AGGRESSIVE"
  | "OUT_OF_SCOPE_EXCEPTION";

const TRIGGERS: Array<{ reason: HandoffReason; patterns: RegExp[] }> = [
  {
    reason: "COMPLAINT_OR_CLAIM",
    patterns: [/queja/i, /reclamaci[oó]n/i, /siniestro/i, /demanda/i, /fraude/i, /estafa/i],
  },
  {
    reason: "REQUESTS_HUMAN",
    patterns: [/hablar con (una persona|alguien|un asesor|un humano)/i, /quiero un asesor/i, /pasame con (héctor|hector)/i, /no quiero hablar con un robot/i, /no eres una persona/i],
  },
  {
    reason: "FISCAL_ADVICE_REQUEST",
    patterns: [/cu[aá]nto (me )?puedo deducir/i, /cu[aá]nto ahorro de impuestos/i, /asesor[ií]a fiscal/i, /declaraci[oó]n de impuestos/i],
  },
  {
    reason: "AGGRESSIVE",
    patterns: [/est[uú]pid[oa]/i, /idiota/i, /in[uú]til/i, /pinche/i, /maldit[oa]/i],
  },
  {
    reason: "OUT_OF_SCOPE_EXCEPTION",
    patterns: [/caso especial/i, /excepci[oó]n/i, /an[aá]lisis (personalizado|especial)/i],
  },
];

export function detectHandoffTrigger(rawText: string): HandoffReason | null {
  for (const trigger of TRIGGERS) {
    if (trigger.patterns.some((pattern) => pattern.test(rawText))) return trigger.reason;
  }
  return null;
}
