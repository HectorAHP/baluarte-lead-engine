import type { Daypart } from "./date-preference.js";

/**
 * Fase 7K -- "Sandler Booking Flow" (spec sections 2/3/4). Parses a reply to Lia's own daypart
 * question ("¿te acomoda mejor por la manana o por la tarde?") into a Daypart, or `null` when the
 * reply doesn't answer that question at all (a genuinely different message -- a question, a
 * greeting, an explicit date, etc; the caller decides what to do with `null`, e.g. run the
 * existing Fase 7J/7J.1 classifier before escalating).
 *
 * Deliberately a SEPARATE, additive module -- never a modification of date-preference-parser.ts.
 * That parser's own DAYPART_PATTERNS already recognizes "por/en la manana"/"por/en la tarde" and
 * this module accepts those too, but it ALSO accepts bare "manana"/"tarde"/"1"/"2"/"temprano",
 * which date-preference-parser.ts deliberately does NOT (there, bare "manana" means the relative
 * date "tomorrow" -- see its own step 2 -- and a bare "1"/"2" is parseSlotSelection's territory).
 * That ambiguity is exactly section 4 of the spec: "manana" means MORNING only when this function
 * is invoked, i.e. only in the caller's AWAITING_DAYPART_PREFERENCE state -- everywhere else,
 * parseDatePreference's own unchanged tomorrow-semantics apply. This module never runs unless the
 * caller has already confirmed that state, so it never needs to re-derive that context itself; it
 * only documents the assumption.
 */
const MORNING_PATTERNS: RegExp[] = [
  /^1$/,
  /\bpor\s+la\s+manana\b/,
  /\ben\s+la\s+manana\b/,
  /\bmanana\b/,
  /\btemprano\b/,
];

const AFTERNOON_PATTERNS: RegExp[] = [
  /^2$/,
  /\bpor\s+la\s+tarde\b/,
  /\ben\s+la\s+tarde\b/,
  /\btarde\b/,
];

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * @param text raw WhatsApp free text (the reply to the daypart question).
 * @returns "MORNING" | "AFTERNOON" | null. EVENING is never returned here -- section 9 of the
 *   spec: the initial daypart question only ever offers morning/afternoon, even though EVENING
 *   remains a valid DatePreference value elsewhere (e.g. an explicit "por la noche" typed
 *   unprompted still goes through parseDatePreference as before).
 */
export function parseDaypartReply(text: string): Daypart | null {
  const working = normalize(text);
  if (MORNING_PATTERNS.some((p) => p.test(working))) return "MORNING";
  if (AFTERNOON_PATTERNS.some((p) => p.test(working))) return "AFTERNOON";
  return null;
}
