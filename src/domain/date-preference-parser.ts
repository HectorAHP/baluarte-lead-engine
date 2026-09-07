import type { DatePreference, Daypart } from "./date-preference.js";
import { localDateString, addLocalDaysToString } from "./timezone.js";

/**
 * Fase 7I -- deterministic, keyword/regex-based extraction of a temporal preference from free
 * WhatsApp text. NEVER an LLM, never external NLP -- same safety posture and normalization
 * convention as every other parser in this codebase (cancellation-intent-detection.ts,
 * reschedule-intent-detection.ts, slot-selection-parser.ts, cancel-confirmation-parser.ts).
 *
 * CAUSE_DATE_PREFERENCE_NOT_PARSED (Fase 7I-DIAG) is what this file closes: before this, "sábado"
 * was indistinguishable from any other unrecognized text -- parseSlotSelection's job was (and
 * still is) ONLY "is this a slot number or a decline phrase", never "does this describe a day".
 *
 * Returns `null` when nothing temporal is found -- this is the overwhelmingly common case (a slot
 * number, "cancelar", "reagendar" alone, a decline phrase, a general question) and callers must
 * treat `null` as "no preference, do exactly what happened before this feature existed" (Fase 7I
 * spec item 24, test 10).
 */
const WEEKDAY_WORDS: Record<string, DatePreference["weekday"]> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const MONTH_WORDS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9, // regional spelling variant
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const DAYPART_PATTERNS: ReadonlyArray<readonly [RegExp, Daypart]> = [
  [/\b(?:por|en)\s+la\s+manana\b/, "MORNING"],
  [/\b(?:por|en)\s+la\s+tarde\b/, "AFTERNOON"],
  [/\b(?:por|en)\s+la\s+noche\b/, "EVENING"],
];

const MONTH_NAME_ALTERNATION = Object.keys(MONTH_WORDS).join("|");
const EXPLICIT_MONTH_DATE_PATTERN = new RegExp(`\\b(?:el\\s+)?([0-3]?\\d)\\s+(?:de\\s+)?(${MONTH_NAME_ALTERNATION})\\b`);

/** Day/month only (no year) -- deliberately narrow: requires a `/` or `-` separator, so a bare
 * number ("1", "2", ... -- parseSlotSelection's own territory, see item 21 of the Fase 7I spec)
 * never matches this. Bounded to plausible day (1-31) and month (1-12) values to avoid false
 * positives on unrelated digit pairs. */
const NUMERIC_DATE_PATTERN = /\b([0-3]?\d)[/-]([01]?\d)\b/;

/** lowercase, trim, collapse internal whitespace, strip accents -- the exact same normalization
 * every other free-text parser in this codebase already uses (see e.g.
 * slot-selection-parser.ts's own `normalize`). Stripping accents also collapses "sábado"/"sabado"
 * and "mañana"/"manana" into one canonical spelling, so only the unaccented form needs to appear
 * in the pattern tables above. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Resolves "D de <mes>" (no year given) to the NEXT occurrence of that calendar day+month that is
 * not in the past relative to `now`'s LOCAL date: this year if it hasn't happened yet, otherwise
 * next year. Never returns a date strictly before today.
 */
function resolveExplicitMonthDate(day: number, month: number, now: Date, timezone: string): string {
  const todayStr = localDateString(now, timezone);
  const thisYear = Number(todayStr.slice(0, 4));
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const thisYearCandidate = `${thisYear}-${pad2(month)}-${pad2(day)}`;
  return thisYearCandidate >= todayStr ? thisYearCandidate : `${thisYear + 1}-${pad2(month)}-${pad2(day)}`;
}

/**
 * @param inboundText raw WhatsApp free text.
 * @param now business "now" -- used only to resolve "hoy"/"mañana"/"pasado mañana"/an explicit
 *   date-without-year into a concrete calendar date. Defaults to the real wall clock; callers in
 *   this codebase always pass the same `now` already threaded through the rest of the turn.
 * @param timezone the business timezone every resolved date is expressed in. Defaults to
 *   "America/Mexico_City" (this codebase's one and only advisor timezone today), but is a real
 *   parameter (never a hardcoded literal inside the function body) so it can never silently drift
 *   from config.ADVISOR_TIMEZONE if that ever changes.
 */
export function parseDatePreference(inboundText: string, now: Date = new Date(), timezone = "America/Mexico_City"): DatePreference | null {
  let working = normalize(inboundText);
  let targetDate: string | undefined;
  let weekday: DatePreference["weekday"] | undefined;
  let daypart: Daypart | undefined;

  // 1. Daypart -- matched and CONSUMED (removed from `working`) first, so a leftover bare
  // "manana" from inside "por la manana" is never also mistaken, below, for the relative-date
  // word "mañana" (tomorrow). At most one daypart per message.
  for (const [pattern, part] of DAYPART_PATTERNS) {
    if (pattern.test(working)) {
      daypart = part;
      working = working.replace(pattern, " ");
      break;
    }
  }

  // 2. Relative dates -- "pasado manana" checked (and consumed) before bare "manana" for the same
  // substring-collision reason as step 1.
  if (/\bpasado\s+manana\b/.test(working)) {
    targetDate = addLocalDaysToString(now, timezone, 2);
    working = working.replace(/\bpasado\s+manana\b/, " ");
  } else if (/\bhoy\b/.test(working)) {
    targetDate = localDateString(now, timezone);
    working = working.replace(/\bhoy\b/, " ");
  } else if (/\bmanana\b/.test(working)) {
    targetDate = addLocalDaysToString(now, timezone, 1);
    working = working.replace(/\bmanana\b/, " ");
  }

  // 3. Explicit "D de <mes>" -- only tried when no relative date already resolved one above (an
  // explicit date always wins if both somehow appear, though that's an unusual message).
  if (targetDate === undefined) {
    const match = working.match(EXPLICIT_MONTH_DATE_PATTERN);
    if (match) {
      const day = Number(match[1]);
      const month = MONTH_WORDS[match[2]];
      if (day >= 1 && day <= 31) {
        targetDate = resolveExplicitMonthDate(day, month, now, timezone);
        working = working.replace(match[0], " ");
      }
    }
  }

  // 4. Numeric "D/M" or "D-M" -- optional, lowest priority, only tried when nothing else matched.
  if (targetDate === undefined) {
    const match = working.match(NUMERIC_DATE_PATTERN);
    if (match) {
      const day = Number(match[1]);
      const month = Number(match[2]);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        targetDate = resolveExplicitMonthDate(day, month, now, timezone);
        working = working.replace(match[0], " ");
      }
    }
  }

  // 5. Bare weekday name -- only when no concrete date (relative or explicit) was already
  // resolved above; targetDate and weekday are never both set.
  if (targetDate === undefined) {
    for (const [word, value] of Object.entries(WEEKDAY_WORDS)) {
      if (new RegExp(`\\b${word}\\b`).test(working)) {
        weekday = value;
        break;
      }
    }
  }

  if (targetDate === undefined && weekday === undefined && daypart === undefined) return null;

  const preference: DatePreference = {};
  if (targetDate !== undefined) preference.targetDate = targetDate;
  if (weekday !== undefined) preference.weekday = weekday;
  if (daypart !== undefined) preference.daypart = daypart;
  return preference;
}
