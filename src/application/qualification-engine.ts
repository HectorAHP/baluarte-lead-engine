import { classifyIntent } from "../domain/intent-classifier.js";
import { parseOptionAnswer, parseYesNoMaybe } from "../domain/answer-parser.js";
import { parseLocationAnswer, missingLocationFields, type ResidenceLocation } from "../domain/location-parser.js";
import { stepsForProduct, type QualificationStep } from "../domain/qualification-catalog.js";
import { detectHandoffTrigger } from "../domain/qualification-handoff-triggers.js";
import { redactSensitiveHealthContent } from "../domain/health-redaction.js";
import { isOptOutMessage } from "../domain/opt-out-detection.js";
import { productVertical, type QualificationProduct, type QualificationVertical } from "../domain/qualification-fields.js";
import { QUALIFIER_HUMAN_HANDOFF_MESSAGE, HEALTH_HANDOFF_MESSAGE } from "../domain/message-templates.js";
import type { EngagementLevel } from "../domain/qualification-scoring.js";
import { initialQualificationState, type QualificationState, type AnswerRecord } from "../domain/qualification-state.js";

const MAX_INTENT_ATTEMPTS = 2;

const INITIAL_MENU_PROMPT =
  "¿Buscas información sobre:\n\n1. Ahorro e inversión\n2. Retiro / PPR\n3. Gastos Médicos Mayores\n4. Otro tema?";

const CLARIFICATION_PROMPT =
  `No estoy seguro de haber entendido. ${INITIAL_MENU_PROMPT}`;

function missingFieldPromptEs(field: keyof ResidenceLocation): string {
  if (field === "city") return "¿En qué ciudad resides?";
  if (field === "state") return "¿En qué estado resides?";
  return "¿Cuál es tu código postal (5 dígitos)?";
}

function fieldLabelEs(field: keyof ResidenceLocation): string {
  return field === "city" ? "ciudad" : field === "state" ? "estado" : "código postal";
}

export interface QualificationAdvanceResult {
  state: QualificationState;
  outcome: QualificationOutcome;
}

export type QualificationOutcome =
  | { kind: "OPT_OUT" }
  | { kind: "ASK"; message: string }
  | { kind: "NEEDS_CLARIFICATION"; message: string }
  | { kind: "NEEDS_LOCATION_CONFIRMATION"; message: string }
  | { kind: "HUMAN_HANDOFF"; reason: string; message: string }
  /** Phase is already COMPLETED or HUMAN_HANDOFF from a prior message -- idempotency guard, no
   * automated reply. Matches the production webhook's existing "already suppressed" behavior. */
  | { kind: "ALREADY_TERMINAL" }
  | {
      kind: "QUALIFICATION_COMPLETE";
      product: QualificationProduct;
      vertical: QualificationVertical;
      answers: Record<string, AnswerRecord>;
      location: ResidenceLocation;
      engagement: EngagementLevel;
    };

function markRetried(state: QualificationState, stepId: string): QualificationState {
  if (state.retriedStepIds.includes(stepId)) return state;
  return { ...state, retriedStepIds: [...state.retriedStepIds, stepId] };
}

function recordAnswer(state: QualificationState, fieldName: string, value: string, stepId: string): QualificationState {
  return {
    ...state,
    answers: { ...state.answers, [fieldName]: { fieldName, value, neededRetry: state.retriedStepIds.includes(stepId) } },
  };
}

function handoff(state: QualificationState, reason: string, message: string): QualificationAdvanceResult {
  return { state: { ...state, phase: "HUMAN_HANDOFF", handoffReason: reason }, outcome: { kind: "HUMAN_HANDOFF", reason, message } };
}

export function computeEngagementLevel(retriedStepCount: number, totalSteps: number): EngagementLevel {
  if (retriedStepCount === 0) return "ALL_ANSWERED";
  if (retriedStepCount < totalSteps) return "MOST_ANSWERED";
  return "LOW";
}

function advanceToNextStepOrComplete(state: QualificationState, steps: readonly QualificationStep[]): QualificationAdvanceResult {
  const nextIndex = state.currentStepIndex + 1;
  if (nextIndex >= steps.length) {
    const completedState: QualificationState = { ...state, phase: "COMPLETED", currentStepIndex: nextIndex };
    const engagement = computeEngagementLevel(state.retriedStepIds.length, steps.length);
    return {
      state: completedState,
      outcome: {
        kind: "QUALIFICATION_COMPLETE",
        product: state.product as QualificationProduct,
        vertical: productVertical(state.product as QualificationProduct),
        answers: completedState.answers,
        location: completedState.location,
        engagement,
      },
    };
  }
  const nextState = { ...state, currentStepIndex: nextIndex };
  return { state: nextState, outcome: { kind: "ASK", message: steps[nextIndex].prompt } };
}

function handleLocationStep(state: QualificationState, step: QualificationStep, steps: readonly QualificationStep[], text: string): QualificationAdvanceResult {
  const result = parseLocationAnswer(text, state.location);

  if (result.contradiction) {
    const pendingState: QualificationState = {
      ...state,
      phase: "AWAITING_LOCATION_CONFIRMATION",
      pendingLocationConfirmation: result.contradiction,
    };
    const label = fieldLabelEs(result.contradiction.field);
    return {
      state: pendingState,
      outcome: {
        kind: "NEEDS_LOCATION_CONFIRMATION",
        message: `Antes me compartiste que tu ${label} es "${result.contradiction.existingValue}", pero ahora mencionas "${result.contradiction.newValue}". ¿Es correcto "${result.contradiction.newValue}"?`,
      },
    };
  }

  const mergedLocation: ResidenceLocation = { ...state.location, ...result.extracted };
  const missing = missingLocationFields(mergedLocation);

  if (missing.length > 0) {
    const retriedState = markRetried({ ...state, location: mergedLocation }, step.id);
    // result.unrecognized means the leftover text read as a hedge/non-answer ("no sé", "por
    // ahí", ...) rather than a place name -- extracted.city was deliberately left unset by the
    // parser, so mergedLocation gained nothing from it here. Never persisted, never advances;
    // only the wording differs from a plain re-ask, to acknowledge the answer wasn't understood.
    const message = result.unrecognized
      ? `No logré identificar ese dato. ${missingFieldPromptEs(missing[0])}`
      : missingFieldPromptEs(missing[0]);
    return { state: retriedState, outcome: { kind: result.unrecognized ? "NEEDS_CLARIFICATION" : "ASK", message } };
  }

  const completeState: QualificationState = {
    ...state,
    location: mergedLocation,
    answers: {
      ...state.answers,
      residence_city: { fieldName: "residence_city", value: mergedLocation.city as string, neededRetry: state.retriedStepIds.includes(step.id) },
      residence_state: { fieldName: "residence_state", value: mergedLocation.state as string, neededRetry: state.retriedStepIds.includes(step.id) },
      postal_code: { fieldName: "postal_code", value: mergedLocation.postalCode as string, neededRetry: state.retriedStepIds.includes(step.id) },
    },
  };
  return advanceToNextStepOrComplete(completeState, steps);
}

function handlePendingLocationConfirmation(state: QualificationState, steps: readonly QualificationStep[], text: string): QualificationAdvanceResult {
  const pending = state.pendingLocationConfirmation as NonNullable<QualificationState["pendingLocationConfirmation"]>;
  const answer = parseYesNoMaybe(text);

  if (answer === null) {
    return {
      state,
      outcome: {
        kind: "NEEDS_LOCATION_CONFIRMATION",
        message: `¿Es correcto "${pending.newValue}" para tu ${fieldLabelEs(pending.field)}? Responde sí o no.`,
      },
    };
  }

  const resolvedValue = answer === "YES" ? pending.newValue : pending.existingValue;
  const resolvedLocation: ResidenceLocation = { ...state.location, [pending.field]: resolvedValue };
  const resumedState: QualificationState = { ...state, phase: "AWAITING_ANSWER", pendingLocationConfirmation: null, location: resolvedLocation };

  const step = steps[state.currentStepIndex];
  const missing = missingLocationFields(resolvedLocation);
  if (missing.length > 0) {
    return { state: markRetried(resumedState, step.id), outcome: { kind: "ASK", message: missingFieldPromptEs(missing[0]) } };
  }
  const completeState: QualificationState = {
    ...resumedState,
    answers: {
      ...resumedState.answers,
      residence_city: { fieldName: "residence_city", value: resolvedLocation.city as string, neededRetry: true },
      residence_state: { fieldName: "residence_state", value: resolvedLocation.state as string, neededRetry: true },
      postal_code: { fieldName: "postal_code", value: resolvedLocation.postalCode as string, neededRetry: true },
    },
  };
  return advanceToNextStepOrComplete(completeState, steps);
}

/**
 * The single pure entry point for Phase 3A: given the qualifier's current state and one inbound
 * text message, returns the next state and what to do about it. No side effects -- no repository
 * calls, no WhatsApp send, no Google Calendar access. Phase 3B wires this to
 * WhatsAppInboundService and real persistence; this function is unaware of both.
 */
export function advanceQualification(state: QualificationState, inboundText: string, _now: Date = new Date()): QualificationAdvanceResult {
  if (isOptOutMessage(inboundText)) {
    return { state, outcome: { kind: "OPT_OUT" } };
  }

  // Checked before any phase-specific branching, not only during AWAITING_ANSWER: an explicit
  // request for a human, a complaint, or aggression is an immediate-escalation signal per spec
  // regardless of whether a product has been resolved yet -- a lead who never gets past the
  // welcome menu can still say "quiero hablar con una persona" and must not be routed through
  // 1-2 rounds of "no entendí tu intención" first.
  if (state.phase !== "COMPLETED" && state.phase !== "HUMAN_HANDOFF") {
    const trigger = detectHandoffTrigger(inboundText);
    if (trigger) return handoff(state, trigger, QUALIFIER_HUMAN_HANDOFF_MESSAGE);
  }

  if (state.phase === "AWAITING_INTENT") {
    const classification = classifyIntent(inboundText);

    if (classification.kind === "OTHER") {
      return handoff(state, "OTHER_TOPIC", QUALIFIER_HUMAN_HANDOFF_MESSAGE);
    }

    if (classification.kind === "AMBIGUOUS") {
      const attempts = state.intentAttempts + 1;
      if (attempts >= MAX_INTENT_ATTEMPTS) {
        return handoff({ ...state, intentAttempts: attempts }, "INTENT_UNRESOLVED", QUALIFIER_HUMAN_HANDOFF_MESSAGE);
      }
      return { state: { ...state, intentAttempts: attempts }, outcome: { kind: "NEEDS_CLARIFICATION", message: CLARIFICATION_PROMPT } };
    }

    const product = classification.product;
    const steps = stepsForProduct(product);
    const startedState: QualificationState = { ...state, product, phase: "AWAITING_ANSWER", currentStepIndex: 0 };
    return { state: startedState, outcome: { kind: "ASK", message: steps[0].prompt } };
  }

  if (state.phase === "AWAITING_LOCATION_CONFIRMATION") {
    return handlePendingLocationConfirmation(state, stepsForProduct(state.product as QualificationProduct), inboundText);
  }

  if (state.phase === "AWAITING_ANSWER") {
    const product = state.product as QualificationProduct;
    const steps = stepsForProduct(product);
    const step = steps[state.currentStepIndex];

    if (product === "GMM" && redactSensitiveHealthContent(inboundText).sensitiveDetected) {
      return handoff(state, "SENSITIVE_HEALTH_INFO", HEALTH_HANDOFF_MESSAGE);
    }

    if (step.kind === "LOCATION") {
      return handleLocationStep(state, step, steps, inboundText);
    }

    if (step.kind === "YES_NO_MAYBE") {
      const answer = parseYesNoMaybe(inboundText);
      if (answer === null) {
        return { state: markRetried(state, step.id), outcome: { kind: "NEEDS_CLARIFICATION", message: `No entendí tu respuesta. ${step.prompt}` } };
      }
      const recorded = recordAnswer(state, step.fieldNames[0], answer, step.id);
      return advanceToNextStepOrComplete(recorded, steps);
    }

    // OPTION
    const value = parseOptionAnswer(inboundText, step.options ?? []);
    if (value === null) {
      return { state: markRetried(state, step.id), outcome: { kind: "NEEDS_CLARIFICATION", message: `No entendí tu respuesta. ${step.prompt}` } };
    }
    const recorded = recordAnswer(state, step.fieldNames[0], value, step.id);
    return advanceToNextStepOrComplete(recorded, steps);
  }

  // COMPLETED or HUMAN_HANDOFF: no further automated processing in Phase 3A.
  return { state, outcome: { kind: "ALREADY_TERMINAL" } };
}

export { initialQualificationState, INITIAL_MENU_PROMPT };
