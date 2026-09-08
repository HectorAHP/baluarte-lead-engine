/**
 * Fase 7K -- "Sandler Booking Flow" (spec sections 14/15/16). Deterministic, closed-list
 * classification of a reply to the Sandler commitment-check question ("¿hay algo que pudiera
 * impedirte conectarte el <dia> a las <hora>?"). NEVER an LLM -- same posture as every other
 * intent/reply parser in this codebase (cancellation-intent-detection.ts,
 * social-acknowledgement-detection.ts, slot-selection-parser.ts, ...).
 *
 * Three outcomes:
 *  - "CONFIRMED": no foreseeable impediment -- proceed to final revalidation + booking.
 *  - "OBSTACLE": a foreseeable impediment -- do NOT book; offer to look at other options.
 *  - "AMBIGUOUS": neither list matches -- caller asks ONE clarifying question (see spec section
 *    16); a second AMBIGUOUS in a row escalates via the existing UNKNOWN_INTENT_HANDOFF path.
 *
 * IMPORTANT domain-specific collision: spec section 14 lists "seguro" as a positive-commitment
 * word (colloquial "sure/certainly"). This business's own product IS insurance ("seguro"), so a
 * naive `\bseguro\b` substring match would also fire on a genuine new question like "¿cuánto
 * cuesta el seguro de auto?" -- silently booking instead of answering the question, a materially
 * worse failure than an AMBIGUOUS clarification. "seguro" is therefore matched ONLY as the
 * bare/near-bare whole reply (see CONFIRMED_PATTERNS below), the same anchoring already used for
 * "no" -- never as a substring of a longer message.
 */
export type CommitmentReplyClassification = "CONFIRMED" | "OBSTACLE" | "AMBIGUOUS";

// Section 14 -- verbatim positive-commitment phrases (no foreseeable impediment).
const CONFIRMED_PATTERNS: RegExp[] = [
  /^no$/,
  /\bno,?\s+todo\s+bien\b/,
  /\bninguno\b/,
  /\bninguna\b/,
  /\bsin\s+problema\b/,
  /\bsin\s+inconveniente\b/,
  /\bahi\s+estare\b/,
  /\balli\s+estare\b/,
  /\bme\s+funciona\b/,
  /\bconfirmado\b/,
  /^seguro$/, // bare affirmation only -- see the collision note above; never a substring match
  /\btodo\s+bien\b/,
];

// Section 15 -- verbatim obstacle phrases (a foreseeable impediment).
const OBSTACLE_PATTERNS: RegExp[] = [
  /\btal\s+vez\s+tenga\s+junta\b/,
  /\bdepende\s+del\s+trabajo\b/,
  /\bquiza\b/,
  /\bquizas\b/,
  /\bno\s+estoy\s+segur[oa]\b/,
  /\bpuede\s+surgir\s+algo\b/,
  /\bpodria\s+complicarse\b/,
  /\btal\s+vez\s+no\s+pueda\b/,
];

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function classifyCommitmentReply(text: string): CommitmentReplyClassification {
  const working = normalize(text);
  // Obstacle checked first: "no estoy seguro" contains "no" but is an obstacle, not a bare
  // confirmation -- CONFIRMED's own `/^no$/` only matches an EXACT bare "no", so there is no
  // real collision here, but obstacle-first keeps the precedence explicit and future-proof if a
  // pattern is ever loosened.
  if (OBSTACLE_PATTERNS.some((p) => p.test(working))) return "OBSTACLE";
  if (CONFIRMED_PATTERNS.some((p) => p.test(working))) return "CONFIRMED";
  return "AMBIGUOUS";
}
