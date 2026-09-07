import { describe, it, expect } from "vitest";
import { computeAvailableSlots, filterSlotsByDatePreference, type AvailabilityRules, type Slot } from "../src/domain/availability.js";
import { zonedTimeParts } from "../src/domain/timezone.js";
import type { DatePreference } from "../src/domain/date-preference.js";

/**
 * Fase 7I -- proves filterSlotsByDatePreference is applied INSIDE computeAvailableSlots BEFORE
 * the maxSlots truncation (the actual fix for the real "sábado" incident -- see
 * Fase 7I-DIAG §5/§7). `now` fixed to the exact real incident instant.
 */
const REAL_WEEKLY_RULES: AvailabilityRules = {
  timezone: "America/Mexico_City",
  workdayStart: "09:00",
  workdayEnd: "19:00",
  saturdayWorkdayEnd: "14:00",
  sundayBookingEnabled: false,
  minNoticeHours: 2,
  maxDaysAhead: 14,
  maxSlots: 3, // production's real value -- deliberately NOT relaxed, so these tests prove the fix under the real constraint
};

const NOW = new Date("2026-09-07T01:56:58.311Z"); // Sunday 2026-09-06 19:56:58 local
const FAR_FUTURE_TO = new Date(NOW.getTime() + 14 * 86_400_000);

function localParts(d: Date) {
  const p = zonedTimeParts(d, "America/Mexico_City");
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { ...p, dow };
}

describe("Fase 7I -- computeAvailableSlots with datePreference: item 1, item 9 (filter before truncate)", () => {
  it("item 1: a Saturday weekday preference returns ONLY Saturday slots, never Monday, even though Monday comes first chronologically", () => {
    const slots = computeAvailableSlots(NOW, FAR_FUTURE_TO, 30, [], REAL_WEEKLY_RULES, NOW, { weekday: 6 });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(localParts(s.start).dow).toBe(6);
    }
  });

  it("item 9: the maxSlots=3 truncation happens AFTER the date-preference filter -- without a preference, the same window returns Monday first; WITH a Saturday preference, Monday never appears at all, proving filtering precedes truncation rather than being applied to an already-Monday-only result", () => {
    const noPreference = computeAvailableSlots(NOW, FAR_FUTURE_TO, 30, [], REAL_WEEKLY_RULES, NOW);
    expect(noPreference).toHaveLength(3);
    expect(localParts(noPreference[0].start).dow).toBe(1); // Monday, unfiltered behavior unchanged

    const saturdayOnly = computeAvailableSlots(NOW, FAR_FUTURE_TO, 30, [], REAL_WEEKLY_RULES, NOW, { weekday: 6 });
    expect(saturdayOnly).toHaveLength(3); // still respects maxSlots=3
    expect(saturdayOnly.every((s) => localParts(s.start).dow === 6)).toBe(true);
  });
});

describe("Fase 7I -- computeAvailableSlots with datePreference: item 2 (Saturday business hours still enforced)", () => {
  it("every Saturday slot returned still ends by 14:00 -- the date-preference filter never bypasses FASE 7F's business-hours rule", () => {
    const rulesUncapped: AvailabilityRules = { ...REAL_WEEKLY_RULES, maxSlots: 1000 };
    const slots = computeAvailableSlots(NOW, FAR_FUTURE_TO, 30, [], rulesUncapped, NOW, { weekday: 6 });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const endParts = zonedTimeParts(s.end, "America/Mexico_City");
      expect(endParts.hour * 60 + endParts.minute).toBeLessThanOrEqual(14 * 60);
    }
  });
});

describe("Fase 7I -- computeAvailableSlots with datePreference: item 3 (Sunday preference)", () => {
  it("a Sunday weekday preference returns ZERO slots -- Sunday stays closed regardless of what's requested", () => {
    const slots = computeAvailableSlots(NOW, FAR_FUTURE_TO, 30, [], REAL_WEEKLY_RULES, NOW, { weekday: 0 });
    expect(slots).toHaveLength(0);
  });
});

describe("Fase 7I -- computeAvailableSlots with datePreference: item 4 (Monday preference)", () => {
  it("a Monday weekday preference returns ONLY Monday slots", () => {
    const slots = computeAvailableSlots(NOW, FAR_FUTURE_TO, 30, [], REAL_WEEKLY_RULES, NOW, { weekday: 1 });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => localParts(s.start).dow === 1)).toBe(true);
  });
});

describe("Fase 7I -- computeAvailableSlots with datePreference: item 5 (explicit date)", () => {
  it("an explicit targetDate returns ONLY slots on that exact local calendar date", () => {
    const rulesUncapped: AvailabilityRules = { ...REAL_WEEKLY_RULES, maxSlots: 1000 };
    const preference: DatePreference = { targetDate: "2026-09-12" }; // the real next Saturday
    const slots = computeAvailableSlots(NOW, FAR_FUTURE_TO, 30, [], rulesUncapped, NOW, preference);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const p = zonedTimeParts(s.start, "America/Mexico_City");
      expect(`${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`).toBe("2026-09-12");
    }
  });
});

describe("Fase 7I -- computeAvailableSlots with datePreference: item 6/7 (daypart)", () => {
  it("item 6: a MORNING daypart preference returns only slots between 09:00 and 12:00 local", () => {
    const rulesUncapped: AvailabilityRules = { ...REAL_WEEKLY_RULES, maxSlots: 1000 };
    const slots = computeAvailableSlots(NOW, FAR_FUTURE_TO, 30, [], rulesUncapped, NOW, { daypart: "MORNING" });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const startP = zonedTimeParts(s.start, "America/Mexico_City");
      const endP = zonedTimeParts(s.end, "America/Mexico_City");
      expect(startP.hour * 60 + startP.minute).toBeGreaterThanOrEqual(9 * 60);
      expect(endP.hour * 60 + endP.minute).toBeLessThanOrEqual(12 * 60);
    }
  });

  it("item 7: an AFTERNOON daypart preference returns only slots between 12:00 and 18:00 local", () => {
    const rulesUncapped: AvailabilityRules = { ...REAL_WEEKLY_RULES, maxSlots: 1000 };
    const slots = computeAvailableSlots(NOW, FAR_FUTURE_TO, 30, [], rulesUncapped, NOW, { daypart: "AFTERNOON" });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const startP = zonedTimeParts(s.start, "America/Mexico_City");
      const endP = zonedTimeParts(s.end, "America/Mexico_City");
      expect(startP.hour * 60 + startP.minute).toBeGreaterThanOrEqual(12 * 60);
      expect(endP.hour * 60 + endP.minute).toBeLessThanOrEqual(18 * 60);
    }
  });
});

describe("Fase 7I -- computeAvailableSlots with datePreference: item 8 (combined weekday + daypart)", () => {
  it("Saturday + MORNING returns only Saturday slots that also fit entirely within 09:00-12:00", () => {
    const rulesUncapped: AvailabilityRules = { ...REAL_WEEKLY_RULES, maxSlots: 1000 };
    const slots = computeAvailableSlots(NOW, FAR_FUTURE_TO, 30, [], rulesUncapped, NOW, { weekday: 6, daypart: "MORNING" });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const startP = zonedTimeParts(s.start, "America/Mexico_City");
      expect(localParts(s.start).dow).toBe(6);
      expect(startP.hour * 60 + startP.minute).toBeGreaterThanOrEqual(9 * 60);
      expect(startP.hour * 60 + startP.minute).toBeLessThan(12 * 60);
    }
  });
});

describe("Fase 7I -- computeAvailableSlots with datePreference: item 10 (no preference -- unchanged)", () => {
  it("datePreference omitted is byte-identical to calling computeAvailableSlots without the parameter at all", () => {
    const withExplicitUndefined = computeAvailableSlots(NOW, FAR_FUTURE_TO, 30, [], REAL_WEEKLY_RULES, NOW, undefined);
    const withoutTheArgAtAll = computeAvailableSlots(NOW, FAR_FUTURE_TO, 30, [], REAL_WEEKLY_RULES, NOW);
    expect(withExplicitUndefined).toEqual(withoutTheArgAtAll);
    expect(withoutTheArgAtAll).toHaveLength(3);
    expect(localParts(withoutTheArgAtAll[0].start).dow).toBe(1); // Monday, exactly as before Fase 7I
  });
});

describe("Fase 7I -- filterSlotsByDatePreference unit tests", () => {
  const slots: Slot[] = [
    { start: new Date("2026-09-07T15:00:00.000Z"), end: new Date("2026-09-07T15:30:00.000Z") }, // Monday 09:00 local
    { start: new Date("2026-09-12T15:00:00.000Z"), end: new Date("2026-09-12T15:30:00.000Z") }, // Saturday 09:00 local
  ];

  it("returns candidates unchanged (same content) when preference is undefined", () => {
    expect(filterSlotsByDatePreference(slots, undefined, "America/Mexico_City")).toEqual(slots);
  });

  it("a slot straddling a daypart boundary is excluded from a window it doesn't fully fit", () => {
    // 11:30-12:00 local Monday -- fits MORNING (start>=9:00, end<=12:00) but not AFTERNOON.
    const straddling: Slot[] = [{ start: new Date("2026-09-07T17:30:00.000Z"), end: new Date("2026-09-07T18:00:00.000Z") }];
    expect(filterSlotsByDatePreference(straddling, { daypart: "MORNING" }, "America/Mexico_City")).toHaveLength(1);
    expect(filterSlotsByDatePreference(straddling, { daypart: "AFTERNOON" }, "America/Mexico_City")).toHaveLength(0);
  });
});
