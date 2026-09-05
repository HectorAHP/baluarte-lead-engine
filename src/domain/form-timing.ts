/**
 * Fase 7B -- form-fill timing heuristic (spec item 25). A signal only, never a blocking rule on
 * its own (the spec is explicit: "No bloquear únicamente por tiempo") -- see
 * lead-integrity-score.ts for how this feeds into the broader score instead of gating anything by
 * itself.
 */
const MIN_PLAUSIBLE_FORM_FILL_MS = 2500;

export function isSuspiciouslyFastSubmission(formStartedAt: Date, submittedAt: Date, minPlausibleMs: number = MIN_PLAUSIBLE_FORM_FILL_MS): boolean {
  const elapsedMs = submittedAt.getTime() - formStartedAt.getTime();
  // A negative elapsed time (submittedAt before formStartedAt -- clock skew, a forged timestamp,
  // or a malformed client) is at least as suspicious as "too fast", never treated as "plenty of
  // time".
  return elapsedMs < minPlausibleMs;
}
