import { describe, it, expect } from "vitest";
import { scoreFiscalCalculatorLead } from "../src/domain/fiscal-lead-scoring.js";
import { FISCAL_SCORE_VERSION } from "../src/domain/fiscal-lead-score.js";

describe("scoreFiscalCalculatorLead -- fiscal_v1 boundaries", () => {
  describe("monthlyIncome brackets", () => {
    it.each([
      [24999, 6, "MONTHLY_INCOME_UNDER_25K"],
      [25000, 12, "MONTHLY_INCOME_25K_34K"],
      [34999, 12, "MONTHLY_INCOME_25K_34K"],
      [35000, 18, "MONTHLY_INCOME_35K_49K"],
      [49999, 18, "MONTHLY_INCOME_35K_49K"],
      [50000, 24, "MONTHLY_INCOME_50K_74K"],
      [74999, 24, "MONTHLY_INCOME_50K_74K"],
      [75000, 30, "MONTHLY_INCOME_75K_99K"],
      [99999, 30, "MONTHLY_INCOME_75K_99K"],
      [100000, 35, "MONTHLY_INCOME_100K_149K"],
      [149999, 35, "MONTHLY_INCOME_100K_149K"],
      [150000, 40, "MONTHLY_INCOME_150K_PLUS"],
    ])("monthlyIncome=%i -> %i points (%s)", (monthlyIncome, points, code) => {
      const result = scoreFiscalCalculatorLead({ monthlyIncome });
      const reason = result.reasons.find((r) => r.code.startsWith("MONTHLY_INCOME"));
      expect(reason).toEqual({ code, points });
    });

    it("no valid monthlyIncome data -> 0 points, MONTHLY_INCOME_MISSING", () => {
      const result = scoreFiscalCalculatorLead({});
      expect(result.reasons.find((r) => r.code.startsWith("MONTHLY_INCOME"))).toEqual({
        code: "MONTHLY_INCOME_MISSING",
        points: 0,
      });
      expect(result.monthlyIncomeBand).toBe("NONE");
    });

    it("monthlyIncome=0 -> treated as no valid data", () => {
      const result = scoreFiscalCalculatorLead({ monthlyIncome: 0 });
      expect(result.reasons.find((r) => r.code.startsWith("MONTHLY_INCOME"))?.code).toBe(
        "MONTHLY_INCOME_MISSING",
      );
    });
  });

  describe("annualContribution brackets", () => {
    it.each([
      [0, 0, "ANNUAL_CONTRIBUTION_NONE"],
      [1, 6, "ANNUAL_CONTRIBUTION_UNDER_18K"],
      [17999, 6, "ANNUAL_CONTRIBUTION_UNDER_18K"],
      [18000, 12, "ANNUAL_CONTRIBUTION_18K_35K"],
      [35999, 12, "ANNUAL_CONTRIBUTION_18K_35K"],
      [36000, 18, "ANNUAL_CONTRIBUTION_36K_59K"],
      [59999, 18, "ANNUAL_CONTRIBUTION_36K_59K"],
      [60000, 24, "ANNUAL_CONTRIBUTION_60K_119K"],
      [119999, 24, "ANNUAL_CONTRIBUTION_60K_119K"],
      [120000, 30, "ANNUAL_CONTRIBUTION_120K_179K"],
      [179999, 30, "ANNUAL_CONTRIBUTION_120K_179K"],
      [180000, 35, "ANNUAL_CONTRIBUTION_180K_PLUS"],
    ])("annualContribution=%i -> %i points (%s)", (annualContribution, points, code) => {
      const result = scoreFiscalCalculatorLead({ annualContribution });
      const reason = result.reasons.find((r) => r.code.startsWith("ANNUAL_CONTRIBUTION"));
      expect(reason).toEqual({ code, points });
    });

    it("no annualContribution -> ANNUAL_CONTRIBUTION_NONE", () => {
      const result = scoreFiscalCalculatorLead({});
      expect(result.reasons.find((r) => r.code.startsWith("ANNUAL_CONTRIBUTION"))).toEqual({
        code: "ANNUAL_CONTRIBUTION_NONE",
        points: 0,
      });
      expect(result.annualContributionBand).toBe("NONE");
    });
  });

  describe("filesAnnualReturn", () => {
    it("true -> 15 points, FILES_ANNUAL_RETURN", () => {
      const result = scoreFiscalCalculatorLead({ filesAnnualReturn: true });
      expect(result.reasons.find((r) => r.code.includes("ANNUAL_RETURN"))).toEqual({
        code: "FILES_ANNUAL_RETURN",
        points: 15,
      });
    });

    it("false -> 0 points, DOES_NOT_FILE_ANNUAL_RETURN", () => {
      const result = scoreFiscalCalculatorLead({ filesAnnualReturn: false });
      expect(result.reasons.find((r) => r.code.includes("ANNUAL_RETURN"))).toEqual({
        code: "DOES_NOT_FILE_ANNUAL_RETURN",
        points: 0,
      });
    });

    it("undefined -> 0 points, DOES_NOT_FILE_ANNUAL_RETURN", () => {
      const result = scoreFiscalCalculatorLead({});
      expect(result.reasons.find((r) => r.code.includes("ANNUAL_RETURN"))).toEqual({
        code: "DOES_NOT_FILE_ANNUAL_RETURN",
        points: 0,
      });
    });
  });

  describe("hasPpr", () => {
    it("hasPpr=true -> 5 points, HAS_EXISTING_PPR", () => {
      const result = scoreFiscalCalculatorLead({ hasPpr: true });
      expect(result.reasons.find((r) => r.code.includes("PPR"))).toEqual({
        code: "HAS_EXISTING_PPR",
        points: 5,
      });
    });

    it("hasPpr=false -> 10 points, NO_EXISTING_PPR", () => {
      const result = scoreFiscalCalculatorLead({ hasPpr: false });
      expect(result.reasons.find((r) => r.code.includes("PPR"))).toEqual({
        code: "NO_EXISTING_PPR",
        points: 10,
      });
    });

    it("hasPpr=undefined -> 0 points, PPR_STATUS_UNKNOWN", () => {
      const result = scoreFiscalCalculatorLead({});
      expect(result.reasons.find((r) => r.code.includes("PPR"))).toEqual({
        code: "PPR_STATUS_UNKNOWN",
        points: 0,
      });
    });
  });

  describe("class boundaries", () => {
    // score=44 -> NURTURE, 45 -> WARM, 69 -> WARM, 70 -> HOT, 100 -> HOT. Each case is built from
    // a bracket combination that sums to the exact target score.
    it("score 44 -> NURTURE", () => {
      // income 25K_34K(12) + contribution 18K_35K(12) + files=true(15) + ppr=true(5) = 44
      const result = scoreFiscalCalculatorLead({
        monthlyIncome: 30000,
        annualContribution: 20000,
        filesAnnualReturn: true,
        hasPpr: true,
      });
      expect(result.score).toBe(44);
      expect(result.scoreClass).toBe("NURTURE");
    });

    it("score 45 -> WARM", () => {
      // income 35K_49K(18) + contribution 18K_35K(12) + files=true(15) + ppr=undefined(0) = 45
      const result = scoreFiscalCalculatorLead({
        monthlyIncome: 40000,
        annualContribution: 20000,
        filesAnnualReturn: true,
        hasPpr: undefined,
      });
      expect(result.score).toBe(45);
      expect(result.scoreClass).toBe("WARM");
    });

    it("score 69 -> WARM", () => {
      // income 100K_149K(35) + contribution 60K_119K(24) + files=false(0) + ppr=false(10) = 69
      const result = scoreFiscalCalculatorLead({
        monthlyIncome: 120000,
        annualContribution: 80000,
        filesAnnualReturn: false,
        hasPpr: false,
      });
      expect(result.score).toBe(69);
      expect(result.scoreClass).toBe("WARM");
    });

    it("score 70 -> HOT", () => {
      // income 100K_149K(35) + contribution 180K_PLUS(35) + files=false(0) + ppr=undefined(0) = 70
      const result = scoreFiscalCalculatorLead({
        monthlyIncome: 120000,
        annualContribution: 200000,
        filesAnnualReturn: false,
        hasPpr: undefined,
      });
      expect(result.score).toBe(70);
      expect(result.scoreClass).toBe("HOT");
    });

    it("score 100 -> HOT (max possible score)", () => {
      const result = scoreFiscalCalculatorLead({
        monthlyIncome: 200000, // 150K_PLUS -> 40
        annualContribution: 200000, // 180K_PLUS -> 35
        filesAnnualReturn: true, // 15
        hasPpr: false, // 10
      });
      expect(result.score).toBe(100);
      expect(result.scoreClass).toBe("HOT");
    });
  });

  it("always returns version fiscal_v1", () => {
    expect(scoreFiscalCalculatorLead({}).version).toBe(FISCAL_SCORE_VERSION);
    expect(FISCAL_SCORE_VERSION).toBe("fiscal_v1");
  });

  it("always returns exactly 4 reason codes, one per rule", () => {
    const result = scoreFiscalCalculatorLead({
      monthlyIncome: 50000,
      annualContribution: 60000,
      filesAnnualReturn: true,
      hasPpr: false,
    });
    expect(result.reasons).toHaveLength(4);
    expect(result.score).toBe(24 + 24 + 15 + 10);
  });

  it("is a pure function -- same input always yields same output", () => {
    const input = { monthlyIncome: 55000, annualContribution: 40000, filesAnnualReturn: true, hasPpr: false };
    const a = scoreFiscalCalculatorLead(input);
    const b = scoreFiscalCalculatorLead(input);
    expect(a).toEqual(b);
  });
});
