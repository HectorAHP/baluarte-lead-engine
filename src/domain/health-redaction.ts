/**
 * Keyword/pattern heuristic, not clinical NLP -- and deliberately not an LLM or external
 * service (never send message content off-box for a safety classification). Baluarte Lead
 * Engine only needs enough of a qualification signal to route to a human; it must never analyze
 * or store detailed health content. False positives (over-redacting) are the safe failure mode
 * here; false negatives are not, so the patterns are intentionally broad.
 *
 * This is the ONLY place medical-content detection is defined. Both the global inbound safety
 * boundary (message-ingestion.ts, run for every WhatsApp message before any commercial logic
 * sees it) and QualificationEngine's own GMM-scoped defense-in-depth check import and call this
 * same function -- there is no second, divergent list anywhere else in the codebase.
 *
 * Patterns are grouped for auditability, not because the grouping changes behavior (all three
 * groups are checked together):
 *   A) INDICATOR_TERMS    -- clinical nouns/conditions on their own (a diagnosis, a drug class,
 *                            a procedure) that are essentially never used in ordinary commercial
 *                            conversation about buying insurance.
 *   B) HEALTH_STATE_PHRASES -- first-person phrasing that announces a health status ("tengo...",
 *                            "padezco...", "me diagnosticaron...", "me operaron...") combined
 *                            with a term specific enough not to catch ordinary commercial
 *                            sentences ("tengo seguro", "tengo un presupuesto" must NOT match).
 *   C) COMMON_PATTERNS    -- everyday ways people describe symptoms/procedures without naming a
 *                            diagnosis (back pain, an operation, being pregnant).
 *
 * Each accented term is listed alongside its unaccented form (WhatsApp input arrives with mixed
 * accent usage and this function does not normalize the body before matching, to keep behavior
 * identical to the redacted copy actually stored).
 */
const INDICATOR_TERMS: RegExp[] = [
  /diagnostic/i,
  /diagnóstic/i,
  /ciática/i,
  /ciatica/i,
  /hernia/i,
  /columna/i,
  /lumbago/i,
  /\blumbar/i,
  /cáncer/i,
  /\bcancer\b/i,
  /diabetes/i,
  /\bvih\b/i,
  /\bsida\b/i,
  /hipertensión/i,
  /hipertension/i,
  /cirrosis/i,
  /hepatitis/i,
  /medicamento/i,
  /medicación/i,
  /medicacion/i,
  /receta médica/i,
  /receta medica/i,
  /cirugía/i,
  /cirugia/i,
  /resultados? de laboratorio/i,
  /análisis clínic/i,
  /analisis clinic/i,
  /biopsia/i,
  /quimioterapia/i,
  /radioterapia/i,
  /insulina/i,
  /tumor/i,
  /historial clínico/i,
  /historial clinico/i,
  /expediente médico/i,
  /expediente medico/i,
  /embarazada/i,
  /embarazo/i,
  /lesión/i,
  /\blesion\b/i,
];

const HEALTH_STATE_PHRASES: RegExp[] = [
  /me diagnosticaron/i,
  /padezco/i,
  /sufro de/i,
  /me operaron/i,
  /me encontraron/i,
  /tengo (una |un )?enfermedad/i,
  /tengo (una |un )?padecimiento/i,
  /tengo (una |un )?lesión/i,
  /tengo (una |un )?lesion/i,
  /tengo problema(s)? de salud/i,
  /enfermedad (crónica|cronica|terminal|renal|cardiaca|hepática|hepatica)/i,
  /operación (de|del)/i,
  /operacion (de|del)/i,
];

const COMMON_PATTERNS: RegExp[] = [
  /me duele/i,
  /tengo dolor/i,
  /dolor lumbar/i,
  /problemas? de columna/i,
  /estoy en tratamiento/i,
  /tratamiento (de|para|contra)/i,
  /estoy embarazada/i,
  /tuve (una )?cirugía/i,
  /tuve (una )?cirugia/i,
];

const SENSITIVE_HEALTH_PATTERNS: RegExp[] = [...INDICATOR_TERMS, ...HEALTH_STATE_PHRASES, ...COMMON_PATTERNS];

export const HEALTH_REDACTION_PLACEHOLDER = "[INFORMACIÓN MÉDICA SENSIBLE REDACTADA]";

export interface HealthRedactionResult {
  sensitiveDetected: boolean;
  redactedBody: string;
  /** Only ever { sensitive_content_detected: true, category: "HEALTH" } -- never the raw content. */
  metadata: Record<string, unknown>;
}

export function redactSensitiveHealthContent(body: string): HealthRedactionResult {
  const detected = SENSITIVE_HEALTH_PATTERNS.some((pattern) => pattern.test(body));
  if (!detected) {
    return { sensitiveDetected: false, redactedBody: body, metadata: {} };
  }
  return {
    sensitiveDetected: true,
    redactedBody: HEALTH_REDACTION_PLACEHOLDER,
    metadata: { sensitive_content_detected: true, category: "HEALTH" },
  };
}
