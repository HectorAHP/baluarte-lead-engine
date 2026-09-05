import type { Message } from "./message.js";

/**
 * Fase 7A -- pending-state marker for "the lead was just sent a 24h reminder that asks them to
 * confirm attendance" -- same "opaque expectedIntent marker on the last OUTBOUND message,
 * resolved by reading ONLY that most-recent message" convention already used by
 * qualified-lead-menu-state.ts / qualified-lead-topic-followup.ts / past-booked-reactivation-state.ts /
 * fiscal-welcome-menu-state.ts. Never conflate this with any of those -- this one owns exactly one
 * concern: "does a bare affirmative reply right now mean 'yes, I'll attend'".
 *
 * Why this can't just be "any BOOKED lead's affirmative reply confirms the appointment": a BOOKED
 * lead who has never been sent a reminder saying "sí" to something else entirely (a stray "sí" to
 * a generic question, or to nothing at all) must never silently flip their appointment to
 * CONFIRMED. The marker is what makes "sí" mean something specific and time-bounded, exactly the
 * same self-invalidation property already relied on for every other pending-menu state in this
 * codebase: once a NEWER outbound message is sent (any of them, not just this one), a stale
 * "sí" typed against an old, already-superseded reminder no longer resolves to anything, because
 * resolvePendingAppointmentConfirmation only ever looks at the single most recent OUTBOUND
 * message.
 */
const EXPECTED_INTENT_KEY = "expectedIntent";
const APPOINTMENT_CONFIRMATION_MARKER = "APPOINTMENT_CONFIRMATION";

/** Metadata to attach to the 24h reminder's own outbound message -- never PII, never score/band,
 * just an opaque state identifier (same contract as every other *Metadata() function in this
 * codebase). */
export function appointmentConfirmationMetadata(): Record<string, unknown> {
  return { [EXPECTED_INTENT_KEY]: APPOINTMENT_CONFIRMATION_MARKER };
}

/** Looks at the most recent OUTBOUND message and returns true only when it was marked via
 * appointmentConfirmationMetadata() above. Same ascending-order contract as every other
 * resolvePending*() in this codebase -- see qualified-lead-menu-state.ts's doc comment for why no
 * re-sort happens here. */
export function resolvePendingAppointmentConfirmation(messages: readonly Message[]): boolean {
  const outboundMessages = messages.filter((m) => m.direction === "OUTBOUND");
  const lastOutbound = outboundMessages[outboundMessages.length - 1];
  if (!lastOutbound) return false;
  return lastOutbound.metadata?.[EXPECTED_INTENT_KEY] === APPOINTMENT_CONFIRMATION_MARKER;
}

/** Same normalization convention as cancel-confirmation-parser.ts / slot-selection-parser.ts:
 * lowercase, trim, collapse internal whitespace, strip accents, strip trailing punctuation. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,!¡¿?]/g, "");
}

/** Closed, deterministic list (Fase 7A spec item 5) -- never an LLM, never a broader keyword
 * match. Deliberately narrow: this is checked ONLY while a confirmation is genuinely pending (see
 * resolvePendingAppointmentConfirmation above) and only for a BOOKED lead, so false negatives
 * (an unrecognized affirmative phrasing) are safe -- they simply fall through to the existing
 * reschedule-intent / cancellation-intent / generic-BOOKED-fallback routing, unchanged. A false
 * positive would incorrectly confirm an appointment, which this list is kept narrow to avoid. */
const CONFIRM_PHRASES: ReadonlySet<string> = new Set([
  "si", // covers both "si" and "sí" -- normalize() strips accents before this Set is checked
  "confirmo",
  "confirmado",
  "ahi estare", // covers "ahí estaré" -- same accent-stripping reasoning
  "nos vemos",
  "de acuerdo",
]);

export function isAppointmentConfirmationReply(text: string): boolean {
  return CONFIRM_PHRASES.has(normalize(text));
}
