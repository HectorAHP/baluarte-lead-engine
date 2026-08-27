import { describe, expect, it } from "vitest";
import { computeAvailableSlots, clampAvailabilityWindow, type AvailabilityRules } from "../src/domain/availability.js";
import { zonedDateToUtc, zonedTimeParts } from "../src/domain/timezone.js";

const tz = "America/Mexico_City";
const baseRules: AvailabilityRules = {
  timezone: tz,
  workdayStart: "09:00",
  workdayEnd: "19:00",
  minNoticeHours: 2,
  maxDaysAhead: 14,
  maxSlots: 3,
};

// A fixed reference instant: 2026-03-02T00:00 local time (Monday).
const now = zonedDateToUtc(2026, 3, 2, 0, 0, tz);
const from = now;
const fiveDaysOut = new Date(now.getTime() + 5 * 86_400_000);
const localSlotStart = (h: number, m: number, dayOffset = 0) => {
  const day = new Date(zonedDateToUtc(2026, 3, 2, 0, 0, tz).getTime() + dayOffset * 86_400_000);
  const parts = zonedTimeParts(day, tz);
  return zonedDateToUtc(parts.year, parts.month, parts.day, h, m, tz);
};

describe("computeAvailableSlots", () => {
  it("never returns a slot outside workday hours", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 100 };
    const slots = computeAvailableSlots(from, fiveDaysOut, 30, [], rules, now);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const start = zonedTimeParts(slot.start, tz);
      const end = zonedTimeParts(slot.end, tz);
      expect(start.hour * 60 + start.minute).toBeGreaterThanOrEqual(9 * 60);
      expect(end.hour * 60 + end.minute).toBeLessThanOrEqual(19 * 60);
    }
  });

  it("respects the minimum booking notice: no slot starts before now + minNoticeHours", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 100 };
    const slots = computeAvailableSlots(from, fiveDaysOut, 30, [], rules, now);
    const cutoff = now.getTime() + baseRules.minNoticeHours * 3_600_000;
    for (const slot of slots) {
      expect(slot.start.getTime()).toBeGreaterThanOrEqual(cutoff);
    }
  });

  it("never searches beyond maxDaysAhead", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 1000, maxDaysAhead: 3 };
    const farOut = new Date(now.getTime() + 30 * 86_400_000);
    const slots = computeAvailableSlots(from, farOut, 30, [], rules, now);
    const horizon = now.getTime() + 3 * 86_400_000;
    for (const slot of slots) {
      expect(slot.start.getTime()).toBeLessThanOrEqual(horizon);
    }
  });

  it("excludes a busy slot and offers the next free one instead", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 1 };
    const firstSlotStart = localSlotStart(9, 0);
    const firstSlotEnd = localSlotStart(9, 30);
    const busy = [{ start: firstSlotStart, end: firstSlotEnd }];
    const slots = computeAvailableSlots(from, fiveDaysOut, 30, busy, rules, now);
    expect(slots).toHaveLength(1);
    expect(slots[0].start.getTime()).toBe(localSlotStart(9, 30).getTime());
  });

  it("includes a genuinely free slot", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 1 };
    const slots = computeAvailableSlots(from, fiveDaysOut, 30, [], rules, now);
    expect(slots).toHaveLength(1);
    expect(slots[0].start.getTime()).toBe(localSlotStart(9, 0).getTime());
    expect(slots[0].end.getTime()).toBe(localSlotStart(9, 30).getTime());
  });

  it("respects the requested meeting duration", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 3 };
    const slots = computeAvailableSlots(from, fiveDaysOut, 60, [], rules, now);
    expect(slots.map((s) => s.start.getTime())).toEqual([
      localSlotStart(9, 0).getTime(),
      localSlotStart(10, 0).getTime(),
      localSlotStart(11, 0).getTime(),
    ]);
    for (const slot of slots) {
      expect(slot.end.getTime() - slot.start.getTime()).toBe(60 * 60_000);
    }
  });

  it("returns at most the configured maximum number of slots, chronologically", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 3 };
    const slots = computeAvailableSlots(from, fiveDaysOut, 30, [], rules, now);
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.start.getTime())).toEqual([
      localSlotStart(9, 0).getTime(),
      localSlotStart(9, 30).getTime(),
      localSlotStart(10, 0).getTime(),
    ]);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].start.getTime()).toBeGreaterThan(slots[i - 1].start.getTime());
    }
  });

  it("returns an empty list when the window collapses (from >= to after clamping)", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 3 };
    const tooSoon = new Date(now.getTime() + 60_000);
    const slots = computeAvailableSlots(from, tooSoon, 30, [], rules, now);
    expect(slots).toEqual([]);
  });
});

describe("clampAvailabilityWindow", () => {
  it("pulls `from` forward to at least now + minNoticeHours", () => {
    const { from: clampedFrom } = clampAvailabilityWindow(now, fiveDaysOut, baseRules, now);
    expect(clampedFrom.getTime()).toBe(now.getTime() + baseRules.minNoticeHours * 3_600_000);
  });

  it("pulls `to` back to at most now + maxDaysAhead", () => {
    const farOut = new Date(now.getTime() + 365 * 86_400_000);
    const { to: clampedTo } = clampAvailabilityWindow(now, farOut, baseRules, now);
    expect(clampedTo.getTime()).toBe(now.getTime() + baseRules.maxDaysAhead * 86_400_000);
  });
});
