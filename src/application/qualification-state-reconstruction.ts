import type { Lead } from "../domain/lead.js";
import type { QualificationAnswer } from "../domain/qualification-answer.js";
import { stepsForProduct } from "../domain/qualification-catalog.js";
import { productVertical, type QualificationProduct } from "../domain/qualification-fields.js";
import { initialQualificationState, type QualificationState, type AnswerRecord } from "../domain/qualification-state.js";
import type { ResidenceLocation } from "../domain/location-parser.js";

const TERMINAL_COMPLETE_STATUSES = new Set(["QUALIFIED_A", "QUALIFIED_B", "NURTURE_C"]);

function isKnownProduct(value: string | undefined): value is QualificationProduct {
  return value === "SAVINGS" || value === "RETIREMENT_PPR" || value === "GMM";
}

/**
 * Rebuilds the qualifier's in-memory state from what's already durably persisted (lead.status,
 * lead.productInterest, qualification_answers), so no opaque state-machine snapshot needs its
 * own storage. Deliberately reconstructs, not caches -- see the Phase 3B report for the two
 * narrow fields (intentAttempts, pendingLocationConfirmation) this cannot recover and why that's
 * an accepted, safe gap rather than a reason to add more persistence.
 *
 * `answers` must already be the full history for this lead (QualificationAnswerRepository is
 * append-only, so the *last* row per fieldName is the current value).
 */
export function reconstructQualificationState(lead: Lead, answers: readonly QualificationAnswer[]): QualificationState {
  const base = initialQualificationState();

  if (lead.status === "HUMAN_HANDOFF") {
    return { ...base, phase: "HUMAN_HANDOFF", product: isKnownProduct(lead.productInterest) ? lead.productInterest : null, handoffReason: "RECONSTRUCTED_TERMINAL" };
  }
  if (TERMINAL_COMPLETE_STATUSES.has(lead.status)) {
    return { ...base, phase: "COMPLETED", product: isKnownProduct(lead.productInterest) ? lead.productInterest : null };
  }
  if (!isKnownProduct(lead.productInterest)) {
    // No product resolved yet -- still at the intent question. intentAttempts cannot be
    // recovered (a failed/ambiguous attempt never writes a qualification_answer row by design,
    // so there is nothing to count); it restarts at 0. Safe failure mode: worst case the lead
    // gets one or two extra clarification turns after a restart before HUMAN_HANDOFF, never
    // fewer -- it can never cause a wrong or premature handoff.
    return base;
  }

  const product = lead.productInterest;
  const vertical = productVertical(product);
  // Scoped to this lead's current vertical -- guards against a prior, unrelated qualification
  // round (e.g. NURTURE_C -> re-engaged with a different product) leaving stale rows behind.
  // Does not fully guard SAVINGS<->RETIREMENT_PPR re-entry with a different product in the same
  // PATRIMONIAL vertical, since they share some field names (urgency, monthly_capacity) -- see
  // the Phase 3B report's known-risks section.
  const latestByField = new Map<string, AnswerRecord>();
  for (const answer of answers) {
    if (answer.vertical !== vertical) continue;
    latestByField.set(answer.fieldName, { fieldName: answer.fieldName, value: String(answer.fieldValue), neededRetry: false });
  }

  const recordedAnswers: Record<string, AnswerRecord> = {};
  for (const [field, record] of latestByField) recordedAnswers[field] = record;

  const location: ResidenceLocation = {};
  if (latestByField.has("residence_city")) location.city = latestByField.get("residence_city")!.value;
  if (latestByField.has("residence_state")) location.state = latestByField.get("residence_state")!.value;
  if (latestByField.has("postal_code")) location.postalCode = latestByField.get("postal_code")!.value;

  const steps = stepsForProduct(product);
  let currentStepIndex = steps.length;
  for (let i = 0; i < steps.length; i++) {
    const complete = steps[i].fieldNames.every((f) => latestByField.has(f));
    if (!complete) {
      currentStepIndex = i;
      break;
    }
  }

  return {
    ...base,
    phase: currentStepIndex >= steps.length ? "COMPLETED" : "AWAITING_ANSWER",
    product,
    currentStepIndex,
    answers: recordedAnswers,
    location,
  };
}
