export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedTimeParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Converts a wall-clock date/time expressed in `timeZone` to the equivalent UTC instant.
 * Uses the standard guess-and-correct technique: treat the wall-clock values as if they
 * were UTC, see what that instant reads as in `timeZone`, then shift by the difference.
 */
export function zonedDateToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const parts = zonedTimeParts(utcGuess, timeZone);
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const diff = asIfUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - diff);
}

/** "YYYY-MM-DD" for the LOCAL calendar date `date` falls on in `timeZone`. Fase 7I -- the single
 * canonical string form for a DatePreference.targetDate, used both by date-preference-parser.ts
 * (resolving "hoy"/"mañana"/an explicit date) and availability.ts's filterSlotsByDatePreference
 * (matching a candidate slot's own local date against it), so the two can never drift apart. */
export function localDateString(date: Date, timeZone: string): string {
  const p = zonedTimeParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" for `days` calendar days after (or before, if negative) the LOCAL calendar date
 * `date` falls on in `timeZone` -- pure calendar arithmetic that never touches the wall-clock
 * time, the same "anchor local Y/M/D as a UTC midnight instant, then shift by whole days"
 * technique domain/availability.ts's enumerateWorkdaySlots already uses for iterating days. */
export function addLocalDaysToString(date: Date, timeZone: string, days: number): string {
  const p = zonedTimeParts(date, timeZone);
  const anchored = new Date(Date.UTC(p.year, p.month - 1, p.day) + days * 86_400_000);
  return `${anchored.getUTCFullYear()}-${String(anchored.getUTCMonth() + 1).padStart(2, "0")}-${String(anchored.getUTCDate()).padStart(2, "0")}`;
}

/** 0=Sunday..6=Saturday for an already-resolved LOCAL calendar date (year/month/day) -- pure
 * calendar arithmetic via a UTC-anchored midnight instant, the same convention every existing
 * day-of-week check in this codebase already uses (see domain/availability.ts). Never JS's
 * Intl "first day of week" locale convention, never ISO-8601's Monday=1..Sunday=7. */
export function weekdayOfLocalDate(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
