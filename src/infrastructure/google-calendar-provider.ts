import { randomUUID } from "node:crypto";
import { google, type calendar_v3 } from "googleapis";
import type { CalendarProvider, CalendarSlot, CalendarEventInput, CalendarEventResult } from "../application/ports.js";
import { CalendarProviderError, SlotUnavailableError } from "../domain/errors.js";
import { computeAvailableSlots, clampAvailabilityWindow, type AvailabilityRules, type BusyPeriod } from "../domain/availability.js";
import { config } from "../config.js";

export class GoogleCalendarProvider implements CalendarProvider {
  private readonly calendarApi: calendar_v3.Calendar;
  private readonly calendarId: string;

  /**
   * `injectedApi` exists purely as a test seam so unit tests can supply a mock
   * calendar_v3.Calendar without real Google credentials. Production code always
   * calls the no-arg constructor.
   */
  constructor(injectedApi?: calendar_v3.Calendar) {
    this.calendarId = config.GOOGLE_CALENDAR_ID;
    if (injectedApi) {
      this.calendarApi = injectedApi;
      return;
    }
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !config.GOOGLE_REFRESH_TOKEN) {
      throw new CalendarProviderError("Google Calendar credentials are not configured");
    }
    const auth = new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN });
    this.calendarApi = google.calendar({ version: "v3", auth });
  }

  async getAvailableSlots(from: Date, to: Date, durationMinutes: number): Promise<CalendarSlot[]> {
    const rules = this.rules();
    const { from: effectiveFrom, to: effectiveTo } = clampAvailabilityWindow(from, to, rules);
    if (effectiveFrom >= effectiveTo) return [];
    const busy = await this.fetchBusyPeriods(effectiveFrom, effectiveTo);
    return computeAvailableSlots(from, to, durationMinutes, busy, rules);
  }

  async isSlotAvailable(start: Date, end: Date): Promise<boolean> {
    const busy = await this.fetchBusyPeriods(start, end);
    return !busy.some((b) => start < b.end && end > b.start);
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEventResult> {
    const available = await this.isSlotAvailable(input.start, input.end);
    if (!available) throw new SlotUnavailableError();

    const requestId = randomUUID();
    let response;
    try {
      response = await this.calendarApi.events.insert({
        calendarId: this.calendarId,
        conferenceDataVersion: 1,
        requestBody: {
          summary: input.title,
          description: input.description,
          start: { dateTime: input.start.toISOString(), timeZone: config.ADVISOR_TIMEZONE },
          end: { dateTime: input.end.toISOString(), timeZone: config.ADVISOR_TIMEZONE },
          attendees: input.attendeeEmail ? [{ email: input.attendeeEmail }] : undefined,
          conferenceData: {
            createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } },
          },
        },
      });
    } catch (err) {
      throw new CalendarProviderError("Failed to create Google Calendar event", { cause: err });
    }

    const eventId = response.data.id;
    if (!eventId) throw new CalendarProviderError("Google Calendar did not return an event id");

    // Conference creation is asynchronous on Google's side; entry points (and hangoutLink) may
    // still be pending. Fall through to undefined rather than throwing so the appointment is
    // still booked — the Meet link can be filled in on a later sync if needed.
    const meetingUrl =
      response.data.hangoutLink ??
      response.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
      undefined;

    return { eventId, meetingUrl: meetingUrl ?? undefined };
  }

  /**
   * Idempotent: a 404 (event not found) or 410 (event already deleted -- Google's status for a
   * previously-cancelled event) is treated as SUCCESS, since the desired end state ("this event
   * no longer exists") is already true. This matters for Phase 4B cancellation: a retry of a
   * cleanup that actually succeeded server-side despite a client-side timeout must never be
   * reported as a failure. Any other error (network, auth, rate limit, 5xx) still throws
   * CalendarProviderError -- only a confirmed "already gone" status is ever treated as success.
   */
  async deleteEvent(eventId: string): Promise<void> {
    try {
      await this.calendarApi.events.delete({ calendarId: this.calendarId, eventId });
    } catch (err) {
      if (isEventAlreadyGoneError(err)) return;
      throw new CalendarProviderError("Failed to delete Google Calendar event", { cause: err });
    }
  }

  private rules(): AvailabilityRules {
    return {
      timezone: config.ADVISOR_TIMEZONE,
      workdayStart: config.WORKDAY_START,
      workdayEnd: config.WORKDAY_END,
      minNoticeHours: config.BOOKING_MIN_NOTICE_HOURS,
      maxDaysAhead: config.BOOKING_MAX_DAYS_AHEAD,
      maxSlots: 3,
    };
  }

  private async fetchBusyPeriods(from: Date, to: Date): Promise<BusyPeriod[]> {
    try {
      const res = await this.calendarApi.freebusy.query({
        requestBody: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: this.calendarId }] },
      });
      const busy = res.data.calendars?.[this.calendarId]?.busy ?? [];
      return busy
        .filter((b): b is { start: string; end: string } => Boolean(b.start && b.end))
        .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
    } catch (err) {
      throw new CalendarProviderError("Failed to query Google Calendar free/busy", { cause: err });
    }
  }
}

/**
 * googleapis (built on gaxios) errors don't have one single documented shape across versions --
 * defensively checks every field a 404/410 has actually been observed under (`code`, `status`,
 * `response.status`), coercing to a number since some surface it as a string. A plain Error with
 * none of these fields (e.g. a generic network failure) safely yields NaN, which matches neither
 * 404 nor 410 -- never misclassified as "already gone".
 */
function isEventAlreadyGoneError(err: unknown): boolean {
  const candidate = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const status = Number(candidate?.code ?? candidate?.status ?? candidate?.response?.status);
  return status === 404 || status === 410;
}
