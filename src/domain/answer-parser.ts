export interface OptionDef<T extends string> {
  value: T;
  /** 1-based position as presented in the numbered prompt. */
  number: number;
  /** Normalized (accent-stripped, lowercase) substrings that identify this option in free text. */
  keywords: string[];
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Resolves a free-text or numeric answer against a closed set of options. Numeric match takes
 * priority (unambiguous by construction); keyword match falls back to substring search and
 * returns null -- never a guess -- when zero or more than one option's keywords match, so the
 * caller always re-asks rather than silently picking a side.
 */
export function parseOptionAnswer<T extends string>(rawText: string, options: readonly OptionDef<T>[]): T | null {
  const normalized = normalize(rawText);

  const numeric = /^(\d+)\.?$/.exec(normalized);
  if (numeric) {
    const byNumber = options.find((o) => o.number === Number(numeric[1]));
    if (byNumber) return byNumber.value;
  }

  const matches = options.filter((o) => o.keywords.some((kw) => normalized.includes(kw)));
  if (matches.length === 1) return matches[0].value;
  return null;
}

const YES_PATTERN = /\b(si|sí|claro|afirmativo|correcto|exacto)\b/;
const NO_PATTERN = /\b(no|negativo|nel)\b/;
const MAYBE_PATTERN = /\b(tal vez|talvez|quiza|quizas|posiblemente|no estoy segur[oa]|probablemente)\b/;

export type YesNoMaybe = "YES" | "NO" | "MAYBE";

/**
 * "Maybe" is checked first because its phrases ("tal vez", "no estoy seguro") contain the
 * substring "no" and would otherwise false-match NO.
 */
export function parseYesNoMaybe(rawText: string): YesNoMaybe | null {
  const normalized = normalize(rawText);
  if (MAYBE_PATTERN.test(normalized)) return "MAYBE";
  if (YES_PATTERN.test(normalized)) return "YES";
  if (NO_PATTERN.test(normalized)) return "NO";
  return null;
}

/**
 * Mexican postal codes are exactly 5 digits, kept as a string so a leading zero is never lost
 * to numeric coercion. Anything else (4 digits, 6 digits, non-digits) is not a valid postal code
 * -- there is no partial/fuzzy acceptance.
 */
export function isValidMexicanPostalCode(value: string): boolean {
  return /^\d{5}$/.test(value);
}
