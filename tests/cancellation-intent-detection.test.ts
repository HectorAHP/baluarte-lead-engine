import { describe, it, expect } from "vitest";
import { isCancellationRequest } from "../src/domain/cancellation-intent-detection.js";
import { isOptOutMessage } from "../src/domain/opt-out-detection.js";

describe("isCancellationRequest", () => {
  it.each([
    "cancelar cita",
    "quiero cancelar mi cita",
    "Cancela mi cita",
    "CANCELAR CITA",
    "ya no puedo asistir",
    "ya no puedo ir",
    "Quiero cancelar",
  ])("detects %s", (text) => {
    expect(isCancellationRequest(text)).toBe(true);
  });

  it.each([
    "hola",
    "cual es mi cita",
    "quiero reagendar",
    "gracias",
    "",
  ])("does not detect %s", (text) => {
    expect(isCancellationRequest(text)).toBe(false);
  });

  it("never collides with opt-out detection -- a cancellation message must never be misread as an opt-out", () => {
    const cancellationMessages = ["cancelar cita", "quiero cancelar mi cita", "cancela mi cita", "ya no puedo asistir", "ya no puedo ir"];
    for (const text of cancellationMessages) {
      expect(isOptOutMessage(text)).toBe(false);
    }
  });
});
