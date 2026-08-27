import { describe, expect, it, vi } from "vitest";
import type { calendar_v3 } from "googleapis";
import { GoogleCalendarProvider } from "../src/infrastructure/google-calendar-provider.js";
import { SlotUnavailableError, CalendarProviderError } from "../src/domain/errors.js";
import { config } from "../src/config.js";

function makeMockApi(overrides: { freebusyQuery?: ReturnType<typeof vi.fn>; eventsInsert?: ReturnType<typeof vi.fn>; eventsDelete?: ReturnType<typeof vi.fn> } = {}) {
  const api = {
    freebusy: {
      query: overrides.freebusyQuery ?? vi.fn().mockResolvedValue({ data: { calendars: { [config.GOOGLE_CALENDAR_ID]: { busy: [] } } } }),
    },
    events: {
      insert: overrides.eventsInsert ?? vi.fn().mockResolvedValue({ data: { id: "evt_1", hangoutLink: "https://meet.google.com/abc-defg-hij" } }),
      delete: overrides.eventsDelete ?? vi.fn().mockResolvedValue({}),
    },
  };
  return api as unknown as calendar_v3.Calendar;
}

const sampleInput = {
  title: "Cita PPR",
  description: "Reunion inicial",
  start: new Date("2026-03-02T15:00:00.000Z"),
  end: new Date("2026-03-02T15:30:00.000Z"),
};

describe("GoogleCalendarProvider.createEvent", () => {
  it("revalidates availability immediately before creating and rejects with SlotUnavailableError if occupied", async () => {
    const freebusyQuery = vi.fn().mockResolvedValue({
      data: { calendars: { [config.GOOGLE_CALENDAR_ID]: { busy: [{ start: "2026-03-02T15:00:00.000Z", end: "2026-03-02T15:30:00.000Z" }] } } },
    });
    const eventsInsert = vi.fn();
    const provider = new GoogleCalendarProvider(makeMockApi({ freebusyQuery, eventsInsert }));

    await expect(provider.createEvent(sampleInput)).rejects.toThrow(SlotUnavailableError);
    expect(eventsInsert).not.toHaveBeenCalled();
  });

  it("generates a unique conference requestId per createEvent call", async () => {
    const eventsInsert = vi.fn().mockResolvedValue({ data: { id: "evt_1", hangoutLink: "https://meet.google.com/abc-defg-hij" } });
    const provider = new GoogleCalendarProvider(makeMockApi({ eventsInsert }));

    await provider.createEvent(sampleInput);
    await provider.createEvent({ ...sampleInput, start: new Date("2026-03-02T16:00:00.000Z"), end: new Date("2026-03-02T16:30:00.000Z") });

    const calls = eventsInsert.mock.calls as Array<[{ requestBody: { conferenceData: { createRequest: { requestId: string } } } }]>;
    const requestIds = calls.map((c) => c[0].requestBody.conferenceData.createRequest.requestId);
    expect(requestIds[0]).toBeTruthy();
    expect(requestIds[1]).toBeTruthy();
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });

  it("sets conferenceDataVersion=1 on the insert call", async () => {
    const eventsInsert = vi.fn().mockResolvedValue({ data: { id: "evt_1" } });
    const provider = new GoogleCalendarProvider(makeMockApi({ eventsInsert }));
    await provider.createEvent(sampleInput);
    const call = eventsInsert.mock.calls[0][0] as { conferenceDataVersion: number };
    expect(call.conferenceDataVersion).toBe(1);
  });

  it("does not crash when conference creation is still pending (no hangoutLink, no entry points)", async () => {
    const eventsInsert = vi.fn().mockResolvedValue({
      data: { id: "evt_1", conferenceData: { createRequest: { status: { statusCode: "pending" } } } },
    });
    const provider = new GoogleCalendarProvider(makeMockApi({ eventsInsert }));
    const result = await provider.createEvent(sampleInput);
    expect(result.eventId).toBe("evt_1");
    expect(result.meetingUrl).toBeUndefined();
  });

  it("falls back to the video entry point uri when hangoutLink is absent", async () => {
    const eventsInsert = vi.fn().mockResolvedValue({
      data: { id: "evt_1", conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/xyz-uvwx-rst" }] } },
    });
    const provider = new GoogleCalendarProvider(makeMockApi({ eventsInsert }));
    const result = await provider.createEvent(sampleInput);
    expect(result.meetingUrl).toBe("https://meet.google.com/xyz-uvwx-rst");
  });

  it("wraps a transient Google API failure as CalendarProviderError, without leaking the raw error", async () => {
    const eventsInsert = vi.fn().mockRejectedValue(new Error("ECONNRESET: socket hang up"));
    const provider = new GoogleCalendarProvider(makeMockApi({ eventsInsert }));
    await expect(provider.createEvent(sampleInput)).rejects.toThrow(CalendarProviderError);
  });
});

describe("GoogleCalendarProvider.isSlotAvailable / getAvailableSlots", () => {
  it("wraps a freeBusy query failure as CalendarProviderError", async () => {
    const freebusyQuery = vi.fn().mockRejectedValue(new Error("network error"));
    const provider = new GoogleCalendarProvider(makeMockApi({ freebusyQuery }));
    await expect(provider.isSlotAvailable(sampleInput.start, sampleInput.end)).rejects.toThrow(CalendarProviderError);
  });

  it("uses freeBusy (not just a bare event listing) to determine availability", async () => {
    const freebusyQuery = vi.fn().mockResolvedValue({ data: { calendars: { [config.GOOGLE_CALENDAR_ID]: { busy: [] } } } });
    const provider = new GoogleCalendarProvider(makeMockApi({ freebusyQuery }));
    await provider.isSlotAvailable(sampleInput.start, sampleInput.end);
    expect(freebusyQuery).toHaveBeenCalledTimes(1);
    const call = freebusyQuery.mock.calls[0][0] as { requestBody: { items: Array<{ id: string }> } };
    expect(call.requestBody.items).toEqual([{ id: config.GOOGLE_CALENDAR_ID }]);
  });
});

describe("GoogleCalendarProvider.deleteEvent", () => {
  it("deletes the event by id (best-effort compensation path)", async () => {
    const eventsDelete = vi.fn().mockResolvedValue({});
    const provider = new GoogleCalendarProvider(makeMockApi({ eventsDelete }));
    await provider.deleteEvent("evt_1");
    expect(eventsDelete).toHaveBeenCalledWith({ calendarId: config.GOOGLE_CALENDAR_ID, eventId: "evt_1" });
  });

  it("wraps a delete failure with no recognizable status as CalendarProviderError", async () => {
    const eventsDelete = vi.fn().mockRejectedValue(new Error("not found"));
    const provider = new GoogleCalendarProvider(makeMockApi({ eventsDelete }));
    await expect(provider.deleteEvent("evt_1")).rejects.toThrow(CalendarProviderError);
  });

  // Phase 4B: idempotent cancellation retries depend on deleteEvent treating "the event is
  // already gone" as success, not failure -- see the DB-CANCELLED-then-Calendar-cleanup ordering
  // in AppointmentCancellationService.
  it("a 404 (event not found, code field) is treated as success", async () => {
    const eventsDelete = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { code: 404 }));
    const provider = new GoogleCalendarProvider(makeMockApi({ eventsDelete }));
    await expect(provider.deleteEvent("evt_1")).resolves.toBeUndefined();
  });

  it("a 410 (event already deleted, code field) is treated as success", async () => {
    const eventsDelete = vi.fn().mockRejectedValue(Object.assign(new Error("Gone"), { code: 410 }));
    const provider = new GoogleCalendarProvider(makeMockApi({ eventsDelete }));
    await expect(provider.deleteEvent("evt_1")).resolves.toBeUndefined();
  });

  it("a 404 surfaced via response.status (a plausible alternate gaxios error shape) is also treated as success", async () => {
    const eventsDelete = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { response: { status: 404 } }));
    const provider = new GoogleCalendarProvider(makeMockApi({ eventsDelete }));
    await expect(provider.deleteEvent("evt_1")).resolves.toBeUndefined();
  });

  it("a 404 surfaced as a string code is also treated as success (defensive coercion)", async () => {
    const eventsDelete = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { code: "404" }));
    const provider = new GoogleCalendarProvider(makeMockApi({ eventsDelete }));
    await expect(provider.deleteEvent("evt_1")).resolves.toBeUndefined();
  });

  it("a 5xx / transient failure still throws CalendarProviderError -- never silently treated as success", async () => {
    const eventsDelete = vi.fn().mockRejectedValue(Object.assign(new Error("Internal Server Error"), { code: 500 }));
    const provider = new GoogleCalendarProvider(makeMockApi({ eventsDelete }));
    await expect(provider.deleteEvent("evt_1")).rejects.toThrow(CalendarProviderError);
  });

  it("does not attempt a delete when the event was already deleted -- calling twice with a 404 the second time never throws", async () => {
    const eventsDelete = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error("Not Found"), { code: 404 }));
    const provider = new GoogleCalendarProvider(makeMockApi({ eventsDelete }));
    await provider.deleteEvent("evt_1");
    await expect(provider.deleteEvent("evt_1")).resolves.toBeUndefined();
    expect(eventsDelete).toHaveBeenCalledTimes(2);
  });
});
