import { describe, expect, it } from "vitest";
import { reconstructQualificationState } from "../src/application/qualification-state-reconstruction.js";
import { advanceQualification } from "../src/application/qualification-engine.js";
import type { Lead } from "../src/domain/lead.js";
import type { QualificationAnswer } from "../src/domain/qualification-answer.js";

function baseLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1", createdAt: new Date(), updatedAt: new Date(), country: "MX",
    productVertical: "PATRIMONIAL", status: "QUALIFYING", score: 0,
    assignedAdvisor: "Hector Herrera", consentContact: true,
    ...overrides,
  };
}

function answer(overrides: Partial<QualificationAnswer>): QualificationAnswer {
  return {
    id: "a-1", leadId: "lead-1", vertical: "PATRIMONIAL", fieldName: "objective", fieldValue: "PATRIMONIO",
    source: "MANUAL", createdAt: new Date(), ...overrides,
  };
}

describe("reconstructQualificationState", () => {
  it("resumes at AWAITING_INTENT for a lead with no productInterest yet", () => {
    const state = reconstructQualificationState(baseLead({ status: "CONTACTED", productInterest: undefined }), []);
    expect(state.phase).toBe("AWAITING_INTENT");
    expect(state.product).toBeNull();
  });

  it("resumes a SAVINGS flow mid-flight at the correct next step", () => {
    const answers = [
      answer({ fieldName: "objective", fieldValue: "PATRIMONIO" }),
      answer({ fieldName: "timeline", fieldValue: "3_5_YEARS" }),
    ];
    const state = reconstructQualificationState(baseLead({ productInterest: "SAVINGS" }), answers);
    expect(state.phase).toBe("AWAITING_ANSWER");
    expect(state.product).toBe("SAVINGS");
    expect(state.currentStepIndex).toBe(2); // objective, timeline done -> next is monthly_capacity
    expect(state.answers.objective.value).toBe("PATRIMONIO");

    // Continuing from the reconstructed state answers the *right* question next.
    const { outcome } = advanceQualification(state, "3");
    expect(outcome.kind).toBe("ASK");
    if (outcome.kind === "ASK") expect(outcome.message).toContain("aportaciones extraordinarias");
  });

  it("resumes a RETIREMENT_PPR flow mid-flight", () => {
    const answers = [answer({ fieldName: "age_range", fieldValue: "40_49" })];
    const state = reconstructQualificationState(baseLead({ productInterest: "RETIREMENT_PPR" }), answers);
    expect(state.currentStepIndex).toBe(1); // age_range done -> next is retirement_objective
    expect(state.product).toBe("RETIREMENT_PPR");
  });

  it("resumes a GMM flow with city+state captured but postal code missing, asking only for the CP", () => {
    const answers = [
      answer({ vertical: "GMM", fieldName: "coverage_type", fieldValue: "FAMILY" }),
      answer({ vertical: "GMM", fieldName: "age_range", fieldValue: "30_39" }),
      answer({ vertical: "GMM", fieldName: "residence_city", fieldValue: "Leon" }),
      answer({ vertical: "GMM", fieldName: "residence_state", fieldValue: "Guanajuato" }),
    ];
    const state = reconstructQualificationState(baseLead({ productInterest: "GMM" }), answers);
    expect(state.currentStepIndex).toBe(2); // location step not yet complete
    expect(state.location).toEqual({ city: "Leon", state: "Guanajuato" });

    // The next real answer only needs to supply the postal code -- city/state are not re-asked.
    const { outcome: completed } = advanceQualification(state, "37150");
    expect(completed.kind).toBe("ASK");
    if (completed.kind === "ASK") expect(completed.message).not.toMatch(/ciudad|estado/i);
  });

  it("marks a QUALIFIED_A/B/NURTURE_C lead as COMPLETED -- qualification does not restart", () => {
    const answers = [answer({ fieldName: "objective", fieldValue: "PATRIMONIO" })];
    const state = reconstructQualificationState(baseLead({ status: "QUALIFIED_A", productInterest: "SAVINGS" }), answers);
    expect(state.phase).toBe("COMPLETED");
  });

  it("marks a HUMAN_HANDOFF lead as terminal, never re-entering the qualifier automatically", () => {
    const state = reconstructQualificationState(baseLead({ status: "HUMAN_HANDOFF", productInterest: "GMM" }), []);
    expect(state.phase).toBe("HUMAN_HANDOFF");
    const { outcome } = advanceQualification(state, "hola de nuevo");
    expect(outcome.kind).toBe("ALREADY_TERMINAL");
  });

  it("scopes reconstruction to the lead's current vertical, ignoring answers from an unrelated prior round", () => {
    const answers = [
      answer({ vertical: "GMM", fieldName: "urgency", fieldValue: "THIS_MONTH" }), // stale, different vertical
      answer({ vertical: "PATRIMONIAL", fieldName: "objective", fieldValue: "PATRIMONIO" }),
    ];
    const state = reconstructQualificationState(baseLead({ productInterest: "SAVINGS" }), answers);
    expect(state.answers.urgency).toBeUndefined();
    expect(state.currentStepIndex).toBe(1); // only objective counted
  });
});
