import { describe, it, expect } from "vitest";
import { isNewBookingRequest } from "../src/domain/new-booking-intent-detection.js";
import { isRescheduleRequest } from "../src/domain/reschedule-intent-detection.js";
import { isCancellationRequest } from "../src/domain/cancellation-intent-detection.js";

describe("isNewBookingRequest", () => {
  it.each([
    "Quiero agendar",
    "quiero agendar",
    "Quiero una nueva cita",
    "quiero una cita",
    "Quiero volver a agendar",
    "agendar cita",
    "quiero agendar una cita",
  ])("detects %s", (text) => {
    expect(isNewBookingRequest(text)).toBe(true);
  });

  it.each([
    "hola",
    "quiero información",
    "necesito ayuda",
    "",
  ])("does not detect %s", (text) => {
    expect(isNewBookingRequest(text)).toBe(false);
  });

  it("never false-positives on 'reagendar' -- the word-boundary guard prevents 'agendar cita' from matching as a substring inside 'reagendar cita'", () => {
    expect(isNewBookingRequest("quiero reagendar")).toBe(false);
    expect(isNewBookingRequest("reagendar cita")).toBe(false);
    expect(isNewBookingRequest("quiero reagendar cita")).toBe(false);
  });

  it("never collides with isRescheduleRequest or isCancellationRequest", () => {
    const rescheduleMessages = ["quiero cambiar mi cita", "quiero reagendar", "reagendar cita", "cambiar horario", "no puedo a esa hora"];
    const cancellationMessages = ["cancelar cita", "quiero cancelar mi cita", "cancela mi cita", "ya no puedo asistir", "ya no puedo ir"];
    for (const text of rescheduleMessages) expect(isNewBookingRequest(text)).toBe(false);
    for (const text of cancellationMessages) expect(isNewBookingRequest(text)).toBe(false);

    const newBookingMessages = ["quiero agendar", "quiero una nueva cita", "quiero volver a agendar", "agendar cita"];
    for (const text of newBookingMessages) {
      expect(isRescheduleRequest(text)).toBe(false);
      expect(isCancellationRequest(text)).toBe(false);
    }
  });
});
