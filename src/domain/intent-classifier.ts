import type { QualificationProduct } from "./qualification-fields.js";

export type IntentClassification =
  | { kind: "MATCHED"; product: QualificationProduct }
  | { kind: "OTHER" }
  | { kind: "AMBIGUOUS" };

const COMBINING_DIACRITICS = /[\u0300-\u036f]/g;

function normalize(text: string): string {
  return text.normalize("NFD").replace(COMBINING_DIACRITICS, "").toLowerCase().trim();
}

/** Matches a lone menu digit (1-4), tolerating "opcion 1", "1.", "1)", "la 2", etc. */
function matchMenuOption(normalized: string): 1 | 2 | 3 | 4 | null {
  const m = /(?:^|\s)([1-4])(?:$|[).\s,]|a\b)/.exec(` ${normalized} `);
  return m ? (Number(m[1]) as 1 | 2 | 3 | 4) : null;
}

// RETIREMENT_PPR and GMM are the "specific" buckets; SAVINGS is the generic fallback. A phrase
// like "quiero ahorrar para mi retiro" matches both SAVINGS ("ahorrar") and RETIREMENT_PPR
// ("retiro") -- the specific bucket wins so it isn't flagged ambiguous. Two specific buckets
// both matching (e.g. "retiro" and "gastos médicos" in the same message) is genuine ambiguity.
const RETIREMENT_PPR_KEYWORDS = ["retiro", "ppr", "jubil", "pension", "deducir impuesto", "deduccion de impuesto", "reducir mi carga fiscal"];
const GMM_KEYWORDS = ["gastos medicos", "seguro medico", "seguro de gastos", "proteger a mi familia", "gmm", "hospitalizacion"];
const SAVINGS_KEYWORDS = ["ahorrar", "ahorro", "invertir", "inversion", "plan de ahorro", "fondo de inversion"];

const SPECIFIC_BUCKETS: Array<{ product: QualificationProduct; keywords: string[] }> = [
  { product: "RETIREMENT_PPR", keywords: RETIREMENT_PPR_KEYWORDS },
  { product: "GMM", keywords: GMM_KEYWORDS },
];

const OTHER_KEYWORDS = ["otro tema", "otra cosa", "algo mas"];

/**
 * Deterministic, keyword/menu-digit based -- no LLM call in Phase 3A (see AIProvider port for
 * the future extension point). False "ambiguous" is the safe failure mode: the caller re-asks
 * for clarification rather than guessing a product, per the no-improvised-recommendations rule.
 */
export function classifyIntent(rawText: string): IntentClassification {
  const normalized = normalize(rawText);

  const menuOption = matchMenuOption(normalized);
  if (menuOption === 1) return { kind: "MATCHED", product: "SAVINGS" };
  if (menuOption === 2) return { kind: "MATCHED", product: "RETIREMENT_PPR" };
  if (menuOption === 3) return { kind: "MATCHED", product: "GMM" };
  if (menuOption === 4) return { kind: "OTHER" };

  if (OTHER_KEYWORDS.some((kw) => normalized.includes(kw))) return { kind: "OTHER" };

  const specificMatches = SPECIFIC_BUCKETS.filter((bucket) => bucket.keywords.some((kw) => normalized.includes(kw)));
  if (specificMatches.length === 1) return { kind: "MATCHED", product: specificMatches[0].product };
  if (specificMatches.length > 1) return { kind: "AMBIGUOUS" };

  if (SAVINGS_KEYWORDS.some((kw) => normalized.includes(kw))) return { kind: "MATCHED", product: "SAVINGS" };

  return { kind: "AMBIGUOUS" };
}
