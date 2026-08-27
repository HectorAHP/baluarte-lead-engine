import { describe, expect, it } from "vitest";
import { advanceQualification, computeEngagementLevel } from "../src/application/qualification-engine.js";
import { initialQualificationState, type QualificationState } from "../src/domain/qualification-state.js";
import { QUALIFIER_HUMAN_HANDOFF_MESSAGE, HEALTH_HANDOFF_MESSAGE } from "../src/domain/message-templates.js";

function send(state: QualificationState, text: string) {
  return advanceQualification(state, text);
}

describe("advanceQualification -- intent stage", () => {
  it("asks for clarification on an ambiguous first message, then hands off after a 2nd ambiguous attempt", () => {
    let state = initialQualificationState();
    const r1 = send(state, "hola");
    expect(r1.outcome.kind).toBe("NEEDS_CLARIFICATION");
    state = r1.state;

    const r2 = send(state, "no sé, algo");
    expect(r2.outcome).toEqual({ kind: "HUMAN_HANDOFF", reason: "INTENT_UNRESOLVED", message: QUALIFIER_HUMAN_HANDOFF_MESSAGE });
    expect(r2.state.phase).toBe("HUMAN_HANDOFF");
  });

  it("routes menu option 4 straight to human handoff", () => {
    const r = send(initialQualificationState(), "4");
    expect(r.outcome).toEqual({ kind: "HUMAN_HANDOFF", reason: "OTHER_TOPIC", message: QUALIFIER_HUMAN_HANDOFF_MESSAGE });
  });
});

describe("advanceQualification -- SAVINGS full flow", () => {
  it("walks the full catalog and completes with all answers recorded", () => {
    let state = initialQualificationState();
    let r = send(state, "quiero ahorrar");
    expect(r.outcome.kind).toBe("ASK");
    state = r.state;
    expect(state.product).toBe("SAVINGS");

    r = send(state, "1"); // objective: patrimonio
    state = r.state;
    r = send(state, "2"); // timeline: 3-5 years
    state = r.state;
    r = send(state, "3"); // monthly_capacity: 5000_9999
    state = r.state;
    r = send(state, "sí"); // extra_contributions
    state = r.state;
    r = send(state, "1"); // urgency: this month
    state = r.state;

    expect(r.outcome.kind).toBe("QUALIFICATION_COMPLETE");
    if (r.outcome.kind !== "QUALIFICATION_COMPLETE") throw new Error("unreachable");
    expect(r.outcome.product).toBe("SAVINGS");
    expect(r.outcome.vertical).toBe("PATRIMONIAL");
    expect(r.outcome.answers.objective.value).toBe("PATRIMONIO");
    expect(r.outcome.answers.timeline.value).toBe("3_5_YEARS");
    expect(r.outcome.answers.monthly_capacity.value).toBe("5000_9999");
    expect(r.outcome.answers.extra_contributions.value).toBe("YES");
    expect(r.outcome.answers.urgency.value).toBe("THIS_MONTH");
    expect(r.outcome.engagement).toBe("ALL_ANSWERED");
  });

  it("re-asks (without advancing) on an unparseable answer, then records it once understood", () => {
    let state = send(initialQualificationState(), "quiero invertir").state;
    const r1 = send(state, "no sé qué decir");
    expect(r1.outcome.kind).toBe("NEEDS_CLARIFICATION");
    expect(r1.state.currentStepIndex).toBe(0); // did not advance
    const r2 = send(r1.state, "1");
    expect(r2.outcome.kind).toBe("ASK"); // moved to next question
    expect(r2.state.currentStepIndex).toBe(1);
    expect(r2.state.retriedStepIds).toContain("objective");
  });
});

describe("advanceQualification -- RETIREMENT_PPR full flow", () => {
  it("walks the full PPR catalog", () => {
    let state = send(initialQualificationState(), "ppr").state;
    expect(state.product).toBe("RETIREMENT_PPR");

    state = send(state, "3").state; // age_range 40-49
    state = send(state, "3").state; // objective: both
    state = send(state, "4").state; // monthly_capacity 10000-19999
    state = send(state, "empresario").state; // fiscal_situation
    const r = send(state, "2"); // urgency 1-3 months

    expect(r.outcome.kind).toBe("QUALIFICATION_COMPLETE");
    if (r.outcome.kind !== "QUALIFICATION_COMPLETE") throw new Error("unreachable");
    expect(r.outcome.answers.age_range.value).toBe("40_49");
    expect(r.outcome.answers.retirement_objective.value).toBe("BOTH");
    expect(r.outcome.answers.fiscal_situation.value).toBe("BUSINESS_OWNER");
    expect(r.outcome.answers.urgency.value).toBe("ONE_TO_THREE_MONTHS");
  });
});

describe("advanceQualification -- GMM full flow and location handling", () => {
  function startGmm() {
    return send(initialQualificationState(), "seguro médico").state;
  }

  it("walks the full GMM catalog, capturing city/state/postal in one combined answer", () => {
    let state = startGmm();
    state = send(state, "3").state; // coverage_type: family
    state = send(state, "2").state; // age_range 30-39
    let r = send(state, "León, Guanajuato, 37150");
    expect(r.outcome.kind).toBe("ASK"); // location complete, moved to priority
    state = r.state;
    expect(state.location).toEqual({ city: "Leon", state: "Guanajuato", postalCode: "37150" });

    state = send(state, "1").state; // priority: price
    state = send(state, "no").state; // has_current_insurance
    r = send(state, "1"); // urgency: this month

    expect(r.outcome.kind).toBe("QUALIFICATION_COMPLETE");
    if (r.outcome.kind !== "QUALIFICATION_COMPLETE") throw new Error("unreachable");
    expect(r.outcome.answers.residence_city.value).toBe("Leon");
    expect(r.outcome.answers.residence_state.value).toBe("Guanajuato");
    expect(r.outcome.answers.postal_code.value).toBe("37150");
    expect(r.outcome.answers.has_current_insurance.value).toBe("NO");
  });

  it("asks only for the missing location field across turns, keeping what was already captured", () => {
    let state = startGmm();
    state = send(state, "1").state;
    state = send(state, "1").state;

    let r = send(state, "León"); // city only
    expect(r.outcome).toMatchObject({ kind: "ASK" });
    state = r.state;
    expect(state.location).toEqual({ city: "Leon" });

    r = send(state, "Guanajuato"); // state only
    expect(r.outcome).toMatchObject({ kind: "ASK", message: expect.stringContaining("código postal") });
    state = r.state;
    expect(state.location).toEqual({ city: "Leon", state: "Guanajuato" });

    r = send(state, "37150");
    expect(r.outcome.kind).toBe("ASK"); // location now complete, moves to priority question
    expect(r.state.location).toEqual({ city: "Leon", state: "Guanajuato", postalCode: "37150" });
  });

  it("does not accept a hedge/non-answer as a city, does not advance, and re-asks only the missing field", () => {
    let state = startGmm();
    state = send(state, "1").state;
    state = send(state, "1").state;

    const r = send(state, "no sé");
    expect(r.outcome.kind).toBe("NEEDS_CLARIFICATION");
    expect(r.state.currentStepIndex).toBe(state.currentStepIndex); // did not advance past LOCATION
    expect(r.state.location).toEqual({}); // nothing persisted
    expect(r.state.answers.residence_city).toBeUndefined();
  });

  it("keeps an already-confirmed city when a later message is an unrecognized hedge answer", () => {
    let state = startGmm();
    state = send(state, "1").state;
    state = send(state, "1").state;
    state = send(state, "León").state; // city confirmed, state/postal still missing

    const r = send(state, "por ahí");
    expect(r.outcome.kind).toBe("NEEDS_CLARIFICATION");
    expect(r.state.location).toEqual({ city: "Leon" }); // preserved, not cleared
  });

  // These three tests deliberately keep the location step *incomplete* (only "city" given)
  // before introducing the contradiction -- once all three fields are captured the engine
  // advances past the LOCATION step to the next question, so a contradiction can only be
  // exercised here while state/postal are still outstanding.
  it("asks for confirmation on a contradictory location answer instead of silently overwriting", () => {
    let state = startGmm();
    state = send(state, "1").state;
    state = send(state, "1").state;
    state = send(state, "León").state;

    const r = send(state, "vivo en Guadalajara");
    expect(r.outcome.kind).toBe("NEEDS_LOCATION_CONFIRMATION");
    expect(r.state.phase).toBe("AWAITING_LOCATION_CONFIRMATION");
    expect(r.state.location.city).toBe("Leon"); // not overwritten yet
  });

  it("applies the corrected value when the user confirms the new one, then keeps asking for what's still missing", () => {
    let state = startGmm();
    state = send(state, "1").state;
    state = send(state, "1").state;
    state = send(state, "León").state;
    state = send(state, "vivo en Guadalajara").state;

    const r = send(state, "sí");
    expect(r.state.location.city).toBe("Guadalajara");
    expect(r.state.phase).toBe("AWAITING_ANSWER");
    expect(r.outcome.kind).toBe("ASK"); // state/postal still missing
  });

  it("keeps the original value when the user declines the correction", () => {
    let state = startGmm();
    state = send(state, "1").state;
    state = send(state, "1").state;
    state = send(state, "León").state;
    state = send(state, "vivo en Guadalajara").state;

    const r = send(state, "no");
    expect(r.state.location.city).toBe("Leon");
  });

  it("escalates to human handoff on spontaneous medical information and never persists it as an answer", () => {
    let state = startGmm();
    state = send(state, "1").state;

    const r = send(state, "tengo diabetes y estoy en tratamiento");
    expect(r.outcome).toEqual({ kind: "HUMAN_HANDOFF", reason: "SENSITIVE_HEALTH_INFO", message: HEALTH_HANDOFF_MESSAGE });
    expect(r.state.phase).toBe("HUMAN_HANDOFF");
    expect(Object.keys(r.state.answers)).not.toContain("age_range");
    expect(JSON.stringify(r.state.answers)).not.toMatch(/diabetes|tratamiento/i);
  });
});

describe("advanceQualification -- handoff triggers", () => {
  it("escalates on an explicit request to speak with a human", () => {
    const state = send(initialQualificationState(), "1").state;
    const r = send(state, "quiero hablar con una persona");
    expect(r.outcome).toEqual({ kind: "HUMAN_HANDOFF", reason: "REQUESTS_HUMAN", message: QUALIFIER_HUMAN_HANDOFF_MESSAGE });
  });

  it("escalates on a complaint/claim", () => {
    const state = send(initialQualificationState(), "1").state;
    const r = send(state, "quiero poner una queja");
    expect(r.outcome).toMatchObject({ kind: "HUMAN_HANDOFF", reason: "COMPLAINT_OR_CLAIM" });
  });

  it("escalates on a specific fiscal-advice request during PPR", () => {
    const state = send(initialQualificationState(), "ppr").state;
    const r = send(state, "¿cuánto puedo deducir de impuestos exactamente?");
    expect(r.outcome).toMatchObject({ kind: "HUMAN_HANDOFF", reason: "FISCAL_ADVICE_REQUEST" });
  });
});

describe("advanceQualification -- opt-out and idempotency", () => {
  it("honors opt-out mid-qualification without advancing state", () => {
    const state = send(initialQualificationState(), "1").state;
    const r = send(state, "ya no me escriban");
    expect(r.outcome).toEqual({ kind: "OPT_OUT" });
    expect(r.state).toBe(state); // unchanged
  });

  it("does not advance further once already COMPLETED (idempotency guard)", () => {
    let state = send(initialQualificationState(), "1").state;
    state = send(state, "1").state;
    state = send(state, "1").state;
    state = send(state, "1").state;
    state = send(state, "sí").state;
    const completed = send(state, "1");
    expect(completed.outcome.kind).toBe("QUALIFICATION_COMPLETE");

    const again = send(completed.state, "otro mensaje cualquiera");
    expect(again.outcome).toEqual({ kind: "ALREADY_TERMINAL" });
    expect(again.state).toBe(completed.state);
  });

  it("does not re-send a handoff message once already in HUMAN_HANDOFF", () => {
    let state = send(initialQualificationState(), "4").state;
    expect(state.phase).toBe("HUMAN_HANDOFF");
    const r = send(state, "otro mensaje");
    expect(r.outcome).toEqual({ kind: "ALREADY_TERMINAL" });
  });
});

describe("computeEngagementLevel", () => {
  it("is ALL_ANSWERED with zero retries", () => {
    expect(computeEngagementLevel(0, 5)).toBe("ALL_ANSWERED");
  });
  it("is MOST_ANSWERED with some but not all steps retried", () => {
    expect(computeEngagementLevel(2, 5)).toBe("MOST_ANSWERED");
  });
  it("is LOW when every step needed a retry", () => {
    expect(computeEngagementLevel(5, 5)).toBe("LOW");
  });
});
