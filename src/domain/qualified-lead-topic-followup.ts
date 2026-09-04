import type { Message } from "./message.js";

/**
 * Fase 6E.3 -- generalized "contextual follow-up" state for a topic answer that ends in a
 * two-branch question (e.g. PPR's "¿Quieres que te explique primero cómo funciona el beneficio
 * fiscal o cómo se construye el ahorro para el retiro?"). Deliberately parameterized by topic --
 * NOT hardcoded per-conversation in whatsapp-past-booked-recovery-handler.ts or
 * whatsapp-inbound-service.ts -- so a future phase can wire GMM/SAVINGS through the exact same
 * mechanism by adding an entry to FOLLOWUP_TOPIC_CONFIG below, never new routing code (Fase 6E.3
 * spec, item 5).
 *
 * ROOT CAUSE this fixes: buildQualifiedLeadTopicAnswer's reply (PPR/GMM/SAVINGS) never attached
 * ANY outbound metadata, so a short follow-up reply ("Sí", "Ok") had no pending state to resolve
 * against -- it fell through to detectQualifiedLeadIntent's UNKNOWN branch and re-triggered
 * whatever THAT handler's generic fallback was (PAST_BOOKED_GENERIC_INBOUND_MESSAGE, in the
 * reported bug). Same "reconstruct from message history, never a separate snapshot" principle as
 * qualified-lead-menu-state.ts/past-booked-reactivation-state.ts.
 *
 * ONLY PPR and GMM are wired here (both existing follow-up questions already ask "X or Y", a
 * natural fit) -- SAVINGS's follow-up ("¿Tienes alguna meta específica en mente?") is open-ended,
 * not a two-way choice, so it deliberately has no entry below; a bare digit/short reply to it
 * still falls through to the generic fallback, unchanged. See the Fase 6E.3 report, item 4/5.
 */
export type QualifiedLeadFollowupTopic = "PPR" | "GMM";

const EXPECTED_INTENT_KEY = "expectedIntent";

function followupMarker(topic: QualifiedLeadFollowupTopic): string {
  return `${topic}_FOLLOWUP`;
}

/** Metadata to attach to a topic answer that ends in a two-branch question -- never PII, never a
 * score/band, just an opaque state identifier (same convention as qualifiedMainMenuMetadata()/
 * qualifiedOptionsMenuMetadata()/pastBookedReactivationMetadata()). */
export function topicFollowupMetadata(topic: QualifiedLeadFollowupTopic): Record<string, unknown> {
  return { [EXPECTED_INTENT_KEY]: followupMarker(topic) };
}

/**
 * Looks at the most recent OUTBOUND message and returns the pending followup topic only when
 * that message was marked via topicFollowupMetadata() above. Same ascending-order contract as
 * resolvePendingQualifiedMenu -- see that function's doc comment for why no re-sort happens here.
 */
export function resolvePendingTopicFollowup(messages: readonly Message[]): QualifiedLeadFollowupTopic | null {
  const outboundMessages = messages.filter((m) => m.direction === "OUTBOUND");
  const lastOutbound = outboundMessages[outboundMessages.length - 1];
  if (!lastOutbound) return null;
  const marker = lastOutbound.metadata?.[EXPECTED_INTENT_KEY];
  if (marker === followupMarker("PPR")) return "PPR";
  if (marker === followupMarker("GMM")) return "GMM";
  return null;
}

export type QualifiedLeadFollowupBranch = "PRIMARY" | "SECONDARY" | "CLARIFY_EXPLICIT" | "CLARIFY_GENERIC" | "CLOSING" | "UNKNOWN";

interface FollowupTopicConfig {
  primaryKeywords: string[];
  secondaryKeywords: string[];
  primaryAnswer: string;
  secondaryAnswer: string;
  /** Exact copy for the Fase 6E.3 spec's "Sí" example -- restates both branches by name. */
  clarifyExplicitMessage: string;
  /** Exact copy for the spec's "Ok" example -- short, generic, still asks which branch. */
  clarifyGenericMessage: string;
}

const COMBINING_DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");
function normalize(text: string): string {
  return text.normalize("NFD").replace(COMBINING_DIACRITICS, "").toLowerCase().trim();
}
function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.!¡¿?,;:\s]+$/g, "").trim();
}

/** Exact-match only (after normalizing + stripping trailing punctuation) -- these are meant to
 * catch a genuinely SHORT standalone reply ("Sí", "Ok."), never a substring inside a longer,
 * unrelated sentence that happens to contain "si"/"no" as part of another word. */
const EXPLICIT_YES_TOKENS = new Set(["si", "sí"]);
const GENERIC_CONTINUE_TOKENS = new Set(["ok", "okay", "va", "perfecto", "dale", "claro", "de acuerdo", "asi es"]);
const CLOSING_TOKENS = new Set(["no", "no gracias", "gracias", "esta bien", "asi esta bien", "muchas gracias"]);

const FOLLOWUP_TOPIC_CONFIG: Record<QualifiedLeadFollowupTopic, FollowupTopicConfig> = {
  PPR: {
    primaryKeywords: ["1", "beneficio fiscal", "fiscal"],
    secondaryKeywords: ["2", "ahorro", "retiro"],
    primaryAnswer:
      "El beneficio fiscal de un PPR depende de tu régimen y de cuánto puedas aportar dentro de los límites aplicables. Ciertas aportaciones pueden ser deducibles, lo que puede ayudar en tu situación fiscal anual, sujeto a los requisitos y topes vigentes.\n\n¿Quieres que revisemos qué tanto podrías aportar en tu caso?",
    secondaryAnswer:
      "El ahorro se construye con tus aportaciones periódicas, invertidas con un horizonte de largo plazo pensando en tu retiro. Lo importante es definir cuánto puedes aportar de forma constante y qué nivel de flexibilidad necesitas.\n\n¿Quieres que veamos qué monto podría ser razonable para ti?",
    clarifyExplicitMessage: "Claro. ¿Quieres que empecemos por el beneficio fiscal o por cómo se construye el ahorro para el retiro?",
    clarifyGenericMessage: "Perfecto. ¿Qué parte te gustaría revisar primero?",
  },
  GMM: {
    primaryKeywords: ["1", "deducible", "coaseguro"],
    secondaryKeywords: ["2", "comparar", "opciones"],
    primaryAnswer:
      "El deducible es lo que pagas de tu bolsillo antes de que la cobertura empiece a aplicar, y el coaseguro es el porcentaje que sigues compartiendo después de eso, hasta un tope. Ambos determinan cuánto pagarías en caso de un evento médico importante.\n\n¿Quieres que revisemos qué combinación te haría sentido?",
    secondaryAnswer:
      "Podemos comparar opciones considerando suma asegurada, red hospitalaria, deducible y coaseguro, para encontrar el equilibrio que mejor se ajuste a tu presupuesto y necesidades.\n\n¿Hay algo en particular que te preocupe más de tu cobertura actual?",
    clarifyExplicitMessage: "Claro. ¿Quieres que empecemos por cómo funcionan deducible y coaseguro, o por comparar opciones entre distintas coberturas?",
    clarifyGenericMessage: "Perfecto. ¿Qué parte te gustaría revisar primero?",
  },
};

/** Shared, topic-agnostic closer for a "no"/"gracias" reply mid-followup -- consumes the pending
 * state (never repeated), never mentions the past appointment. */
export const FOLLOWUP_CLOSING_MESSAGE = "Con gusto. Aquí sigo si más adelante quieres que revisemos algo más.";

/** Resolves a reply against a pending followup topic. Never AI -- exact-match short tokens plus
 * the SAME substring-keyword style already used throughout qualified-lead-intent-detection.ts. */
export function detectFollowupBranch(topic: QualifiedLeadFollowupTopic, rawText: string): QualifiedLeadFollowupBranch {
  const normalized = normalize(rawText);
  const config = FOLLOWUP_TOPIC_CONFIG[topic];

  if (config.primaryKeywords.some((kw) => normalized.includes(kw))) return "PRIMARY";
  if (config.secondaryKeywords.some((kw) => normalized.includes(kw))) return "SECONDARY";

  const shortToken = normalize(stripTrailingPunctuation(rawText));
  if (EXPLICIT_YES_TOKENS.has(shortToken)) return "CLARIFY_EXPLICIT";
  if (GENERIC_CONTINUE_TOKENS.has(shortToken)) return "CLARIFY_GENERIC";
  if (CLOSING_TOKENS.has(shortToken)) return "CLOSING";

  return "UNKNOWN";
}

export function buildFollowupBranchAnswer(topic: QualifiedLeadFollowupTopic, branch: "PRIMARY" | "SECONDARY"): string {
  const config = FOLLOWUP_TOPIC_CONFIG[topic];
  return branch === "PRIMARY" ? config.primaryAnswer : config.secondaryAnswer;
}

export function buildFollowupClarifyMessage(topic: QualifiedLeadFollowupTopic, branch: "CLARIFY_EXPLICIT" | "CLARIFY_GENERIC"): string {
  const config = FOLLOWUP_TOPIC_CONFIG[topic];
  return branch === "CLARIFY_EXPLICIT" ? config.clarifyExplicitMessage : config.clarifyGenericMessage;
}

/**
 * Fase 6E.3, item 10 -- a determinism-only classifier for a short reply with NO pending followup
 * state (sí/no/ok/va/perfecto/gracias/...). Reuses the exact same token sets as
 * detectFollowupBranch above (never a separate, driftable list) -- "AFFIRMATIVE" for an
 * unspecified continuation ("sí"/"ok"/"va"/"perfecto"/...), "CLOSING" for a closing remark
 * ("no"/"gracias"/...), null when the text isn't one of these short tokens at all (genuinely
 * unrecognized text, handled by the caller's own fallback).
 */
export function classifyShortResponse(rawText: string): "AFFIRMATIVE" | "CLOSING" | null {
  const shortToken = normalize(stripTrailingPunctuation(rawText));
  if (EXPLICIT_YES_TOKENS.has(shortToken) || GENERIC_CONTINUE_TOKENS.has(shortToken)) return "AFFIRMATIVE";
  if (CLOSING_TOKENS.has(shortToken)) return "CLOSING";
  return null;
}
