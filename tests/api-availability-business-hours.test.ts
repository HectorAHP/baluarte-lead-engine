import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers/test-app.js";
import { computeAvailableSlots, isWithinBusinessHours, type AvailabilityRules } from "../src/domain/availability.js";
import { zonedTimeParts } from "../src/domain/timezone.js";
import type { CalendarProvider } from "../src/application/ports.js";

/**
 * Fase 7F item 10/16 -- confirms GET /api/availability (the public route, independent of
 * WhatsApp) applies the exact same weekly business-hours rule as everything else -- single source
 * of truth (domain/availability.ts's computeAvailableSlots, the SAME function
 * GoogleCalendarProvider.getAvailableSlots calls in production). This test double calls that real
 * function directly (never FakeCalendarProvider's own business-hours-agnostic slot enumerator,
 * and never a hardcoded maxSlots cap) so the full week's worth of slots are visible to inspect.
 */
const REAL_WEEKLY_RULES: AvailabilityRules = {
  timezone: "America/Mexico_City",
  workdayStart: "09:00",
  workdayEnd: "19:00",
  saturdayWorkdayEnd: "14:00",
  sundayBookingEnabled: false,
  minNoticeHours: 2,
  maxDaysAhead: 14,
  maxSlots: 1000, // no cap here -- we want to see everything the window could offer, to prove none of it is Sunday/late-Saturday
};

function makeRulesEnforcingCalendar(): CalendarProvider {
  return {
    async getAvailableSlots(from, to, durationMinutes) {
      return computeAvailableSlots(from, to, durationMinutes, [], REAL_WEEKLY_RULES);
    },
    async isSlotAvailable() {
      return true;
    },
    isWithinBusinessHours: (start, end) => isWithinBusinessHours(start, end, REAL_WEEKLY_RULES),
    async createEvent(): Promise<never> {
      throw new Error("not used in this test");
    },
    async deleteEvent() {},
  };
}

describe("Fase 7F -- GET /api/availability respects weekly business hours", () => {
  it("item 16: never returns a Sunday slot, and every Saturday slot ends by 14:00, over a full week window", async () => {
    const app = await buildTestApp({ calendar: makeRulesEnforcingCalendar() });
    const from = new Date(); // "now" -- the route itself clamps to real min-notice/max-days-ahead
    const to = new Date(from.getTime() + 7 * 86_400_000);

    const res = await app.inject({ method: "GET", url: `/api/availability?from=${from.toISOString()}&to=${to.toISOString()}&duration=30` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { timezone: string; slots: Array<{ start: string; end: string }> };
    expect(body.timezone).toBe("America/Mexico_City");
    expect(body.slots.length).toBeGreaterThan(0); // sanity: the window genuinely produced slots
    for (const slot of body.slots) {
      const startParts = zonedTimeParts(new Date(slot.start), "America/Mexico_City");
      const dayOfWeek = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day)).getUTCDay();
      expect(dayOfWeek).not.toBe(0); // never Sunday
      if (dayOfWeek === 6) {
        // Saturday -- must end by 14:00 local.
        const endParts = zonedTimeParts(new Date(slot.end), "America/Mexico_City");
        expect(endParts.hour * 60 + endParts.minute).toBeLessThanOrEqual(14 * 60);
      }
    }
  });
});
