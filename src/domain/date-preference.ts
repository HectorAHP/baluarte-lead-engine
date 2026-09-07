/**
 * Fase 7I -- a deterministic, user-expressed temporal preference for booking/reschedule slot
 * offering. Produced only by date-preference-parser.ts's parseDatePreference (never hand-built
 * from anywhere else), and consumed by availability.ts's filterSlotsByDatePreference plus
 * SlotOfferingService/CalendarProvider's plumbing between them.
 *
 * All three fields are optional and independent: `daypart` can combine with either `targetDate`
 * or `weekday` ("sábado por la mañana", "lunes por la tarde"). `targetDate` and `weekday` are
 * mutually exclusive in practice -- the parser only ever sets ONE "day selector" per call (an
 * explicit/relative date always takes priority over a bare weekday name; see that module's own
 * doc comment for the exact priority order), never both at once.
 *
 * weekday semantics: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
 * -- the SAME convention this codebase already uses everywhere else (Date.prototype.getUTCDay(),
 * and every existing `dayOfWeek === 0` / `dayOfWeek === 6` check in domain/availability.ts and its
 * tests). Never JS's Intl "locale first day of week" convention, never ISO-8601's Monday=1
 * .. Sunday=7. Documented once here as the single source of truth for this convention.
 */
export interface DatePreference {
  /** "YYYY-MM-DD", a LOCAL (business timezone, e.g. America/Mexico_City) calendar date -- never a
   * UTC instant, never a Date object (a Date can't unambiguously represent "this calendar day
   * regardless of time-of-day" the way this string does). Set for an explicit date ("12 de
   * septiembre") or a resolved relative date ("hoy" / "mañana" / "pasado mañana"). The parser
   * deliberately resolves these all the way down to a concrete date rather than leaving them
   * relative, since "today"/"tomorrow" only make sense evaluated against a specific `now`. */
  targetDate?: string;
  /** 0=Sunday .. 6=Saturday. Set for a bare weekday name ("sábado") -- deliberately NOT resolved
   * to a concrete calendar date by the parser. The availability layer's own chronological slot
   * generation already surfaces whichever matching day comes first once filtered (today's
   * remaining slots if today IS that weekday and any are still valid, otherwise the next
   * occurrence) purely as a byproduct of "filter, then take the earliest" -- no separate "resolve
   * to next Saturday" date arithmetic is needed or performed anywhere. */
  weekday?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  daypart?: Daypart;
}

export type Daypart = "MORNING" | "AFTERNOON" | "EVENING";

/**
 * Fase 7I -- daypart time windows, in LOCAL (business timezone) minutes-since-midnight. This is a
 * NEW definition introduced specifically for this feature: no prior business-hours concept in
 * this codebase already splits the working day into morning/afternoon/evening (WORKDAY_START /
 * WORKDAY_END / SATURDAY_WORKDAY_END only define WHEN the business is open at all, never a
 * within-day split) -- so this is not inferred from anything pre-existing, and is centralized
 * here, once, as the single source of truth booking and reschedule both read from.
 *
 * Windows are half-open on neither side in the way they're actually applied: a candidate slot
 * must satisfy `slot.start >= window.startMinute AND slot.end <= window.endMinute` (see
 * filterSlotsByDatePreference in availability.ts) -- both boundaries inclusive from the slot's own
 * perspective. This means a slot ending EXACTLY at a boundary (e.g. 11:30-12:00) belongs to the
 * EARLIER window (MORNING), never double-counted into both and never silently dropped from
 * either, because 12:00 is simultaneously MORNING's inclusive end and AFTERNOON's inclusive
 * start -- but a slot must start >= AFTERNOON's start (12:00) to ever qualify for AFTERNOON, so
 * 11:30-12:00 fails that check and only ever matches MORNING.
 */
export const DAYPART_WINDOWS_MINUTES: Record<Daypart, { startMinute: number; endMinute: number }> = {
  MORNING: { startMinute: 9 * 60, endMinute: 12 * 60 },
  AFTERNOON: { startMinute: 12 * 60, endMinute: 18 * 60 },
  EVENING: { startMinute: 18 * 60, endMinute: 24 * 60 },
};
