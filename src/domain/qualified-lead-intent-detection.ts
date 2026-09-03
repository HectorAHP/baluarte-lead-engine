import type { QualifiedLeadPendingMenu } from "./qualified-lead-menu-state.js";

/**
 * Fase 6C -- deterministic, keyword/menu-digit based routing for a QUALIFIED_A/QUALIFIED_B/
 * NURTURE_C lead's follow-up free text. Never delegated to an LLM (AI_PROVIDER stays unused for
 * this) -- same determinism principle as classifyIntent (Phase 3B's own welcome-menu intent
 * classifier) and every other intent-detection.ts file in this codebase. Deliberately NOT the
 * same function/type as classifyIntent: that one's menu digits (1-4) mean SAVINGS/RETIREMENT_PPR/
 * GMM/OTHER for the Phase 2 welcome menu -- a completely different menu with different digit
 * semantics. Reusing it here would silently misroute "1"/"2"/"3" for this lead's own menu.
 */
export type QualifiedLeadTopic = "PPR" | "GMM" | "SAVINGS";

export type QualifiedLeadIntent =
  | { kind: "QUESTION"; topic: QualifiedLeadTopic }
  | { kind: "EXPLORE_OPTIONS" }
  | { kind: "BOOKING" }
  /** Digit "1" against the main menu specifically -- unlike free text, a bare digit carries no
   * question content yet, so the reply must ask for one instead of answering a topic directly. */
  | { kind: "MENU_QUESTION" }
  /** Fase 6E -- "¿quién eres?" / "¿eres un bot?" / "¿con quién hablo?". Answered transparently
   * (see domain/lia-identity.ts), never treated as a topic/booking question. */
  | { kind: "IDENTITY" }
  | { kind: "UNKNOWN" };

const COMBINING_DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

function normalize(text: string): string {
  return text.normalize("NFD").replace(COMBINING_DIACRITICS, "").toLowerCase().trim();
}

// PPR/retirement and GMM are the "specific" topics; SAVINGS is the generic fallback topic --
// same "specific wins" precedence style as domain/intent-classifier.ts, simplified (no explicit
// AMBIGUOUS state here -- first match wins, since this router's own MAIN-menu fallback is
// already a safe, non-committal catch-all for any genuinely ambiguous text).
const PPR_KEYWORDS = ["ppr", "retiro", "jubil", "pension"];
const GMM_KEYWORDS = ["gmm", "gastos medicos", "seguro medico", "seguro de gastos", "hospitalizacion"];
const SAVINGS_KEYWORDS = ["ahorro", "ahorrar", "invertir", "inversion"];
const EXPLORE_OPTIONS_KEYWORDS = ["conocer opciones", "conocer las opciones", "ver opciones", "que opciones", "conocer alternativas"];
const BOOKING_KEYWORDS = ["agendar", "agenda", "cita", "asesoria"];
// Fase 6E -- checked BEFORE every other keyword list: a meta-question about Lía herself must
// never be misread as a topic/booking question, however unlikely the overlap. `normalize()`
// already strips accents (NFD), so only the unaccented form needs to be listed here.
const IDENTITY_KEYWORDS = ["quien eres", "eres un bot", "eres una ia", "eres inteligencia artificial", "eres humano", "eres humana", "eres real", "eres persona", "con quien hablo", "hablo con quien", "quien me escribe"];

/** Matches a lone menu digit (1-3 only -- this menu has exactly 3 options), tolerating
 * "opcion 1", "1.", "1)", "la 2", etc. Same shape as intent-classifier.ts's matchMenuOption. */
function matchBareDigit(normalized: string): 1 | 2 | 3 | null {
  const m = /(?:^|\s)([1-3])(?:$|[).\s,]|a\b)/.exec(` ${normalized} `);
  return m ? (Number(m[1]) as 1 | 2 | 3) : null;
}

export function detectQualifiedLeadIntent(rawText: string, pendingMenu: QualifiedLeadPendingMenu | null): QualifiedLeadIntent {
  const normalized = normalize(rawText);

  // Checked first: a meta-question about Lía herself always wins, regardless of pendingMenu.
  if (IDENTITY_KEYWORDS.some((kw) => normalized.includes(kw))) return { kind: "IDENTITY" };

  // Free-text keyword detection ALWAYS runs first, regardless of pendingMenu -- an explicit
  // question ("¿Cómo funciona el PPR?") must never be shadowed by a stale/coincidental menu
  // state, and must work even when no menu was ever shown yet.
  if (PPR_KEYWORDS.some((kw) => normalized.includes(kw))) return { kind: "QUESTION", topic: "PPR" };
  if (GMM_KEYWORDS.some((kw) => normalized.includes(kw))) return { kind: "QUESTION", topic: "GMM" };
  if (EXPLORE_OPTIONS_KEYWORDS.some((kw) => normalized.includes(kw))) return { kind: "EXPLORE_OPTIONS" };
  if (BOOKING_KEYWORDS.some((kw) => normalized.includes(kw))) return { kind: "BOOKING" };
  if (SAVINGS_KEYWORDS.some((kw) => normalized.includes(kw))) return { kind: "QUESTION", topic: "SAVINGS" };

  // No keyword matched -- a bare digit is only meaningful relative to a menu we know we just
  // showed. A stray "1" with no pending menu is genuinely ambiguous, not a menu choice.
  if (pendingMenu === "MAIN") {
    const digit = matchBareDigit(normalized);
    if (digit === 1) return { kind: "MENU_QUESTION" };
    if (digit === 2) return { kind: "EXPLORE_OPTIONS" };
    if (digit === 3) return { kind: "BOOKING" };
  }

  return { kind: "UNKNOWN" };
}
