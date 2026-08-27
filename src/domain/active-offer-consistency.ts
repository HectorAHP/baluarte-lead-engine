import type { OfferedSlot } from "./offered-slot.js";
import { ActiveOfferInconsistentError } from "./errors.js";

/**
 * Shared, pure round-consistency guard. Used by BOTH SlotOfferingService (before reusing or
 * replacing an offer) and slot-selection-parser (before interpreting a reply against a set of
 * active slots) -- extracted here so both call sites enforce the exact same "never mix two
 * rounds' options" rule via the exact same code, not two independent reimplementations that
 * could silently drift apart. Never picks one round and discards the other -- always throws.
 */
export function assertSingleActiveRound(conversationId: string, activeSlots: OfferedSlot[]): void {
  if (activeSlots.length === 0) return;
  const roundIds = new Set(activeSlots.map((s) => s.roundId));
  if (roundIds.size > 1) {
    throw new ActiveOfferInconsistentError(conversationId, [...roundIds]);
  }
}
