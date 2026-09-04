import type { Message } from "./message.js";

/**
 * Fase 6E.4 -- pending-menu state for the FISCAL WELCOME's own "1. Ahorro e inversión / 2. Retiro
 * PPR / 3. Gastos Médicos Mayores / 4. Otro tema" menu (buildWelcomeMessage /
 * buildFiscalContextWelcomeMessage, message-templates.ts) -- a DIFFERENT menu, with a DIFFERENT
 * fixed digit scheme, from the qualified-lead router's own MAIN menu ("1. Resolver una duda /
 * 2. Conocer opciones / 3. Agendar una asesoría", qualified-lead-menu-state.ts). Never conflate
 * the two: this file owns 1=SAVINGS/2=RETIREMENT_PPR/3=GMM/4=OTHER (classifyIntent's own scheme,
 * intent-classifier.ts), never QUALIFIED_MAIN_MENU/QUALIFIED_OPTIONS_MENU.
 *
 * ROOT CAUSE this closes (Fase 6E.4): the fiscal welcome's OWN outbound message never attached
 * ANY expectedIntent marker, so there was no deterministic way to know "the lead is replying to
 * THIS specific 1-4 menu" independent of lead.status. A fiscal-calculator lead's status at the
 * moment of their first WhatsApp message can be NEW (normal case -- the qualification engine
 * picks up their reply correctly), but can ALSO be CONTACTED (e.g. an advisor already called them
 * via POST /api/leads/:id/contact, entirely unrelated to WhatsApp) with productInterest ALREADY
 * set (impuestos.html's own submission payload always sets "Beneficio fiscal PPR") -- and for
 * THAT lead shape, NO branch in whatsapp-inbound-service.ts's routing chain ever claims their
 * follow-up reply: the qualification-recovery branch explicitly requires `!lead.productInterest`,
 * and no other branch matches CONTACTED at all. The reply fell all the way through to
 * "no-match" -- confirmed reproduced (see the Fase 6E.4 report, item 1) BEFORE this fix existed.
 *
 * Fix: this pending-menu marker is checked EARLY in whatsapp-inbound-service.ts, BEFORE any
 * status-based branch, so a reply to the fiscal welcome is ALWAYS handled the same
 * (natural-language, per the Fase 6E.4 spec's item 7), regardless of lead.status. Same
 * "reconstruct from the last outbound message's metadata" convention as
 * qualified-lead-menu-state.ts / qualified-lead-topic-followup.ts / past-booked-reactivation-state.ts.
 */
export type FiscalWelcomeTopic = "SAVINGS" | "PPR" | "GMM";

const EXPECTED_INTENT_KEY = "expectedIntent";
const FISCAL_WELCOME_MENU_MARKER = "FISCAL_WELCOME_MENU";

/** Metadata to attach to the fiscal welcome's own outbound message -- never PII, never score/
 * band/HOT-WARM-NURTURE, just an opaque state identifier. */
export function fiscalWelcomeMenuMetadata(): Record<string, unknown> {
  return { [EXPECTED_INTENT_KEY]: FISCAL_WELCOME_MENU_MARKER };
}

/** Looks at the most recent OUTBOUND message and returns true only when it was marked via
 * fiscalWelcomeMenuMetadata() above. Same ascending-order contract as every other
 * resolvePending*() in this codebase -- see qualified-lead-menu-state.ts's doc comment for why no
 * re-sort happens here. */
export function resolvePendingFiscalWelcomeMenu(messages: readonly Message[]): boolean {
  const outboundMessages = messages.filter((m) => m.direction === "OUTBOUND");
  const lastOutbound = outboundMessages[outboundMessages.length - 1];
  if (!lastOutbound) return false;
  return lastOutbound.metadata?.[EXPECTED_INTENT_KEY] === FISCAL_WELCOME_MENU_MARKER;
}

const COMBINING_DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");
function normalize(text: string): string {
  return text.normalize("NFD").replace(COMBINING_DIACRITICS, "").toLowerCase().trim();
}

/** Matches a lone menu digit 1-4, tolerating "opcion 2", "2.", "2)", "la 2", etc. -- same shape as
 * intent-classifier.ts's/qualified-lead-intent-detection.ts's own matchBareDigit. */
function matchBareDigit(normalized: string): 1 | 2 | 3 | 4 | null {
  const m = /(?:^|\s)([1-4])(?:$|[).\s,]|a\b)/.exec(` ${normalized} `);
  return m ? (Number(m[1]) as 1 | 2 | 3 | 4) : null;
}

export type FiscalWelcomeSelection = { kind: "TOPIC"; topic: FiscalWelcomeTopic } | { kind: "OTHER" } | null;

/**
 * Resolves a reply against the fiscal welcome's OWN fixed digit scheme -- 1=SAVINGS, 2=PPR,
 * 3=GMM, 4=OTHER (item 3 of the Fase 6E.4 spec: deliberately NOT the qualified router's scheme).
 * Returns null when the text isn't a recognizable 1-4 digit -- the caller falls back to free-text
 * keyword detection (detectQualifiedLeadIntent, reused as-is -- see the Fase 6E.4 report, item 9).
 */
export function detectFiscalWelcomeDigit(rawText: string): FiscalWelcomeSelection {
  const digit = matchBareDigit(normalize(rawText));
  if (digit === 1) return { kind: "TOPIC", topic: "SAVINGS" };
  if (digit === 2) return { kind: "TOPIC", topic: "PPR" };
  if (digit === 3) return { kind: "TOPIC", topic: "GMM" };
  if (digit === 4) return { kind: "OTHER" };
  return null;
}
