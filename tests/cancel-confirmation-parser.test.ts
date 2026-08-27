import { describe, it, expect } from "vitest";
import { parseCancelConfirmation } from "../src/domain/cancel-confirmation-parser.js";

describe("parseCancelConfirmation", () => {
  it.each(["1", "si", "Sí", "SI", " 1 ", "confirmar", "cancelar"])("%s -> CONFIRM", (text) => {
    expect(parseCancelConfirmation(text)).toBe("CONFIRM");
  });

  it.each(["2", "no", "No", "NO", " 2 ", "conservar"])("%s -> DECLINE", (text) => {
    expect(parseCancelConfirmation(text)).toBe("DECLINE");
  });

  it.each(["10", "0", "tal vez", "no se", "hola", "", "quiza", "sí pero no"])("%s -> AMBIGUOUS (never cancels on an unclear answer)", (text) => {
    expect(parseCancelConfirmation(text)).toBe("AMBIGUOUS");
  });

  it("a bare unrelated number is never misread as option 1 or 2", () => {
    expect(parseCancelConfirmation("10")).toBe("AMBIGUOUS");
    expect(parseCancelConfirmation("100")).toBe("AMBIGUOUS");
  });
});
