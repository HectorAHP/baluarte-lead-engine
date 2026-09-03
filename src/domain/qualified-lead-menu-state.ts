import type { Message } from "./message.js";

/**
 * Fase 6C, extended Fase 6E.1 -- the ephemeral "what was the user just shown" state the
 * qualified-lead conversation router needs. "MAIN" means the most recent outbound message ended
 * with the QUALIFIED_A/B/NURTURE_C main menu; "OPTIONS" means it ended with that menu's own
 * "2. Conocer opciones" submenu (see message-templates.ts's buildQualifiedLeadOptionsMessage).
 * null means neither, so a bare digit is ambiguous/unknown -- never misread as a menu choice for
 * a menu that was never actually shown.
 *
 * FASE 6E.1 ROOT CAUSE: this file originally only tracked "MAIN". The OPTIONS submenu's own
 * outbound message never attached ANY marker, so a reply digit sent right after it (e.g. "1" for
 * "Retiro con beneficios fiscales") resolved pendingMenu to null, detectQualifiedLeadIntent fell
 * through to UNKNOWN, and the router replied with the MAIN menu again -- the exact "vuelve al
 * MAIN MENU" bug reported in production. Fixed by giving the OPTIONS submenu its own marker,
 * below, mirroring MAIN's existing mechanism exactly.
 *
 * Reconstructed from the conversation's real message history (the last OUTBOUND row's metadata),
 * never stored as its own snapshot -- same "reconstruct from durable facts, don't cache opaque
 * state" principle as qualification-state-reconstruction.ts's reconstructQualificationState.
 * No migration: messages.metadata already exists and already holds arbitrary small JSON (see
 * health-redaction.ts's sensitive_content_detected marker, and Fase 6B's
 * origin/fiscalContextAvailable marker).
 */
export type QualifiedLeadPendingMenu = "MAIN" | "OPTIONS";

const EXPECTED_INTENT_KEY = "expectedIntent";
const MAIN_MENU_MARKER = "QUALIFIED_MAIN_MENU";
const OPTIONS_MENU_MARKER = "QUALIFIED_OPTIONS_MENU";

/** Metadata to attach to an outbound message that ends with the main menu -- never PII, never a
 * score/band, just an opaque state identifier. */
export function qualifiedMainMenuMetadata(): Record<string, unknown> {
  return { [EXPECTED_INTENT_KEY]: MAIN_MENU_MARKER };
}

/** Fase 6E.1: metadata to attach to an outbound message that ends with the "2. Conocer opciones"
 * submenu (1. Retiro / 2. Ahorro / 3. Protección, in whatever order fiscal context put them --
 * see qualified-lead-options-menu.ts). Same "opaque state identifier only" constraint as
 * qualifiedMainMenuMetadata() above -- never the actual item order, never score/band/PII; the
 * order itself is re-derived from fiscalContext at reply time, not persisted (see
 * whatsapp-inbound-service.ts and the Fase 6E.1 report). */
export function qualifiedOptionsMenuMetadata(): Record<string, unknown> {
  return { [EXPECTED_INTENT_KEY]: OPTIONS_MENU_MARKER };
}

/**
 * Looks at the most recent OUTBOUND message in `messages` (a conversation's message history,
 * fetched BEFORE persisting the current inbound turn's eventual reply) and returns "MAIN"/
 * "OPTIONS" only when that message was marked via qualifiedMainMenuMetadata()/
 * qualifiedOptionsMenuMetadata() above, or null when neither.
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
  const marker = lastOutbound.metadata?.[EXPECTED_INTENT_KEY];
  if (marker === MAIN_MENU_MARKER) return "MAIN";
  if (marker === OPTIONS_MENU_MARKER) return "OPTIONS";
  return null;
}
