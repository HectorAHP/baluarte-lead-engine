import { isValidMexicanPostalCode } from "./answer-parser.js";

export interface ResidenceLocation {
  city?: string;
  state?: string;
  postalCode?: string;
}

export interface LocationParseResult {
  /** Newly extracted fields only -- never includes a field the caller didn't ask about and the
   * text didn't actually contain, so merging never silently invents a value. */
  extracted: ResidenceLocation;
  /** Set when a newly-parsed field disagrees with an already-confirmed value for that same
   * field. The caller must ask for confirmation before overwriting -- never persisted directly. */
  contradiction?: { field: keyof ResidenceLocation; existingValue: string; newValue: string };
  /** True when there was leftover text after removing any postal code/state match, but it read
   * as a hedge/non-answer ("no sé", "por ahí", "más o menos", ...) rather than a place name --
   * `extracted.city` is deliberately left unset in this case instead of guessing. A valid
   * postal code or state found in the same message is still returned in `extracted`. */
  unrecognized?: boolean;
}

const MEXICAN_STATES = [
  "aguascalientes", "baja california sur", "baja california", "campeche", "chiapas", "chihuahua",
  "ciudad de mexico", "coahuila", "colima", "durango", "guanajuato", "guerrero", "hidalgo",
  "jalisco", "estado de mexico", "michoacan", "morelos", "nayarit", "nuevo leon", "oaxaca",
  "puebla", "queretaro", "quintana roo", "san luis potosi", "sinaloa", "sonora", "tabasco",
  "tamaulipas", "tlaxcala", "veracruz", "yucatan", "zacatecas",
];

// Common abbreviations/aliases -> canonical state name.
const STATE_ALIASES: Record<string, string> = {
  gto: "guanajuato",
  cdmx: "ciudad de mexico", df: "ciudad de mexico",
  edomex: "estado de mexico",
  nl: "nuevo leon",
  bcs: "baja california sur", bc: "baja california",
  qroo: "quintana roo",
  slp: "san luis potosi",
};

// Longest candidate first, so "baja california sur" wins over the shorter "baja california".
const STATE_CANDIDATES: Array<{ pattern: string; canonical: string }> = [
  ...MEXICAN_STATES.map((s) => ({ pattern: s, canonical: s })),
  ...Object.entries(STATE_ALIASES).map(([alias, canonical]) => ({ pattern: alias, canonical })),
].sort((a, b) => b.pattern.length - a.pattern.length);

const FILLER_PATTERNS = [/\bvivo en\b/g, /\bresido en\b/g, /\bsoy de\b/g, /\bcodigo postal\b/g, /\bc\s*p\b/g];

/**
 * Hedge/non-answer phrases that must never be accepted as a city, however much leftover text
 * survives filler-stripping. Deliberately a closed, literal list (not a general "does this look
 * like a place name" classifier, and never a geocoding lookup) -- explicit and auditable, same
 * posture as health-redaction.ts and opt-out-detection.ts.
 */
const UNRECOGNIZED_LOCATION_PATTERNS: RegExp[] = [
  /no se\b/, // "no sé" (accent-stripped) / "no lo sé"
  /no estoy segur[oa]/, // "no estoy seguro/a"
  /no recuerdo/,
  /no tengo el dato/,
  /creo que/, // "creo que sí" / "creo que no"
  /por ahi/, // "por ahí"
  /cerca del centro/,
  /mas o menos/, // "más o menos"
  /despues te digo/, // "después te digo"
  /prefiero verlo luego/,
];

function isUnrecognizedLocationText(remainder: string): boolean {
  return UNRECOGNIZED_LOCATION_PATTERNS.some((pattern) => pattern.test(remainder));
}

function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeForMatching(text: string): string {
  return stripDiacritics(text).toLowerCase().replace(/[\u0300-\u036f]/g, "").trim();
}

function toTitleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

function cleanupRemainder(text: string): string {
  return text
    .replace(/[,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Accepts "ciudad + estado + CP" in one message, or any subset of them across turns, including
 * loose sentences ("Vivo en León Gto CP 37150"). Never infers one field from another (no
 * CP -> city/state lookup) and never overwrites an already-confirmed field without flagging the
 * conflict for the caller to confirm first.
 */
export function parseLocationAnswer(rawText: string, existing: ResidenceLocation): LocationParseResult {
  const postalMatch = /\b(\d{5})\b/.exec(rawText);
  const postalCode = postalMatch && isValidMexicanPostalCode(postalMatch[1]) ? postalMatch[1] : undefined;
  const withoutPostal = postalMatch ? rawText.slice(0, postalMatch.index) + rawText.slice(postalMatch.index + postalMatch[0].length) : rawText;

  let remainder = normalizeForMatching(withoutPostal);
  for (const filler of FILLER_PATTERNS) remainder = remainder.replace(filler, " ");

  let state: string | undefined;
  for (const candidate of STATE_CANDIDATES) {
    const re = new RegExp(`\\b${candidate.pattern}\\b`);
    if (re.test(remainder)) {
      state = toTitleCase(candidate.canonical);
      remainder = remainder.replace(re, " ");
      break;
    }
  }

  const cityRemainder = cleanupRemainder(remainder);
  const unrecognized = cityRemainder.length > 0 && isUnrecognizedLocationText(cityRemainder);
  const city = cityRemainder.length > 0 && !unrecognized ? toTitleCase(cityRemainder) : undefined;

  const extracted: ResidenceLocation = {};
  if (city) extracted.city = city;
  if (state) extracted.state = state;
  if (postalCode) extracted.postalCode = postalCode;

  for (const field of ["city", "state", "postalCode"] as const) {
    const newValue = extracted[field];
    const existingValue = existing[field];
    if (newValue && existingValue && normalizeForMatching(newValue) !== normalizeForMatching(existingValue)) {
      return { extracted: {}, contradiction: { field, existingValue, newValue } };
    }
  }

  return unrecognized ? { extracted, unrecognized: true } : { extracted };
}

export function missingLocationFields(location: ResidenceLocation): Array<keyof ResidenceLocation> {
  const missing: Array<keyof ResidenceLocation> = [];
  if (!location.city) missing.push("city");
  if (!location.state) missing.push("state");
  if (!location.postalCode) missing.push("postalCode");
  return missing;
}
