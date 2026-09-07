import { describe, it, expect } from "vitest";
import { isContextualRescheduleRequest } from "../src/domain/contextual-reschedule-detection.js";
import { parseDatePreference } from "../src/domain/date-preference-parser.js";

/**
 * Fase 7I.2 -- CAUSE_CONTEXTUAL_RESCHEDULE_NOT_DETECTED fix. `NOW` fixed to the real incident's
 * exact instant reconstructed in Fase 7I.2-DIAG: 2026-09-07T05:09:02.069Z.
 */
const NOW = new Date("2026-09-07T05:09:02.069Z");
const TZ = "America/Mexico_City";

function check(text: string): boolean {
  return isContextualRescheduleRequest(text, parseDatePreference(text, NOW, TZ));
}

describe("Fase 7I.2 -- isContextualRescheduleRequest: positives", () => {
  const positives = [
    "Mejor el domingo",
    "El sábado mejor",
    "Prefiero el lunes",
    "¿Puede ser el martes?",
    "Por la tarde mejor",
    "Mejor mañana",
    "Mejor el 12 de septiembre",
    "Prefiero el 12 de septiembre",
    "¿Puede ser el 12 de septiembre?",
    "En vez del sábado, el lunes",
    "Me conviene más el martes",
    "Me gustaría cambiarlo al jueves",
  ];
  it.each(positives)("%s -> true", (text) => {
    expect(check(text)).toBe(true);
  });
});

describe("Fase 7I.2 -- isContextualRescheduleRequest: negatives (DatePreference alone is never sufficient)", () => {
  const negatives = [
    "El 12 de septiembre",
    "El sábado",
    "¿Mi cita es el sábado?",
    "¿Atienden los domingos?",
    "¿Qué horarios tienen?",
    "Gracias",
    "Perfecto",
    "Nos vemos el sábado",
    "Mi cita es el lunes, ¿verdad?",
  ];
  it.each(negatives)("%s -> false", (text) => {
    expect(check(text)).toBe(false);
  });

  it("item 8: a DatePreference is parsed for the ambiguous cases, but that alone is deliberately not enough", () => {
    expect(parseDatePreference("El 12 de septiembre", NOW, TZ)).toEqual({ targetDate: "2026-09-12" });
    expect(isContextualRescheduleRequest("El 12 de septiembre", { targetDate: "2026-09-12" })).toBe(false);
    expect(parseDatePreference("El sábado", NOW, TZ)).toEqual({ weekday: 6 });
    expect(isContextualRescheduleRequest("El sábado", { weekday: 6 })).toBe(false);
  });

  it("returns false unconditionally when datePreference is null, regardless of text content", () => {
    expect(isContextualRescheduleRequest("Mejor el domingo pero no hay fecha", null)).toBe(false);
  });
});

describe("Fase 7I.2 -- isContextualRescheduleRequest: normalization", () => {
  it("tolerates accents, case, and extra whitespace", () => {
    expect(isContextualRescheduleRequest("  MEJOR   el   domingo  ", { weekday: 0 })).toBe(true);
    expect(isContextualRescheduleRequest("Preferiría el lunes", { weekday: 1 })).toBe(true);
  });
});
