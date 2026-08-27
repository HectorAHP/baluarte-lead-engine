import { describe, it, expect } from "vitest";
import { isRescheduleRequest } from "../src/domain/reschedule-intent-detection.js";
import { isCancellationRequest } from "../src/domain/cancellation-intent-detection.js";
import { isOptOutMessage } from "../src/domain/opt-out-detection.js";

describe("isRescheduleRequest", () => {
  it.each([
    "quiero cambiar mi cita",
    "Quiero cambiar mi cita",
    "quiero reagendar",
    "reagendar cita",
    "reagendar mi cita",
    "cambiar horario",
    "quiero cambiar horario",
    "no puedo a esa hora",
    "QUIERO REAGENDAR",
  ])("detects %s", (text) => {
    expect(isRescheduleRequest(text)).toBe(true);
  });

  it.each([
    "hola",
    "cancelar cita",
    "quiero cancelar mi cita",
    "gracias",
    "",
    "ya no puedo asistir",
  ])("does not detect %s", (text) => {
    expect(isRescheduleRequest(text)).toBe(false);
  });

  it("never collides with isCancellationRequest -- a reschedule message must never also read as a cancellation, and vice versa", () => {
    const rescheduleMessages = ["quiero cambiar mi cita", "quiero reagendar", "reagendar cita", "cambiar horario", "no puedo a esa hora"];
    const cancellationMessages = ["cancelar cita", "quiero cancelar mi cita", "cancela mi cita", "ya no puedo asistir", "ya no puedo ir"];
    for (const text of rescheduleMessages) expect(isCancellationRequest(text)).toBe(false);
    for (const text of cancellationMessages) expect(isRescheduleRequest(text)).toBe(false);
  });

  it("never collides with isOptOutMessage", () => {
    const rescheduleMessages = ["quiero cambiar mi cita", "quiero reagendar", "reagendar cita", "cambiar horario", "no puedo a esa hora"];
    for (const text of rescheduleMessages) expect(isOptOutMessage(text)).toBe(false);
  });
});
