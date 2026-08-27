import { describe, expect, it } from "vitest";
import { zonedDateToUtc, zonedTimeParts } from "../src/domain/timezone.js";

describe("timezone conversion", () => {
  it("converts a Mexico City wall-clock time to the correct UTC instant (fixed UTC-6, no DST)", () => {
    const utc = zonedDateToUtc(2026, 3, 1, 9, 0, "America/Mexico_City");
    expect(utc.toISOString()).toBe("2026-03-01T15:00:00.000Z");
  });

  it("stays fixed at UTC-6 even in what used to be DST months pre-2022 reform", () => {
    const utc = zonedDateToUtc(2026, 7, 1, 9, 0, "America/Mexico_City");
    expect(utc.toISOString()).toBe("2026-07-01T15:00:00.000Z");
  });

  it("roundtrips: zonedTimeParts(zonedDateToUtc(x)) recovers the original wall-clock time", () => {
    const cases: Array<[number, number, number, number, number]> = [
      [2026, 1, 15, 9, 0],
      [2026, 6, 30, 23, 45],
      [2026, 12, 31, 0, 0],
    ];
    for (const [year, month, day, hour, minute] of cases) {
      const utc = zonedDateToUtc(year, month, day, hour, minute, "America/Mexico_City");
      const parts = zonedTimeParts(utc, "America/Mexico_City");
      expect([parts.year, parts.month, parts.day, parts.hour, parts.minute]).toEqual([year, month, day, hour, minute]);
    }
  });
});
