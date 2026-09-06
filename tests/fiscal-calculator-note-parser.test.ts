import { describe, it, expect } from "vitest";
import { formatFiscalCalculatorNote } from "../src/domain/fiscal-calculator-lead-note.js";
import { parseFiscalCalculatorNoteBlocks, findFiscalCalculatorNoteBlockForSubmission } from "../src/domain/fiscal-calculator-note-parser.js";

function sampleNoteInput(overrides: Partial<Parameters<typeof formatFiscalCalculatorNote>[0]> = {}) {
  return {
    age: 32, city: "León", taxRegime: "sueldos", filesAnnualReturn: true,
    monthlyIncome: 100000, annualContribution: 120000,
    deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
    hasGmm: false, hasPpr: false,
    calculation: { annualIncome: 1200000, pprDeductionLimit: 213973, effectivePprContribution: 120000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 24000, estimatedTaxBenefitMax: 36000 },
    submissionId: "092b017c-06ac-44eb-aeff-d39545575fb1",
    submittedAt: new Date("2026-09-04T20:00:20.468Z"),
    ...overrides,
  };
}

describe("fiscal-calculator-note-parser -- round-trip against the real formatter", () => {
  it("recovers every field the note format actually carries, matching real observed HubSpot values (Fase 7C live audit)", () => {
    const input = sampleNoteInput();
    const note = formatFiscalCalculatorNote(input);
    const parsed = findFiscalCalculatorNoteBlockForSubmission(note, input.submissionId);

    expect(parsed).not.toBeNull();
    expect(parsed!.age).toBe(32);
    expect(parsed!.city).toBe("León");
    expect(parsed!.taxRegime).toBe("sueldos");
    expect(parsed!.filesAnnualReturn).toBe(true);
    expect(parsed!.monthlyIncome).toBe(100000);
    expect(parsed!.annualIncome).toBe(1200000);
    expect(parsed!.annualContribution).toBe(120000);
    expect(parsed!.effectivePprContribution).toBe(120000);
    expect(parsed!.pprDeductionLimit).toBe(213973);
    expect(parsed!.personalDeductionsTotal).toBe(0);
    expect(parsed!.otherDeductionsConsidered).toBe(0);
    expect(parsed!.hasGmm).toBe(false);
    expect(parsed!.hasPpr).toBe(false);
    expect(parsed!.estimatedTaxBenefitMin).toBe(24000);
    expect(parsed!.estimatedTaxBenefitMax).toBe(36000);
    expect(parsed!.submissionId).toBe(input.submissionId);
  });

  it("undefined/unset optional fields round-trip as undefined, never a fabricated value", () => {
    const input = sampleNoteInput({ age: undefined, city: undefined, taxRegime: undefined, filesAnnualReturn: undefined, hasGmm: undefined, hasPpr: undefined });
    const note = formatFiscalCalculatorNote(input);
    const parsed = findFiscalCalculatorNoteBlockForSubmission(note, input.submissionId);
    expect(parsed!.age).toBeUndefined();
    expect(parsed!.city).toBeUndefined();
    expect(parsed!.taxRegime).toBeUndefined();
    expect(parsed!.filesAnnualReturn).toBeUndefined();
    expect(parsed!.hasGmm).toBeUndefined();
    expect(parsed!.hasPpr).toBeUndefined();
  });

  it("the 4 individual deductions are NEVER recoverable -- only their sum -- documented limitation", () => {
    const input = sampleNoteInput({ deductions: { medicalExpenses: 5000, tuition: 3000, mortgageInterest: 2000, other: 1000 } });
    const note = formatFiscalCalculatorNote(input);
    const parsed = findFiscalCalculatorNoteBlockForSubmission(note, input.submissionId);
    expect(parsed!.personalDeductionsTotal).toBe(11000); // the sum is recoverable
    expect(parsed).not.toHaveProperty("medicalExpenses"); // the individual figures are structurally absent from the type
  });

  it("multiple appended blocks (a lead who ran the calculator twice) are each found independently by submissionId", () => {
    const first = sampleNoteInput({ submissionId: "sub-1", monthlyIncome: 50000 });
    const second = sampleNoteInput({ submissionId: "sub-2", monthlyIncome: 90000 });
    const notes = `${formatFiscalCalculatorNote(first)}\n\n${formatFiscalCalculatorNote(second)}`;

    const blocks = parseFiscalCalculatorNoteBlocks(notes);
    expect(blocks).toHaveLength(2);
    expect(findFiscalCalculatorNoteBlockForSubmission(notes, "sub-1")?.monthlyIncome).toBe(50000);
    expect(findFiscalCalculatorNoteBlockForSubmission(notes, "sub-2")?.monthlyIncome).toBe(90000);
  });

  it("a submissionId truncated away (or never present) resolves to null, never a wrong/guessed block", () => {
    const note = formatFiscalCalculatorNote(sampleNoteInput({ submissionId: "sub-real" }));
    expect(findFiscalCalculatorNoteBlockForSubmission(note, "sub-nonexistent")).toBeNull();
    expect(findFiscalCalculatorNoteBlockForSubmission(undefined, "sub-real")).toBeNull();
    expect(findFiscalCalculatorNoteBlockForSubmission("", "sub-real")).toBeNull();
  });

  it("a corrupted/incomplete block (simulating truncation mid-block) is skipped, never returned partially parsed", () => {
    const note = formatFiscalCalculatorNote(sampleNoteInput({ submissionId: "sub-cut" }));
    const truncated = note.split("\n").slice(0, 4).join("\n"); // cut off before submissionId line even exists
    expect(findFiscalCalculatorNoteBlockForSubmission(truncated, "sub-cut")).toBeNull();
  });

  it("free-form unrelated text before/after a real block does not confuse the parser", () => {
    const note = `Llamó el cliente el martes, pidió reagendar.\n\n${formatFiscalCalculatorNote(sampleNoteInput({ submissionId: "sub-x" }))}\n\nNota del asesor: cliente interesado en GMM también.`;
    const parsed = findFiscalCalculatorNoteBlockForSubmission(note, "sub-x");
    expect(parsed).not.toBeNull();
    expect(parsed!.submissionId).toBe("sub-x");
  });
});
