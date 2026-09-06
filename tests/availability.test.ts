import { describe, expect, it } from "vitest";
import { computeAvailableSlots, clampAvailabilityWindow, isWithinBusinessHours, workdayBoundsForLocalDate, type AvailabilityRules } from "../src/domain/availability.js";
import { zonedDateToUtc, zonedTimeParts } from "../src/domain/timezone.js";

const tz = "America/Mexico_City";
const baseRules: AvailabilityRules = {
  timezone: tz,
  workdayStart: "09:00",
  workdayEnd: "19:00",
  // Fase 7F -- Baluarte Capital's real weekend hours: Saturday closes at 14:00, Sunday closed.
  saturdayWorkdayEnd: "14:00",
  sundayBookingEnabled: false,
  minNoticeHours: 2,
  maxDaysAhead: 14,
  maxSlots: 3,
};

// A fixed reference instant: 2026-03-02T00:00 local time (Monday). The following week, by
// dayOffset from this Monday: 0=Mon 1=Tue 2=Wed 3=Thu 4=Fri 5=Sat(2026-03-07) 6=Sun(2026-03-08).
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

// ---------------------------------------------------------------------------------------------
// Fase 7F -- weekly business-hours (Monday-Friday unchanged, Saturday closes at 14:00, Sunday
// closed). QA finding this closes: Lía offered "domingo 6:00pm / 6:30pm" -- computeAvailableSlots
// previously applied the SAME workdayStart/workdayEnd to every calendar day, with no concept of
// day-of-week at all.
// ---------------------------------------------------------------------------------------------
const sevenDaysOut = new Date(now.getTime() + 7 * 86_400_000); // covers through the following Monday -- wide enough to include the full Saturday+Sunday

describe("computeAvailableSlots -- Fase 7F weekly business hours", () => {
  it("item 1: Monday within hours -> offered", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 1000 };
    const slots = computeAvailableSlots(from, sevenDaysOut, 30, [], rules, now);
    expect(slots.some((s) => s.start.getTime() === localSlotStart(9, 0, 0).getTime())).toBe(true);
  });

  it("item 2: Friday within hours -> offered, same hours as every other weekday", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 1000 };
    const slots = computeAvailableSlots(from, sevenDaysOut, 30, [], rules, now);
    expect(slots.some((s) => s.start.getTime() === localSlotStart(9, 0, 4).getTime())).toBe(true);
    expect(slots.some((s) => s.start.getTime() === localSlotStart(18, 30, 4).getTime())).toBe(true); // last 30-min slot before 19:00
  });

  it("item 3: Saturday 09:00 -> offered", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 1000 };
    const slots = computeAvailableSlots(from, sevenDaysOut, 30, [], rules, now);
    expect(slots.some((s) => s.start.getTime() === localSlotStart(9, 0, 5).getTime())).toBe(true);
  });

  it("item 4: Saturday 13:30 with 30min duration (ends exactly 14:00) -> offered", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 1000 };
    const slots = computeAvailableSlots(from, sevenDaysOut, 30, [], rules, now);
    const match = slots.find((s) => s.start.getTime() === localSlotStart(13, 30, 5).getTime());
    expect(match).toBeDefined();
    expect(match!.end.getTime()).toBe(localSlotStart(14, 0, 5).getTime());
  });

  it("item 5: Saturday 14:00 with 30min duration (would end 14:30) -> never offered", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 1000 };
    const slots = computeAvailableSlots(from, sevenDaysOut, 30, [], rules, now);
    expect(slots.some((s) => s.start.getTime() === localSlotStart(14, 0, 5).getTime())).toBe(false);
    // No Saturday slot of any kind ever ends after 14:00.
    const saturdaySlots = slots.filter((s) => zonedTimeParts(s.start, tz).day === zonedTimeParts(localSlotStart(0, 0, 5), tz).day);
    for (const slot of saturdaySlots) {
      expect(slot.end.getTime()).toBeLessThanOrEqual(localSlotStart(14, 0, 5).getTime());
    }
  });

  it("item 6: an exact instant check -- a Saturday appointment ending 14:01 is rejected by isWithinBusinessHours", () => {
    const start = localSlotStart(13, 31, 5);
    const end = localSlotStart(14, 1, 5);
    expect(isWithinBusinessHours(start, end, baseRules)).toBe(false);
  });

  it("item 7: Sunday 09:00 -> never offered", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 1000 };
    const slots = computeAvailableSlots(from, sevenDaysOut, 30, [], rules, now);
    expect(slots.some((s) => s.start.getTime() === localSlotStart(9, 0, 6).getTime())).toBe(false);
  });

  it("item 8: Sunday 18:00 -> never offered (the exact real QA finding: Lía offered domingo 6:00pm/6:30pm)", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 1000 };
    const slots = computeAvailableSlots(from, sevenDaysOut, 30, [], rules, now);
    expect(slots.some((s) => s.start.getTime() === localSlotStart(18, 0, 6).getTime())).toBe(false);
    expect(slots.some((s) => s.start.getTime() === localSlotStart(18, 30, 6).getTime())).toBe(false);
  });

  it("item 9: Google Calendar fully free on Sunday (busy=[]) -- still rejected. Business hours are never inferred from Calendar.", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 1000 };
    // Window scoped to ONLY the Sunday -- if the (bugged) old logic ran, every slot in this exact
    // window would be a Sunday slot, since there's nothing else in range.
    const sundayStart = localSlotStart(0, 0, 6);
    const sundayEnd = localSlotStart(0, 0, 7);
    const slots = computeAvailableSlots(sundayStart, sundayEnd, 30, [], rules, now);
    expect(slots).toEqual([]);
  });

  it("items 12/13/14: min notice, max days ahead, and Calendar busy filtering all still work unchanged alongside the new weekly rule", () => {
    const rules: AvailabilityRules = { ...baseRules, maxSlots: 1000 };
    const cutoff = now.getTime() + baseRules.minNoticeHours * 3_600_000;
    const slots = computeAvailableSlots(from, sevenDaysOut, 30, [{ start: localSlotStart(9, 0, 0), end: localSlotStart(9, 30, 0) }], rules, now);
    for (const slot of slots) expect(slot.start.getTime()).toBeGreaterThanOrEqual(cutoff); // min notice
    expect(slots.some((s) => s.start.getTime() === localSlotStart(9, 0, 0).getTime())).toBe(false); // busy slot excluded
    expect(slots.some((s) => s.start.getTime() === localSlotStart(9, 30, 0).getTime())).toBe(true); // next free one still offered

    const rulesShortHorizon: AvailabilityRules = { ...baseRules, maxSlots: 1000, maxDaysAhead: 3 };
    const farOut = new Date(now.getTime() + 30 * 86_400_000);
    const horizonSlots = computeAvailableSlots(from, farOut, 30, [], rulesShortHorizon, now);
    const horizon = now.getTime() + 3 * 86_400_000;
    for (const slot of horizonSlots) expect(slot.start.getTime()).toBeLessThanOrEqual(horizon); // max days ahead
  });
});

describe("isWithinBusinessHours -- Fase 7F, timezone crossing UTC/local", () => {
  // item 10/11: a UTC instant whose UTC calendar date differs from its Mexico City calendar date
  // (America/Mexico_City is UTC-6 year-round -- Mexico abolished DST for this region in 2022) --
  // must be classified by the LOCAL day, never the raw UTC day-of-week.
  it("item 10: a UTC instant that is already Sunday in UTC, but still Saturday in Mexico City, is treated as Saturday", () => {
    // 2026-03-08 (Sunday) 03:00 UTC = 2026-03-07 (Saturday) 21:00 America/Mexico_City.
    // 21:00 local is well past the Saturday 14:00 cutoff -- so this must be rejected for being
    // OUTSIDE Saturday's hours, never because it was (wrongly) read as Sunday.
    const start = new Date("2026-03-08T03:00:00.000Z");
    const end = new Date("2026-03-08T03:30:00.000Z");
    const bounds = workdayBoundsForLocalDate(2026, 3, 7, baseRules); // the correct LOCAL date this instant falls on
    expect(bounds).not.toBeNull(); // Saturday is never fully closed
    expect(isWithinBusinessHours(start, end, baseRules)).toBe(false); // rejected for being past 14:00 Saturday, not for being "Sunday"
  });

  it("item 11: a UTC instant that is still Saturday in UTC, but already Sunday in Mexico City, is treated as Sunday (rejected)", () => {
    // 2026-03-07 (Saturday) 05:30 UTC = 2026-03-06 (Friday) 23:30 America/Mexico_City -- this
    // direction (UTC ahead of local) never actually crosses INTO Sunday for a UTC-6 zone from a
    // Saturday UTC date, so use the genuine case instead: 2026-03-09 (Monday) 04:00 UTC =
    // 2026-03-08 (Sunday) 22:00 local -- UTC already reads Monday while local is still Sunday.
    const start = new Date("2026-03-09T04:00:00.000Z");
    const end = new Date("2026-03-09T04:30:00.000Z");
    const localParts = zonedTimeParts(start, tz);
    expect(localParts.day).toBe(8); // confirms the local calendar date is genuinely the 8th (Sunday), not the 9th (Monday, per raw UTC)
    expect(workdayBoundsForLocalDate(localParts.year, localParts.month, localParts.day, baseRules)).toBeNull(); // closed
    expect(isWithinBusinessHours(start, end, baseRules)).toBe(false);
  });
});

describe("workdayBoundsForLocalDate -- Fase 7F", () => {
  it("Sunday is null (closed) by default", () => {
    expect(workdayBoundsForLocalDate(2026, 3, 8, baseRules)).toBeNull();
  });

  it("Saturday reuses workdayStart but has its own end", () => {
    expect(workdayBoundsForLocalDate(2026, 3, 7, baseRules)).toEqual({ startH: 9, startM: 0, endH: 14, endM: 0 });
  });

  it("a weekday uses workdayStart/workdayEnd, unaffected by the weekend rules", () => {
    expect(workdayBoundsForLocalDate(2026, 3, 2, baseRules)).toEqual({ startH: 9, startM: 0, endH: 19, endM: 0 }); // Monday
    expect(workdayBoundsForLocalDate(2026, 3, 6, baseRules)).toEqual({ startH: 9, startM: 0, endH: 19, endM: 0 }); // Friday
  });

  it("sundayBookingEnabled=true falls back to the SAME Monday-Friday hours -- never a separate, invented Sunday schedule", () => {
    const rules: AvailabilityRules = { ...baseRules, sundayBookingEnabled: true };
    expect(workdayBoundsForLocalDate(2026, 3, 8, rules)).toEqual({ startH: 9, startM: 0, endH: 19, endM: 0 });
  });
});
