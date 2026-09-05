import type { EmailQuality } from "./email-quality.js";
import type { PhoneQuality } from "./phone-quality.js";

/**
 * Fase 7B -- a technical, channel/identity-quality score. Deliberately, permanently separate from:
 *  - fiscal_v1 (commercial fiscal scoring, fiscal-lead-scoring.ts) -- never reads it, never feeds it;
 *  - HOT/WARM/NURTURE / QUALIFIED_A/B/C (the WhatsApp qualifier's scoring, scoring.ts) -- same;
 *  - consentContact / privacyAcceptedAt -- consent is a legal/policy fact, not a quality signal;
 *  - Meta messaging eligibility (the 24h customer-service window) -- entirely orthogonal.
 * See the Fase 7B report's "principle" section for why these must never be mixed. No caller in
 * this codebase may use leadIntegrityScore to change a lead's status, score, scoreClass, or
 * whether it can be contacted -- see LEAD_INTEGRITY_ENABLED's own doc comment in config.ts for
 * what a low score is (and, just as importantly, is NOT) allowed to gate.
 */
export const LEAD_INTEGRITY_VERSION = "lead_integrity_v1";

export interface LeadIntegritySignals {
  emailQuality?: EmailQuality;
  phoneQuality?: PhoneQuality;
  /** True name plausibility is NOT attempted here (no name-plausibility heuristic exists in this
   * codebase, and building one risks penalizing real short/foreign/hyphenated names -- a
   * false-positive class this task explicitly warns against). Reserved for a future, carefully
   * validated implementation; omit this signal until one exists rather than guessing. */
  hasPlausibleName?: boolean;
  isUniqueSubmission?: boolean;
  suspectedAutomation?: boolean;
  honeypotTriggered?: boolean;
  identityConflict?: boolean;
  repeatedSubmissionCount?: number;
}

interface ScoreRule {
  applies: (s: LeadIntegritySignals) => boolean;
  points: number;
}

// Each rule is independent and additive/subtractive -- no rule depends on another having already
// fired, so signals can be supplied partially (e.g. only emailQuality known) without distorting
// the result. Weights are deliberately modest and symmetric (no single positive signal alone
// reaches a "trustworthy" threshold, and no single weak negative signal alone reaches a "reject"
// threshold) -- see Fase 7B spec item 38: "No bloquear leads legítimos por una sola señal débil."
const RULES: ScoreRule[] = [
  { applies: (s) => s.emailQuality === "VALID" || s.emailQuality === "UNVERIFIED", points: 15 },
  { applies: (s) => s.emailQuality === "INVALID", points: -30 },
  { applies: (s) => s.emailQuality === "DISPOSABLE", points: -15 },
  { applies: (s) => s.phoneQuality === "VALID" || s.phoneQuality === "UNVERIFIED", points: 15 },
  { applies: (s) => s.phoneQuality === "VERIFIED", points: 25 }, // stacks with the base phone-quality point above -- verification is a strictly stronger, additional signal
  { applies: (s) => s.phoneQuality === "INVALID", points: -30 },
  { applies: (s) => s.hasPlausibleName === true, points: 10 },
  { applies: (s) => s.isUniqueSubmission === true, points: 10 },
  { applies: (s) => s.isUniqueSubmission === false, points: -20 },
  { applies: (s) => s.suspectedAutomation === true, points: -25 },
  { applies: (s) => s.honeypotTriggered === true, points: -100 }, // decisive on its own -- a real honeypot hit is never "one weak signal among many"
  { applies: (s) => s.identityConflict === true, points: -20 },
  { applies: (s) => (s.repeatedSubmissionCount ?? 0) > 3, points: -15 },
];

const BASELINE_SCORE = 50; // neutral starting point -- neither trusted nor distrusted before any signal is applied

export interface LeadIntegrityResult {
  score: number;
  version: string;
}

/** Pure, deterministic, side-effect-free. Clamped to [0, 100]. */
export function computeLeadIntegrityScore(signals: LeadIntegritySignals): LeadIntegrityResult {
  const raw = RULES.reduce((total, rule) => (rule.applies(signals) ? total + rule.points : total), BASELINE_SCORE);
  return { score: Math.max(0, Math.min(100, raw)), version: LEAD_INTEGRITY_VERSION };
}
