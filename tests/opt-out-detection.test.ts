import { describe, expect, it } from "vitest";
import { isOptOutMessage } from "../src/domain/opt-out-detection.js";

describe("isOptOutMessage", () => {
  it.each([
    "no me escriban por favor",
    "ya no me contacten",
    "ya no quiero información",
    "ya no quiero informacion",
    "baja",
    "quiero darme de baja",
    "STOP",
    "detener",
    "cancelar mensajes",
  ])("detects opt-out phrase in: %s", (text) => {
    expect(isOptOutMessage(text)).toBe(true);
  });

  it.each([
    "Hola, quiero información sobre PPR",
    "¿Cuánto cuesta el seguro?",
    "Sí, acepto la cita",
    "Gracias por la información",
  ])("does not flag ordinary messages: %s", (text) => {
    expect(isOptOutMessage(text)).toBe(false);
  });
});
