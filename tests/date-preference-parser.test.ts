import { describe, it, expect } from "vitest";
import { parseDatePreference } from "../src/domain/date-preference-parser.js";

/**
 * Fase 7I -- deterministic, regex-based date/weekday/daypart preference extraction.
 * `now` fixed to a real, empirically-known instant: 2026-09-07T01:56:58.311Z = Sunday
 * 2026-09-06 19:56:58 local (America/Mexico_City) -- the exact "now" of the real diagnosed
 * incident (Fase 7I-DIAG item 26).
 */
const NOW = new Date("2026-09-07T01:56:58.311Z");
const TZ = "America/Mexico_City";

describe("Fase 7I -- parseDatePreference: weekday names", () => {
  it("lunes -> weekday 1", () => {
    expect(parseDatePreference("lunes", NOW, TZ)).toEqual({ weekday: 1 });
  });
  it("sábado -> weekday 6", () => {
    expect(parseDatePreference("Quiero agendar en sábado", NOW, TZ)).toEqual({ weekday: 6 });
  });
  it("sabado (no accent) -> weekday 6, same as sábado", () => {
    expect(parseDatePreference("quiero agendar en sabado", NOW, TZ)).toEqual({ weekday: 6 });
  });
  it("domingo -> weekday 0", () => {
    expect(parseDatePreference("Quiero agendar el próximo domingo", NOW, TZ)).toEqual({ weekday: 0 });
  });
  it("martes/miercoles/jueves/viernes resolve to 2/3/4/5", () => {
    expect(parseDatePreference("martes", NOW, TZ)).toEqual({ weekday: 2 });
    expect(parseDatePreference("miercoles", NOW, TZ)).toEqual({ weekday: 3 });
    expect(parseDatePreference("miércoles", NOW, TZ)).toEqual({ weekday: 3 });
    expect(parseDatePreference("jueves", NOW, TZ)).toEqual({ weekday: 4 });
    expect(parseDatePreference("viernes", NOW, TZ)).toEqual({ weekday: 5 });
  });
});

describe("Fase 7I -- parseDatePreference: relative dates", () => {
  it("hoy -> today's local date", () => {
    expect(parseDatePreference("hoy", NOW, TZ)).toEqual({ targetDate: "2026-09-06" });
  });
  it("mañana -> tomorrow's local date", () => {
    expect(parseDatePreference("mañana", NOW, TZ)).toEqual({ targetDate: "2026-09-07" });
  });
  it("pasado mañana -> the day after tomorrow's local date", () => {
    expect(parseDatePreference("pasado mañana", NOW, TZ)).toEqual({ targetDate: "2026-09-08" });
  });
  it("pasado manana (no accent) resolves the same as pasado mañana", () => {
    expect(parseDatePreference("pasado manana", NOW, TZ)).toEqual({ targetDate: "2026-09-08" });
  });
});

describe("Fase 7I -- parseDatePreference: explicit dates", () => {
  it("12 de septiembre -> this year's 2026-09-12 (still in the future relative to NOW)", () => {
    expect(parseDatePreference("12 de septiembre", NOW, TZ)).toEqual({ targetDate: "2026-09-12" });
  });
  it("el 12 de septiembre -> same result with the leading 'el'", () => {
    expect(parseDatePreference("el 12 de septiembre", NOW, TZ)).toEqual({ targetDate: "2026-09-12" });
  });
  it("12 septiembre (no 'de') -> same result", () => {
    expect(parseDatePreference("12 septiembre", NOW, TZ)).toEqual({ targetDate: "2026-09-12" });
  });
  it("a date already in the past this year rolls over to next year", () => {
    // Relative to NOW (2026-09-06 local), "1 de enero" already passed this year.
    expect(parseDatePreference("1 de enero", NOW, TZ)).toEqual({ targetDate: "2027-01-01" });
  });
  it("numeric DD/MM resolves the same as the month-name form", () => {
    expect(parseDatePreference("12/09", NOW, TZ)).toEqual({ targetDate: "2026-09-12" });
  });
  it("numeric DD-MM resolves the same way", () => {
    expect(parseDatePreference("12-09", NOW, TZ)).toEqual({ targetDate: "2026-09-12" });
  });
});

describe("Fase 7I -- parseDatePreference: dayparts", () => {
  it("por la mañana -> MORNING, with no day selector", () => {
    expect(parseDatePreference("por la mañana", NOW, TZ)).toEqual({ daypart: "MORNING" });
  });
  it("en la mañana -> MORNING (both prefixes accepted)", () => {
    expect(parseDatePreference("en la mañana", NOW, TZ)).toEqual({ daypart: "MORNING" });
  });
  it("por la tarde -> AFTERNOON", () => {
    expect(parseDatePreference("por la tarde", NOW, TZ)).toEqual({ daypart: "AFTERNOON" });
  });
  it("por la noche -> EVENING", () => {
    expect(parseDatePreference("por la noche", NOW, TZ)).toEqual({ daypart: "EVENING" });
  });
});

describe("Fase 7I -- parseDatePreference: combinations (weekday + daypart)", () => {
  it("sábado por la mañana -> weekday 6 + MORNING", () => {
    expect(parseDatePreference("sábado por la mañana", NOW, TZ)).toEqual({ weekday: 6, daypart: "MORNING" });
  });
  it("lunes por la tarde -> weekday 1 + AFTERNOON", () => {
    expect(parseDatePreference("lunes por la tarde", NOW, TZ)).toEqual({ weekday: 1, daypart: "AFTERNOON" });
  });
  it("a bare 'mañana' inside 'por la mañana' is consumed by the daypart match, never ALSO read as tomorrow", () => {
    const result = parseDatePreference("sábado por la mañana", NOW, TZ);
    expect(result?.targetDate).toBeUndefined();
  });
});

describe("Fase 7I -- parseDatePreference: negatives (must never collide with slot-selection or other intents)", () => {
  it('"1" is never a date preference -- parseSlotSelection owns bare numbers', () => {
    expect(parseDatePreference("1", NOW, TZ)).toBeNull();
  });
  it('"2" is never a date preference', () => {
    expect(parseDatePreference("2", NOW, TZ)).toBeNull();
  });
  it('"cancelar" has no temporal content', () => {
    expect(parseDatePreference("cancelar", NOW, TZ)).toBeNull();
  });
  it('"reagendar" alone (no day/date/daypart) has no temporal content', () => {
    expect(parseDatePreference("reagendar", NOW, TZ)).toBeNull();
  });
  it('"quiero una cita" has no temporal content', () => {
    expect(parseDatePreference("quiero una cita", NOW, TZ)).toBeNull();
  });
  it('"otro horario" / "otro día" / "otro horario y día" have no temporal content (deferred per Fase 7I spec item 16 -- documented, not implemented this pass)', () => {
    expect(parseDatePreference("otro horario", NOW, TZ)).toBeNull();
    expect(parseDatePreference("quiero otro día", NOW, TZ)).toBeNull();
    expect(parseDatePreference("otro horario y día", NOW, TZ)).toBeNull();
  });
  it("normalization tolerates accents, case, and extra whitespace", () => {
    expect(parseDatePreference("  SÁBADO   ", NOW, TZ)).toEqual({ weekday: 6 });
    expect(parseDatePreference("Sabado", NOW, TZ)).toEqual({ weekday: 6 });
  });
});
