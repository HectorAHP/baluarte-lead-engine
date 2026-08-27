import { randomUUID } from "node:crypto";
import type { CalendarProvider, CalendarSlot, CalendarEventInput, CalendarEventResult } from "../application/ports.js";
import { SlotUnavailableError } from "../domain/errors.js";

export class FakeCalendarProvider implements CalendarProvider {
  private busy: Array<{ id: string; start: Date; end: Date }> = [];

  async getAvailableSlots(from: Date, to: Date, durationMinutes: number): Promise<CalendarSlot[]> {
    const out: CalendarSlot[] = [];
    const d = durationMinutes * 60000;
    for (let c = from.getTime(); c + d <= to.getTime(); c += d) {
      const start = new Date(c), end = new Date(c + d);
      if (await this.isSlotAvailable(start, end)) out.push({ start, end });
      if (out.length >= 3) break;
    }
    return out;
  }

  async isSlotAvailable(start: Date, end: Date) {
    return !this.busy.some((b) => start < b.end && end > b.start);
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
