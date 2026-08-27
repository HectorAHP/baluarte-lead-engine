import { zonedDateToUtc, zonedTimeParts } from "./timezone.js";

export interface Slot {
  start: Date;
  end: Date;
}

export interface BusyPeriod {
  start: Date;
  end: Date;
}

export interface AvailabilityRules {
  timezone: string;
  workdayStart: string; // "HH:MM"
  workdayEnd: string; // "HH:MM"
  minNoticeHours: number;
  maxDaysAhead: number;
  maxSlots: number;
}

export function clampAvailabilityWindow(
  from: Date,
  to: Date,
  rules: Pick<AvailabilityRules, "minNoticeHours" | "maxDaysAhead">,
  now: Date = new Date(),
): { from: Date; to: Date } {
  const minNoticeCutoff = new Date(now.getTime() + rules.minNoticeHours * 3_600_000);
  const maxHorizon = new Date(now.getTime() + rules.maxDaysAhead * 86_400_000);
  const effectiveFrom = new Date(Math.max(from.getTime(), minNoticeCutoff.getTime(), now.getTime()));
  const effectiveTo = new Date(Math.min(to.getTime(), maxHorizon.getTime()));
  return { from: effectiveFrom, to: effectiveTo };
}

export function computeAvailableSlots(
  from: Date,
  to: Date,
  durationMinutes: number,
  busy: BusyPeriod[],
  rules: AvailabilityRules,
  now: Date = new Date(),
): Slot[] {
  const { from: effectiveFrom, to: effectiveTo } = clampAvailabilityWindow(from, to, rules, now);
  if (effectiveFrom >= effectiveTo) return [];

  const candidates = enumerateWorkdaySlots(effectiveFrom, effectiveTo, durationMinutes, rules);
  const free = candidates.filter((slot) => !busy.some((b) => slot.start < b.end && slot.end > b.start));
  free.sort((a, b) => a.start.getTime() - b.start.getTime());
  return free.slice(0, rules.maxSlots);
}

function enumerateWorkdaySlots(from: Date, to: Date, durationMinutes: number, rules: AvailabilityRules): Slot[] {
  const [startH, startM] = rules.workdayStart.split(":").map(Number);
  const [endH, endM] = rules.workdayEnd.split(":").map(Number);
  const fromParts = zonedTimeParts(from, rules.timezone);
  const baseDay = new Date(Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day));
  const maxDays = rules.maxDaysAhead + 2; // safety buffer against off-by-one at the horizon edge
  const durationMs = durationMinutes * 60_000;
  const slots: Slot[] = [];

  for (let dayOffset = 0; dayOffset <= maxDays; dayOffset++) {
    const day = new Date(baseDay.getTime() + dayOffset * 86_400_000);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const dayStart = zonedDateToUtc(y, m, d, startH, startM, rules.timezone);
    const dayEnd = zonedDateToUtc(y, m, d, endH, endM, rules.timezone);
    if (dayStart.getTime() > to.getTime()) break;
    for (let t = dayStart.getTime(); t + durationMs <= dayEnd.getTime(); t += durationMs) {
      const slotStart = new Date(t);
      const slotEnd = new Date(t + durationMs);
      if (slotStart.getTime() >= from.getTime() && slotEnd.getTime() <= to.getTime()) {
        slots.push({ start: slotStart, end: slotEnd });
      }
    }
  }
  return slots;
}
