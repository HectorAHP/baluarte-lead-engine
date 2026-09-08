import { describe, it, expect } from "vitest";
import { parseDaypartReply } from "../src/domain/daypart-preference-detection.js";
import { parseDatePreference } from "../src/domain/date-preference-parser.js";

describe("parseDaypartReply (Fase 7K sections 2/4)", () => {
  it("1. '1' -> MORNING", () => expect(parseDaypartReply("1")).toBe("MORNING"));
  it("2. 'mañana' (bare) -> MORNING", () => expect(parseDaypartReply("mañana")).toBe("MORNING"));
  it("3. 'por la mañana' -> MORNING", () => expect(parseDaypartReply("por la mañana")).toBe("MORNING"));
  it("4. 'temprano' -> MORNING", () => expect(parseDaypartReply("temprano")).toBe("MORNING"));
  it("5. '2' -> AFTERNOON", () => expect(parseDaypartReply("2")).toBe("AFTERNOON"));
  it("6. 'tarde' -> AFTERNOON", () => expect(parseDaypartReply("tarde")).toBe("AFTERNOON"));
  it("7. 'por la tarde' -> AFTERNOON", () => expect(parseDaypartReply("por la tarde")).toBe("AFTERNOON"));
  it("8. unrelated text -> null", () => expect(parseDaypartReply("¿cuánto cuesta el seguro?")).toBeNull());
  it("9. is case/accent-insensitive", () => expect(parseDaypartReply("POR LA MANANA")).toBe("MORNING"));
  it("10. section 4 -- bare 'mañana' resolved by THIS function never changes parseDatePreference's own tomorrow semantics", () => {
    // The ambiguity is resolved purely by which function/context the caller invokes, never by
    // mutating date-preference-parser.ts. Confirm both readings coexist unmodified.
    expect(parseDaypartReply("mañana")).toBe("MORNING");
    const now = new Date("2026-09-08T12:00:00Z");
    const tomorrowPref = parseDatePreference("mañana", now, "America/Mexico_City");
    expect(tomorrowPref?.targetDate).toBeDefined();
    expect(tomorrowPref?.daypart).toBeUndefined();
  });
});
