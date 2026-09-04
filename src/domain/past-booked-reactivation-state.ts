import type { Message } from "./message.js";

/**
 * Fase 6E.2 -- opaque outbound-message marker for the past-booked-recovery flow's generic
 * fallback (PAST_BOOKED_GENERIC_INBOUND_MESSAGE), mirroring qualified-lead-menu-state.ts's
 * qualifiedMainMenuMetadata()/qualifiedOptionsMenuMetadata() exactly: same `expectedIntent` key,
 * never PII, never score/band data.
 *
 * Fase 6E.3: NOW consumed by hasPastBookedReactivationBeenShown() below, which is what makes
 * "show PAST_BOOKED_GENERIC_INBOUND_MESSAGE only once per reactivation episode" possible (Fase
 * 6E.3 spec, item 6) -- see that function's doc comment. Fase 6E.2's own doc comment here
 * originally said nothing resolves this marker; that's now out of date.
 */
const EXPECTED_INTENT_KEY = "expectedIntent";
const PAST_BOOKED_REACTIVATION_MARKER = "PAST_BOOKED_REACTIVATION";

export function pastBookedReactivationMetadata(): Record<string, unknown> {
  return { [EXPECTED_INTENT_KEY]: PAST_BOOKED_REACTIVATION_MARKER };
}

/**
 * Fase 6E.3 -- scans the FULL outbound history (never just the last message -- contrast with
 * resolvePendingQualifiedMenu/resolvePendingTopicFollowup, which only need the immediately
 * preceding turn) for ANY prior PAST_BOOKED_GENERIC_INBOUND_MESSAGE, so the lead is shown that
 * message at most once per reactivation episode: once they've engaged with ANYTHING else
 * (a real question, "opciones", "agendar"), a LATER genuinely-unrecognized reply falls back to
 * the topic-agnostic QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE instead of repeating "tu cita anterior
 * ya pasó" -- see WhatsAppPastBookedRecoveryHandler and the Fase 6E.3 report, item 6.
 *
 * No new table/column: message history already carries this signal via the existing metadata
 * convention (task instruction: "No agregar columnas ni migraciones si puede resolverse con
 * metadata").
 */
export function hasPastBookedReactivationBeenShown(messages: readonly Message[]): boolean {
  return messages.some((m) => m.direction === "OUTBOUND" && m.metadata?.[EXPECTED_INTENT_KEY] === PAST_BOOKED_REACTIVATION_MARKER);
}
