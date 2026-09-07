/**
 * Fase 7J -- deterministic, keyword-based detection of a trivial social acknowledgement
 * ("gracias", "ok", "👍", ...). Never an LLM, same safety posture as every other intent detector
 * in this codebase (cancellation-intent-detection.ts, reschedule-intent-detection.ts).
 *
 * Purpose: this is the ONE carve-out from Fase 7J's "if nothing else consumed this message,
 * escalate to a human" rule (see whatsapp-inbound-service.ts's final fallback and
 * WhatsAppBookingHandler's BOOKING_PENDING INVALID-selection branch, its two call sites). A lead
 * closing out a turn with a bare "gracias"/"ok"/"👍" is not raising an unresolved question --
 * escalating them to a human, or inventing a reply, would be actively wrong. This function exists
 * ONLY to recognize that narrow case; it is deliberately an EXACT-match, closed list, never a
 * substring/fuzzy match, so it can never accidentally swallow a real question that merely
 * contains one of these words (e.g. "ok pero tengo una duda" is NOT an acknowledgement here).
 */
const ACKNOWLEDGEMENT_PHRASES: ReadonlySet<string> = new Set([
  "gracias",
  "muchas gracias",
  "ok",
  "okay",
  "va",
  "perfecto",
  "listo",
  "entendido",
  "excelente",
  "de acuerdo",
  "sale",
  "👍",
]);

/** lowercase, trim, collapse internal whitespace, strip accents, strip trailing punctuation --
 * the exact same normalization convention every other closed-list parser in this codebase already
 * uses (see e.g. cancel-confirmation-parser.ts's own `normalize`). */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,!¡¿?]+$/g, "")
    .trim();
}

export function isSocialAcknowledgement(text: string): boolean {
  return ACKNOWLEDGEMENT_PHRASES.has(normalize(text));
}

/**
 * A bare greeting/opener ("hola", "buenas", "hey", ...) -- distinct from an acknowledgement (this
 * is the START of a turn, not the end of one), but the same reasoning applies: it carries no
 * semantic content of its own to classify, so it is never grounds for escalating to a human or
 * repeating a menu. Same exact-match, closed-list discipline as isSocialAcknowledgement above --
 * "Hola, tengo una duda sobre mi seguro" is NOT a bare greeting here, only the literal opener
 * alone is.
 */
const GREETING_PHRASES: ReadonlySet<string> = new Set([
  "hola",
  "hi",
  "hello",
  "hey",
  "buenas",
  "buenos dias",
  "buenas tardes",
  "buenas noches",
]);

export function isBareGreeting(text: string): boolean {
  return GREETING_PHRASES.has(normalize(text));
}

/**
 * A bare expression of indecision ("no sé", "cualquiera", "no importa", ...) in reply to a
 * slot-selection prompt -- still squarely ABOUT the active booking decision (the lead can't
 * choose, they're not raising a new, unrelated topic), so this is grouped with the other two
 * closed-list carve-outs above: never grounds to escalate a WhatsApp turn to a human, or to treat
 * it as a genuinely unrelated message. Reuses this file's shared `normalize` (exact-match only,
 * same discipline as isSocialAcknowledgement/isBareGreeting).
 */
const INDECISION_PHRASES: ReadonlySet<string> = new Set([
  "no se",
  "no se cual",
  "no se cual escoger",
  "no se cual elegir",
  "cualquiera",
  "no importa",
  "me da igual",
  "no tengo preferencia",
]);

export function isBookingIndecisionReply(text: string): boolean {
  return INDECISION_PHRASES.has(normalize(text));
}
