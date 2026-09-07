import type { DatePreference } from "./date-preference.js";

/**
 * Fase 7I.2 -- CAUSE_CONTEXTUAL_RESCHEDULE_NOT_DETECTED fix. Deterministic, keyword-based
 * detection of a BOOKED lead expressing a temporal preference DIFFERENT from their current
 * appointment ("Mejor el domingo", "Prefiero el lunes") -- never an LLM, same safety posture as
 * every other intent detector in this codebase (cancellation-intent-detection.ts,
 * reschedule-intent-detection.ts).
 *
 * DELIBERATE PRODUCT DECISION (do not "fix" this by loosening it): a DatePreference ALONE is
 * NEVER sufficient to infer reschedule intent. "El 12 de septiembre" and "El sábado" are
 * genuinely ambiguous on their own -- they could be an informational question ("¿Mi cita es el
 * sábado?"), a passing reference ("Nos vemos el sábado"), or a confirmation ("Mi cita es el
 * lunes, ¿verdad?") -- all of which legitimately parse a real DatePreference (see
 * date-preference-parser.ts) without the lead wanting to change anything. Requiring an explicit
 * change/preference signal ALONGSIDE the parsed date is what keeps this from mass-triggering
 * reschedule on any message that merely mentions a day.
 *
 * This is a NEW, separate gate from isRescheduleRequest (reschedule-intent-detection.ts) --
 * deliberately never merged into it or used to loosen it. isRescheduleRequest has a second,
 * different consumer (whatsapp-reactivation-handler.ts's CANCELLED-lead reframing, where there is
 * no active appointment to protect and the ambiguity calculus is different); this function is
 * only ever checked for a BOOKED lead with exactly one active appointment
 * (whatsapp-inbound-service.ts), inserted between the explicit-reschedule check and the BOOKED
 * generic fallback.
 */
const CONTEXTUAL_CHANGE_PATTERNS: RegExp[] = [
  /\bmejor\b/,
  /\bprefiero\b/,
  /\bpreferiria\b/,
  /\bpuede ser\b/,
  /\bpodria ser\b/,
  /quiero cambiar a/,
  /quiero mover a/,
  /\botro dia\b/,
  /\botra hora\b/,
  /en vez de/,
  /\bme conviene\b/,
  /\bme gustaria\b/,
  /cambiala a/,
  /cambiarla a/,
  /moverla a/,
];

/** lowercase, trim, collapse internal whitespace, strip accents -- the exact same normalization
 * every other free-text parser in this codebase already uses (see e.g.
 * date-preference-parser.ts's own `normalize`), so "Mejor", "MEJOR", "  mejor  " and "prefería"/
 * "preferiría" are all compared identically. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * @param text raw WhatsApp free text.
 * @param datePreference the SAME parseDatePreference(text, now, timezone) result the caller
 *   already computed for this turn -- never re-derived here, so there is exactly one parse per
 *   turn and this function can never silently drift from what the reschedule handler itself will
 *   go on to use.
 *
 * Returns `true` only when BOTH:
 *  1. `datePreference` is non-null (some day/date/daypart was actually parsed), AND
 *  2. the text also contains an explicit change/preference signal (see
 *     CONTEXTUAL_CHANGE_PATTERNS) -- "mejor", "prefiero", "puede ser", "en vez de", etc.
 * A bare date/day mention with no change signal ("El 12 de septiembre", "El sábado") is
 * INTENTIONALLY `false` -- see this module's own doc comment for why.
 */
export function isContextualRescheduleRequest(text: string, datePreference: DatePreference | null): boolean {
  if (!datePreference) return false;
  const normalized = normalize(text);
  return CONTEXTUAL_CHANGE_PATTERNS.some((pattern) => pattern.test(normalized));
}
