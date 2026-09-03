import type { Message } from "./message.js";

/**
 * Fase 6C -- the ONE piece of ephemeral "what was the user just shown" state the qualified-lead
 * conversation router needs. Deliberately a single flag, not a full state machine: "MAIN" means
 * the most recent outbound message ended with the QUALIFIED_A/B/NURTURE_C main menu (so a bare
 * "1"/"2"/"3" reply is interpretable), null means it didn't (so a bare digit is ambiguous/unknown
 * -- never misread as a menu choice for a menu that was never actually shown).
 *
 * Reconstructed from the conversation's real message history (the last OUTBOUND row's metadata),
 * never stored as its own snapshot -- same "reconstruct from durable facts, don't cache opaque
 * state" principle as qualification-state-reconstruction.ts's reconstructQualificationState.
 * No migration: messages.metadata already exists and already holds arbitrary small JSON (see
 * health-redaction.ts's sensitive_content_detected marker, and Fase 6B's
 * origin/fiscalContextAvailable marker).
 */
export type QualifiedLeadPendingMenu = "MAIN";

const EXPECTED_INTENT_KEY = "expectedIntent";
const MAIN_MENU_MARKER = "QUALIFIED_MAIN_MENU";

/** Metadata to attach to an outbound message that ends with the main menu -- never PII, never a
 * score/band, just an opaque state identifier. */
export function qualifiedMainMenuMetadata(): Record<string, unknown> {
  return { [EXPECTED_INTENT_KEY]: MAIN_MENU_MARKER };
}

/**
 * Looks at the most recent OUTBOUND message in `messages` (a conversation's message history,
 * fetched BEFORE persisting the current inbound turn's eventual reply) and returns "MAIN" only
 * when that message was marked via qualifiedMainMenuMetadata() above.
 *
 * `messages` MUST already be in ascending chronological order -- exactly
 * MessageRepository.listByConversationId's documented contract (both the InMemory and Supabase
 * implementations order ascending by created_at; see their own doc comments/`.order(...)`
 * calls). Deliberately does NOT re-sort descending by createdAt itself: two messages persisted in
 * the same request/test can legitimately share an identical millisecond timestamp, and a second,
 * independent sort with different tie-breaking than the repository's own would then be free to
 * silently reorder them -- taking the array's own last element avoids introducing that instability.
 */
export function resolvePendingQualifiedMenu(messages: readonly Message[]): QualifiedLeadPendingMenu | null {
  const outboundMessages = messages.filter((m) => m.direction === "OUTBOUND");
  const lastOutbound = outboundMessages[outboundMessages.length - 1];
  if (!lastOutbound) return null;
  return lastOutbound.metadata?.[EXPECTED_INTENT_KEY] === MAIN_MENU_MARKER ? "MAIN" : null;
}
