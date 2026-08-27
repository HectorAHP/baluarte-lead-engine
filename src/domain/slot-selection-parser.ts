import type { OfferedSlot } from "./offered-slot.js";
import { assertSingleActiveRound } from "./active-offer-consistency.js";

export type SlotSelectionResult =
  | { type: "SELECTED"; slot: OfferedSlot }
  | { type: "DECLINED" }
  | { type: "INVALID" };

/**
 * Closed, deterministic list -- never a fuzzy/NLP match. Compared against the FULLY normalized
 * inbound text (accent-stripped, lowercased, trimmed, internal whitespace collapsed), so
 * "Ningún horario", "ningun  horario", and "NINGUN HORARIO" all match the same entry here.
 */
const DECLINED_PHRASES: ReadonlySet<string> = new Set([
  "ninguno",
  "ninguna",
  "ningun horario",
  "otro horario",
  "otros horarios",
  "prefiero otro",
  "prefiero otro horario",
  "ninguno me funciona",
]);

/**
 * Matches ONLY a bare positive integer, optionally preceded by one of a small, closed set of
 * trivial lead-in words ("opcion ", "la ", "el "). Anchored at both ends (^...$) so a number
 * embedded anywhere inside a longer message ("tengo 10 años", "cp 10500") never matches -- the
 * ENTIRE normalized message must be nothing but the lead-in (if any) plus the digits.
 */
const SELECTION_PATTERN = /^(?:opcion |la |el )?([1-9]\d*)$/;

/** lowercase, trim, collapse internal whitespace, and strip accents ("razonablemente", per the
 * Phase 3C spec) so "Opción 1", "opcion  1", and "OPCIÓN 1" are all treated identically. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // strip accents (combining marks left behind by NFD)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * 100% deterministic, side-effect-free. Given the raw inbound text and the conversation's
 * currently active offered slots, decides whether the lead selected one of them, explicitly
 * declined all of them, or sent something that maps to neither.
 *
 * Guards, in order:
 *  1. All of `activeSlots` must belong to one round_id (assertSingleActiveRound, shared with
 *     SlotOfferingService) -- throws ActiveOfferInconsistentError otherwise. Never silently
 *     picks one round and ignores the other.
 *  2. DECLINED: an exact match (after normalization) against a closed phrase list.
 *  3. SELECTED: the normalized text is nothing but a bare number (optionally "opcion "/"la "/"el "
 *     prefixed) that maps to an active slot's `position` -- and that slot must independently
 *     satisfy `selected === false && expiresAt > now` (never trust an expired/already-selected
 *     slot just because it's present in the input array -- this is the parser's OWN
 *     revalidation, not delegated to the caller).
 *  4. Anything else -- including a number that doesn't match any active position (e.g. "10"
 *     when only positions 1-3 exist), and any prose/ambiguous text -- is INVALID.
 */
export function parseSlotSelection(inboundText: string, activeSlots: OfferedSlot[], now: Date): SlotSelectionResult {
  const conversationId = activeSlots[0]?.conversationId ?? "";
  assertSingleActiveRound(conversationId, activeSlots);

  const normalized = normalize(inboundText);

  if (DECLINED_PHRASES.has(normalized)) {
    return { type: "DECLINED" };
  }

  const match = SELECTION_PATTERN.exec(normalized);
  if (!match) {
    return { type: "INVALID" };
  }

  const position = Number(match[1]);
  const slot = activeSlots.find((s) => s.position === position && s.selected === false && s.expiresAt > now);
  if (!slot) {
    return { type: "INVALID" };
  }

  return { type: "SELECTED", slot };
}
