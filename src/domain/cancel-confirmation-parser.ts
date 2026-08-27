export type CancelConfirmationResult = "CONFIRM" | "DECLINE" | "AMBIGUOUS";

/** Closed, deterministic list -- matched against fully normalized text (see normalize below). */
const CONFIRM_PHRASES: ReadonlySet<string> = new Set([
  "1",
  "si",
  "si cancelar",
  "confirmar",
  "cancelar",
]);

const DECLINE_PHRASES: ReadonlySet<string> = new Set([
  "2",
  "no",
  "no conservar",
  "conservar",
]);

/** Same normalization convention as slot-selection-parser.ts: lowercase, trim, collapse internal
 * whitespace, strip accents -- kept as its own local copy rather than a shared utility, matching
 * this codebase's existing per-parser convention. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,!¡¿?]/g, "");
}

/**
 * 100% deterministic, side-effect-free. Interprets a reply to the "¿Quieres cancelar tu cita...
 * 1. Sí, cancelar / 2. No, conservar" prompt. Never an LLM: an ambiguous reply must NEVER cancel a
 * real appointment -- AMBIGUOUS is the only safe default for anything not on the closed list,
 * including a bare number outside {1,2} or unrelated prose.
 */
export function parseCancelConfirmation(text: string): CancelConfirmationResult {
  const normalized = normalize(text);
  if (CONFIRM_PHRASES.has(normalized)) return "CONFIRM";
  if (DECLINE_PHRASES.has(normalized)) return "DECLINE";
  return "AMBIGUOUS";
}
