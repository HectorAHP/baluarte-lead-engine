import { describe, expect, it } from "vitest";
import { parseOptionAnswer, parseYesNoMaybe, isValidMexicanPostalCode, type OptionDef } from "../src/domain/answer-parser.js";

const TIMELINE_OPTIONS: OptionDef<string>[] = [
  { value: "LT_3_YEARS", number: 1, keywords: ["menos de 3"] },
  { value: "3_5_YEARS", number: 2, keywords: ["3-5", "3 a 5"] },
  { value: "5_10_YEARS", number: 3, keywords: ["5-10", "5 a 10"] },
  { value: "GT_10_YEARS", number: 4, keywords: ["mas de 10"] },
];

describe("parseOptionAnswer", () => {
  it("resolves by numeric position", () => {
    expect(parseOptionAnswer("2", TIMELINE_OPTIONS)).toBe("3_5_YEARS");
  });

  it("resolves by natural-language keyword", () => {
    expect(parseOptionAnswer("creo que unos 5 a 10 años", TIMELINE_OPTIONS)).toBe("5_10_YEARS");
  });

  it("returns null for unrecognized free text (caller must re-ask, never guess)", () => {
    expect(parseOptionAnswer("no sé todavía", TIMELINE_OPTIONS)).toBeNull();
  });

  it("returns null for an out-of-range number rather than guessing", () => {
    expect(parseOptionAnswer("9", TIMELINE_OPTIONS)).toBeNull();
  });
});

describe("parseYesNoMaybe", () => {
  it.each([["sí", "YES"], ["si", "YES"], ["claro", "YES"]] as const)("parses %s as YES", (text, expected) => {
    expect(parseYesNoMaybe(text)).toBe(expected);
  });

  it.each([["no", "NO"], ["negativo", "NO"]] as const)("parses %s as NO", (text, expected) => {
    expect(parseYesNoMaybe(text)).toBe(expected);
  });

  it.each([["tal vez", "MAYBE"], ["no estoy seguro", "MAYBE"], ["posiblemente", "MAYBE"]] as const)(
    "parses %s as MAYBE, not NO, despite containing the substring 'no'",
    (text, expected) => {
      expect(parseYesNoMaybe(text)).toBe(expected);
    },
  );

  it("returns null for unrelated text", () => {
    expect(parseYesNoMaybe("qué opciones tienes")).toBeNull();
  });
});

describe("isValidMexicanPostalCode", () => {
  it("accepts exactly 5 digits, preserving a leading zero", () => {
    expect(isValidMexicanPostalCode("01234")).toBe(true);
  });

  it.each(["3715", "371500", "3715a", "abcde"])("rejects %s", (value) => {
    expect(isValidMexicanPostalCode(value)).toBe(false);
  });
});
