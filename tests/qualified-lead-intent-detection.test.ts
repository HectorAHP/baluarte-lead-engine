import { describe, expect, it } from "vitest";
import { detectQualifiedLeadIntent } from "../src/domain/qualified-lead-intent-detection.js";

describe("detectQualifiedLeadIntent", () => {
  it("recognizes an explicit PPR question regardless of pending menu state", () => {
    expect(detectQualifiedLeadIntent("¿Cómo funciona el PPR?", null)).toEqual({ kind: "QUESTION", topic: "PPR" });
    expect(detectQualifiedLeadIntent("¿Cómo funciona el PPR?", "MAIN")).toEqual({ kind: "QUESTION", topic: "PPR" });
    expect(detectQualifiedLeadIntent("quiero saber de mi retiro", null)).toEqual({ kind: "QUESTION", topic: "PPR" });
  });

  it("recognizes a GMM question", () => {
    expect(detectQualifiedLeadIntent("¿Qué cubre el GMM?", null)).toEqual({ kind: "QUESTION", topic: "GMM" });
    expect(detectQualifiedLeadIntent("quiero un seguro de gastos medicos", null)).toEqual({ kind: "QUESTION", topic: "GMM" });
  });

  it("recognizes a savings/investment question", () => {
    expect(detectQualifiedLeadIntent("quiero ahorrar", null)).toEqual({ kind: "QUESTION", topic: "SAVINGS" });
    expect(detectQualifiedLeadIntent("me interesa invertir", null)).toEqual({ kind: "QUESTION", topic: "SAVINGS" });
  });

  it('"quiero conocer opciones" maps to EXPLORE_OPTIONS regardless of pending menu', () => {
    expect(detectQualifiedLeadIntent("Quiero conocer opciones", null)).toEqual({ kind: "EXPLORE_OPTIONS" });
    expect(detectQualifiedLeadIntent("Quiero conocer opciones", "MAIN")).toEqual({ kind: "EXPLORE_OPTIONS" });
  });

  it('"quiero agendar una cita" maps to BOOKING regardless of pending menu', () => {
    expect(detectQualifiedLeadIntent("Quiero agendar una cita", null)).toEqual({ kind: "BOOKING" });
    expect(detectQualifiedLeadIntent("Quiero agendar una cita", "MAIN")).toEqual({ kind: "BOOKING" });
  });

  it("a bare digit is only interpreted as a menu choice when pendingMenu is MAIN", () => {
    expect(detectQualifiedLeadIntent("1", "MAIN")).toEqual({ kind: "MENU_QUESTION" });
    expect(detectQualifiedLeadIntent("2", "MAIN")).toEqual({ kind: "EXPLORE_OPTIONS" });
    expect(detectQualifiedLeadIntent("3", "MAIN")).toEqual({ kind: "BOOKING" });
    expect(detectQualifiedLeadIntent("1", null)).toEqual({ kind: "UNKNOWN" });
    expect(detectQualifiedLeadIntent("2", null)).toEqual({ kind: "UNKNOWN" });
    expect(detectQualifiedLeadIntent("3", null)).toEqual({ kind: "UNKNOWN" });
  });

  it("tolerates common digit phrasing variants against the main menu", () => {
    expect(detectQualifiedLeadIntent("opcion 1", "MAIN")).toEqual({ kind: "MENU_QUESTION" });
    expect(detectQualifiedLeadIntent("la 2", "MAIN")).toEqual({ kind: "EXPLORE_OPTIONS" });
    expect(detectQualifiedLeadIntent("3.", "MAIN")).toEqual({ kind: "BOOKING" });
  });

  it("genuinely unrecognized text with no pending menu is UNKNOWN", () => {
    expect(detectQualifiedLeadIntent("Hola, buenas tardes", null)).toEqual({ kind: "UNKNOWN" });
    expect(detectQualifiedLeadIntent("Hola, buenas tardes", "MAIN")).toEqual({ kind: "UNKNOWN" });
  });

  it("keyword detection takes priority over a pending-menu digit interpretation", () => {
    // Even with a MAIN menu pending, an explicit topic question is never shadowed by digit logic.
    expect(detectQualifiedLeadIntent("¿Cómo funciona el PPR?", "MAIN")).toEqual({ kind: "QUESTION", topic: "PPR" });
  });

  it("never mutates its inputs and is a pure function -- same input always yields same output", () => {
    const a = detectQualifiedLeadIntent("2", "MAIN");
    const b = detectQualifiedLeadIntent("2", "MAIN");
    expect(a).toEqual(b);
  });
});
