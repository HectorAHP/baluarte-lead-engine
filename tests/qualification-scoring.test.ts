import { describe, expect, it } from "vitest";
import {
  scorePatrimonialQualification,
  scoreGmmQualification,
  PATRIMONIAL_QUALIFICATION_RULES_VERSION,
  GMM_QUALIFICATION_RULES_VERSION,
} from "../src/domain/qualification-scoring.js";

describe("scorePatrimonialQualification", () => {
  it("classifies A for a strong lead (>=75)", () => {
    const r = scorePatrimonialQualification({
      urgency: "THIS_MONTH",
      monthlyCapacity: "20000_PLUS",
      objectiveClarity: "CLEAR",
      engagement: "ALL_ANSWERED",
      readiness: "ACCEPTS_MEETING",
    });
    expect(r.total).toBe(100);
    expect(r.scoreClass).toBe("A");
  });

  it("classifies B for a mid lead (50-74)", () => {
    const r = scorePatrimonialQualification({
      urgency: "ONE_TO_THREE_MONTHS",
      monthlyCapacity: "5000_9999",
      objectiveClarity: "PARTIAL",
      engagement: "MOST_ANSWERED",
      readiness: "WANTS_INFO_FIRST",
    });
    expect(r.total).toBe(67);
    expect(r.scoreClass).toBe("B");
  });

  it("classifies C for a weak lead (<50)", () => {
    const r = scorePatrimonialQualification({
      urgency: "COMPARING",
      monthlyCapacity: "LT_2000",
      objectiveClarity: "AMBIGUOUS",
      engagement: "LOW",
      readiness: "DECLINES",
    });
    expect(r.total).toBe(23);
    expect(r.scoreClass).toBe("C");
  });

  it("returns an explicit, auditable breakdown that sums to the total", () => {
    const r = scorePatrimonialQualification({
      urgency: "THIS_MONTH",
      monthlyCapacity: "10000_19999",
      objectiveClarity: "CLEAR",
      engagement: "ALL_ANSWERED",
      readiness: "ACCEPTS_MEETING",
    });
    const sum = Object.values(r.breakdown).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.total);
    expect(Object.keys(r.breakdown).sort()).toEqual(["engagement", "monthlyCapacity", "productFitClarity", "readiness", "urgency"].sort());
  });

  it("stamps rulesVersion and calculatedAt", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const r = scorePatrimonialQualification(
      { urgency: "THIS_MONTH", monthlyCapacity: "20000_PLUS", objectiveClarity: "CLEAR", engagement: "ALL_ANSWERED", readiness: "ACCEPTS_MEETING" },
      now,
    );
    expect(r.rulesVersion).toBe(PATRIMONIAL_QUALIFICATION_RULES_VERSION);
    expect(r.calculatedAt).toBe(now);
  });
});

describe("scoreGmmQualification", () => {
  it("classifies A for a strong lead without using any medical information", () => {
    const r = scoreGmmQualification({
      urgency: "THIS_MONTH",
      needClarity: "CLEAR",
      locationCompleteness: "COMPLETE",
      hasCurrentInsurance: false,
      engagement: "ALL_ANSWERED",
      readiness: "ACCEPTS_MEETING",
    });
    expect(r.total).toBe(100);
    expect(r.scoreClass).toBe("A");
    expect(r.rulesVersion).toBe(GMM_QUALIFICATION_RULES_VERSION);
    expect(JSON.stringify(r)).not.toMatch(/diagnostic|enfermedad|medicament/i);
  });

  it("classifies C for a weak/uncertain lead", () => {
    const r = scoreGmmQualification({
      urgency: "COMPARING",
      needClarity: "AMBIGUOUS",
      locationCompleteness: "NONE",
      hasCurrentInsurance: "UNKNOWN",
      engagement: "LOW",
      readiness: "DECLINES",
    });
    expect(r.scoreClass).toBe("C");
  });

  it("scores a lead with an existing policy lower on the insurance-gap signal than one without", () => {
    const withoutInsurance = scoreGmmQualification({
      urgency: "THIS_MONTH", needClarity: "CLEAR", locationCompleteness: "COMPLETE",
      hasCurrentInsurance: false, engagement: "ALL_ANSWERED", readiness: "ACCEPTS_MEETING",
    });
    const withInsurance = scoreGmmQualification({
      urgency: "THIS_MONTH", needClarity: "CLEAR", locationCompleteness: "COMPLETE",
      hasCurrentInsurance: true, engagement: "ALL_ANSWERED", readiness: "ACCEPTS_MEETING",
    });
    expect(withoutInsurance.breakdown.insuranceGapSignal).toBeGreaterThan(withInsurance.breakdown.insuranceGapSignal);
  });

  it("breakdown sums to total and totals 100 points possible", () => {
    const r = scoreGmmQualification({
      urgency: "THIS_MONTH", needClarity: "CLEAR", locationCompleteness: "COMPLETE",
      hasCurrentInsurance: false, engagement: "ALL_ANSWERED", readiness: "ACCEPTS_MEETING",
    });
    const sum = Object.values(r.breakdown).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.total);
    expect(r.total).toBe(100);
  });
});
