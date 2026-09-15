import { describe, it, expect } from "vitest";
import { isAllowedQualificationField } from "../src/domain/qualification-fields.js";

/**
 * Fase 2.2 -- the 30-minute diagnosis call's structured outputs, added to the existing
 * qualification-fields whitelist instead of a new table/columns (see
 * diagnosis-field-mapping.md). Confirms the whitelist gate (QualificationService's real
 * enforcement point, per qualification-fields.ts's own doc comment) accepts these for BOTH
 * verticals, and still rejects an arbitrary unlisted field name.
 */
describe("Fase 2.2 -- diagnosis fields are allowed qualification fields", () => {
  const diagnosisFields = [
    "ad_need_state",
    "diagnosed_need_state",
    "primary_concern",
    "solution_category",
    "product_fit",
    "insurer_fit",
    "next_step",
  ] as const;

  it.each(diagnosisFields)("%s is allowed for PATRIMONIAL", (field) => {
    expect(isAllowedQualificationField("PATRIMONIAL", field)).toBe(true);
  });

  it.each(diagnosisFields)("%s is allowed for GMM", (field) => {
    expect(isAllowedQualificationField("GMM", field)).toBe(true);
  });

  it("still rejects an arbitrary, unlisted field name (whitelist is not accidentally open)", () => {
    expect(isAllowedQualificationField("PATRIMONIAL", "insurer_name_freeform")).toBe(false);
    expect(isAllowedQualificationField("GMM", "insurer_name_freeform")).toBe(false);
  });
});
