import { randomUUID } from "node:crypto";
import type { CalendarProvider, CalendarSlot, CalendarEventInput, CalendarEventResult } from "../application/ports.js";
import { SlotUnavailableError } from "../domain/errors.js";
import { filterSlotsByDatePreference } from "../domain/availability.js";
import type { DatePreference } from "../domain/date-preference.js";

export class FakeCalendarProvider implements CalendarProvider {
  private busy: Array<{ id: string; start: Date; end: Date }> = [];

  /**
   * Fase 7I -- `datePreference` (when given) is applied via the REAL
   * filterSlotsByDatePreference (never a second, duplicate implementation), BEFORE the existing
   * `out.length >= 3` truncation below -- same "filter before truncate" ordering
   * domain/availability.ts's computeAvailableSlots enforces for the real provider. This fake still
   * has NO real business-hours concept (see isWithinBusinessHours's own doc comment just below --
   * that stays deliberately permissive) -- date-preference filtering is an orthogonal concern:
   * with `datePreference` omitted (every pre-existing call site), this method is byte-identical to
   * before this feature existed.
   */
  async getAvailableSlots(from: Date, to: Date, durationMinutes: number, datePreference?: DatePreference): Promise<CalendarSlot[]> {
    const candidates: CalendarSlot[] = [];
    const d = durationMinutes * 60000;
    for (let c = from.getTime(); c + d <= to.getTime(); c += d) {
      const start = new Date(c), end = new Date(c + d);
      if (await this.isSlotAvailable(start, end)) candidates.push({ start, end });
    }
    const filtered = filterSlotsByDatePreference(candidates, datePreference, "America/Mexico_City");
    return filtered.slice(0, 3);
  }

  async isSlotAvailable(start: Date, end: Date) {
    return !this.busy.some((b) => start < b.end && end > b.start);
  }

  /**
   * Fase 7F -- deliberately ALWAYS true. This fake has no real business-hours concept (the
   * hundreds of existing tests using it pick arbitrary dates/times with no regard for day-of-week
   * or Baluarte's real commercial hours, by design -- see GoogleCalendarProvider for the real
   * enforcement). Never add real business-hours logic here -- a test that specifically needs to
   * verify business-hours enforcement should exercise domain/availability.ts's own
   * isWithinBusinessHours directly, or construct a real GoogleCalendarProvider-shaped check --
   * never by making this shared fake stricter, which would silently break every other test that
   * uses it.
   */
  isWithinBusinessHours(_start: Date, _end: Date): boolean {
    return true;
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEventResult> {
    if (!(await this.isSlotAvailable(input.start, input.end))) throw new SlotUnavailableError();
    const id = randomUUID();
    this.busy.push({ id, start: input.start, end: input.end });
    return { eventId: id, meetingUrl: `https://meet.google.com/fake-${id.slice(0, 10)}` };
  }

  async deleteEvent(eventId: string): Promise<void> {
    this.busy = this.busy.filter((b) => b.id !== eventId);
  }
}
