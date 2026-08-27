import { describe, expect, it } from "vitest";
import { parseLocationAnswer, missingLocationFields } from "../src/domain/location-parser.js";

describe("parseLocationAnswer", () => {
  it('parses "León, Guanajuato, 37150" into all three fields', () => {
    const result = parseLocationAnswer("León, Guanajuato, 37150", {});
    expect(result.extracted).toEqual({ city: "Leon", state: "Guanajuato", postalCode: "37150" });
  });

  it('parses the loose sentence "Vivo en León Gto CP 37150"', () => {
    const result = parseLocationAnswer("Vivo en León Gto CP 37150", {});
    expect(result.extracted).toEqual({ city: "Leon", state: "Guanajuato", postalCode: "37150" });
  });

  it('parses "León Guanajuato 37150" with no punctuation', () => {
    const result = parseLocationAnswer("León Guanajuato 37150", {});
    expect(result.extracted).toEqual({ city: "Leon", state: "Guanajuato", postalCode: "37150" });
  });

  it('parses a bare postal code "37150" as postal code only', () => {
    expect(parseLocationAnswer("37150", {}).extracted).toEqual({ postalCode: "37150" });
  });

  it('parses a bare city "León" as city only, never guessing a state', () => {
    expect(parseLocationAnswer("León", {}).extracted).toEqual({ city: "Leon" });
  });

  it('parses a bare state "Guanajuato" as state only, never guessing a city', () => {
    expect(parseLocationAnswer("Guanajuato", {}).extracted).toEqual({ state: "Guanajuato" });
  });

  it("captures partial location without losing already-captured fields (merge is the caller's job, extraction stays partial)", () => {
    const first = parseLocationAnswer("León", {});
    const merged = { ...{}, ...first.extracted };
    const second = parseLocationAnswer("Guanajuato", merged);
    expect(second.extracted).toEqual({ state: "Guanajuato" });
    expect({ ...merged, ...second.extracted }).toEqual({ city: "Leon", state: "Guanajuato" });
  });

  it("rejects an invalid postal code (4 digits) rather than accepting it", () => {
    expect(parseLocationAnswer("3715", {}).extracted.postalCode).toBeUndefined();
  });

  it("rejects an invalid postal code (6 digits) rather than accepting it", () => {
    expect(parseLocationAnswer("371500", {}).extracted.postalCode).toBeUndefined();
  });

  it("never infers city or state from a postal code alone", () => {
    const result = parseLocationAnswer("37150", {});
    expect(result.extracted.city).toBeUndefined();
    expect(result.extracted.state).toBeUndefined();
  });

  it("flags a contradiction instead of silently overwriting an already-confirmed city", () => {
    const result = parseLocationAnswer("Guadalajara", { city: "Leon" });
    expect(result.contradiction).toEqual({ field: "city", existingValue: "Leon", newValue: "Guadalajara" });
    expect(result.extracted).toEqual({});
  });

  it("does not flag a contradiction when the same value is repeated", () => {
    const result = parseLocationAnswer("León", { city: "Leon" });
    expect(result.contradiction).toBeUndefined();
  });

  describe("hardening -- hedge/non-answer text is never accepted as a city", () => {
    it.each([
      "no sé",
      "no estoy seguro",
      "no recuerdo",
      "creo que sí",
      "por ahí",
      "cerca del centro",
      "más o menos",
      "después te digo",
      "prefiero verlo luego",
      "no tengo el dato",
    ])("rejects %s instead of treating it as a city", (text) => {
      const result = parseLocationAnswer(text, {});
      expect(result.unrecognized).toBe(true);
      expect(result.extracted.city).toBeUndefined();
    });

    it("still extracts a valid postal code found alongside hedge text", () => {
      const result = parseLocationAnswer("no sé, pero el CP es 37150", {});
      expect(result.extracted.postalCode).toBe("37150");
      expect(result.extracted.city).toBeUndefined();
    });

    it("does not flag unrecognized for genuinely valid city text", () => {
      expect(parseLocationAnswer("León", {}).unrecognized).toBeUndefined();
      expect(parseLocationAnswer("León, Guanajuato, 37150", {}).unrecognized).toBeUndefined();
    });

    it("does not overwrite an already-confirmed city when the new answer is unrecognized", () => {
      const result = parseLocationAnswer("no sé", { city: "Leon" });
      expect(result.extracted.city).toBeUndefined();
      expect(result.contradiction).toBeUndefined();
    });
  });
});

describe("missingLocationFields", () => {
  it("lists all three fields when nothing is captured", () => {
    expect(missingLocationFields({})).toEqual(["city", "state", "postalCode"]);
  });

  it("lists only the missing field once city and state are known", () => {
    expect(missingLocationFields({ city: "Leon", state: "Guanajuato" })).toEqual(["postalCode"]);
  });

  it("is empty once all three are known", () => {
    expect(missingLocationFields({ city: "Leon", state: "Guanajuato", postalCode: "37150" })).toEqual([]);
  });
});
