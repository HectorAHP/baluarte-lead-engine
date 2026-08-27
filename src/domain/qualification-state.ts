import type { QualificationProduct } from "./qualification-fields.js";
import type { ResidenceLocation } from "./location-parser.js";

export type QualificationPhase =
  | "AWAITING_INTENT"
  | "AWAITING_ANSWER"
  | "AWAITING_LOCATION_CONFIRMATION"
  | "COMPLETED"
  | "HUMAN_HANDOFF";

export interface AnswerRecord {
  fieldName: string;
  value: string;
  /** Whether the field was captured on the first attempt at its question, or needed a
   * re-ask/clarification -- feeds the ENGAGEMENT scoring component. */
  neededRetry: boolean;
}

export interface PendingLocationConfirmation {
  field: keyof ResidenceLocation;
  existingValue: string;
  newValue: string;
}

export interface QualificationState {
  phase: QualificationPhase;
  product: QualificationProduct | null;
  /** Index into stepsForProduct(product); meaningless while product is null. */
  currentStepIndex: number;
  intentAttempts: number;
  /** fieldName -> recorded answer. LOCATION steps additionally populate `location`. */
  answers: Record<string, AnswerRecord>;
  location: ResidenceLocation;
  pendingLocationConfirmation: PendingLocationConfirmation | null;
  /** Step ids that needed at least one re-ask/clarification before being resolved -- feeds the
   * ENGAGEMENT scoring component at completion. */
  retriedStepIds: string[];
  /** Set when phase becomes HUMAN_HANDOFF, for audit/logging -- never a UI-facing value. */
  handoffReason: string | null;
}

export function initialQualificationState(): QualificationState {
  return {
    phase: "AWAITING_INTENT",
    product: null,
    currentStepIndex: 0,
    intentAttempts: 0,
    answers: {},
    location: {},
    pendingLocationConfirmation: null,
    retriedStepIds: [],
    handoffReason: null,
  };
}
