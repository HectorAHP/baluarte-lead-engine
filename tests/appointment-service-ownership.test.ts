import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppointmentService, PENDING_STALE_THRESHOLD_MS, fingerprintBooking, type BookInput } from "../src/application/services.js";
import { InMemoryAppointmentRepository, InMemoryBookingAttemptRepository, InMemoryLeadRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import {
  SlotUnavailableError,
  CalendarProviderError,
  IdempotencyConflictError,
  BookingInProgressError,
  BookingAttemptInconsistentError,
} from "../src/domain/errors.js";
import type { CalendarProvider, CalendarEventInput, CalendarEventResult } from "../src/application/ports.js";
import type { Appointment } from "../src/domain/appointment.js";

/** Wraps FakeCalendarProvider to count createEvent invocations -- the single most important
 * assertion in every test in this file. */
class CountingCalendarProvider implements CalendarProvider {
  public createEventCalls = 0;
  private readonly inner = new FakeCalendarProvider();
  getAvailableSlots(...args: Parameters<CalendarProvider["getAvailableSlots"]>) {
    return this.inner.getAvailableSlots(...args);
  }
  isSlotAvailable(...args: Parameters<CalendarProvider["isSlotAvailable"]>) {
    return this.inner.isSlotAvailable(...args);
  }
  async createEvent(input: CalendarEventInput): Promise<CalendarEventResult> {
    this.createEventCalls++;
    return this.inner.createEvent(input);
  }
  deleteEvent(...args: Parameters<CalendarProvider["deleteEvent"]>) {
    return this.inner.deleteEvent(...args);
  }
}

function makeService(calendarOverride?: CalendarProvider) {
  const calendar = calendarOverride ?? new CountingCalendarProvider();
  const appointments = new InMemoryAppointmentRepository();
  const bookingAttempts = new InMemoryBookingAttemptRepository();
  const leads = new InMemoryLeadRepository();
  const logger = new FakeLogger();
  const service = new AppointmentService(calendar, appointments, bookingAttempts, leads, logger);
  return { service, calendar: calendar as CountingCalendarProvider, appointments, bookingAttempts, leads, logger };
}

const leadId = "11111111-1111-1111-1111-111111111111";
function bookingInput(overrides: Partial<BookInput> = {}): BookInput {
  return {
    leadId,
    title: "Cita PPR",
    description: "Reunion inicial",
    start: new Date("2026-03-02T15:00:00.000Z"),
    end: new Date("2026-03-02T15:30:00.000Z"),
    attendeeEmail: "lead@example.com",
    timezone: "America/Mexico_City",
    ...overrides,
  };
}

describe("AppointmentService.book -- ownership foundation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("A: two concurrent requests for a brand-new key -- exactly one createEvent", async () => {
    const { service, calendar } = makeService();
    const key = randomUUID();
    const results = await Promise.allSettled([service.book(bookingInput(), key), service.book(bookingInput(), key)]);

    expect(calendar.createEventCalls).toBe(1);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Appointment> => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    // Whichever settled as fulfilled must be the same appointment (idempotent), never two different ones.
    const ids = new Set(fulfilled.map((r) => r.value.id));
    expect(ids.size).toBe(1);
  });

  it("B: a second request that finds a fresh PENDING never calls Google", async () => {
    const { service, bookingAttempts, calendar } = makeService();
    const input = bookingInput();
    const key = randomUUID();
    // Pre-seed a fresh PENDING row directly -- simulates another request currently owning it.
    await bookingAttempts.create({ leadId, idempotencyKey: key, requestFingerprint: fingerprintBooking(input), status: "PENDING" });

    await expect(service.book(input, key)).rejects.toThrow(BookingInProgressError);
    expect(calendar.createEventCalls).toBe(0);
  });

  it("C: COMPLETED with a valid appointment -- returns it, zero Google calls", async () => {
    const { service, bookingAttempts, appointments, calendar } = makeService();
    const input = bookingInput();
    const key = randomUUID();
    const appt = await appointments.create({ leadId, status: "BOOKED", startsAt: input.start, endsAt: input.end, timezone: input.timezone });
    await bookingAttempts.create({
      leadId, idempotencyKey: key, requestFingerprint: fingerprintBooking(input), status: "PENDING",
    });
    const seeded = await bookingAttempts.findByKey(key);
    await bookingAttempts.update(seeded!.id, { status: "COMPLETED", appointmentId: appt.id, providerEventId: "evt-1" });

    const result = await service.book(input, key);
    expect(result.id).toBe(appt.id);
    expect(calendar.createEventCalls).toBe(0);
  });

  it("D: COMPLETED with a missing appointment -- BookingAttemptInconsistentError, zero Google calls", async () => {
    const { service, bookingAttempts, calendar } = makeService();
    const input = bookingInput();
    const key = randomUUID();
    await bookingAttempts.create({ leadId, idempotencyKey: key, requestFingerprint: fingerprintBooking(input), status: "PENDING" });
    const seeded = await bookingAttempts.findByKey(key);
    // appointmentId points at a row that doesn't (or no longer) exist.
    await bookingAttempts.update(seeded!.id, { status: "COMPLETED", appointmentId: randomUUID(), providerEventId: "evt-1" });

    await expect(service.book(input, key)).rejects.toThrow(BookingAttemptInconsistentError);
    expect(calendar.createEventCalls).toBe(0);
  });

  it("E: FAILED + a single retry -- claims ownership, exactly one createEvent", async () => {
    const { service, bookingAttempts, calendar } = makeService();
    const input = bookingInput();
    const key = randomUUID();
    await bookingAttempts.create({ leadId, idempotencyKey: key, requestFingerprint: fingerprintBooking(input), status: "PENDING" });
    const seeded = await bookingAttempts.findByKey(key);
    await bookingAttempts.update(seeded!.id, { status: "FAILED" });

    const appt = await service.book(input, key);
    expect(appt.status).toBe("BOOKED");
    expect(calendar.createEventCalls).toBe(1);
  });

  it("F: two concurrent retries on the same FAILED row -- exactly one wins, exactly one createEvent", async () => {
    const { service, bookingAttempts, calendar } = makeService();
    const input = bookingInput();
    const key = randomUUID();
    await bookingAttempts.create({ leadId, idempotencyKey: key, requestFingerprint: fingerprintBooking(input), status: "PENDING" });
    const seeded = await bookingAttempts.findByKey(key);
    await bookingAttempts.update(seeded!.id, { status: "FAILED" });

    const results = await Promise.allSettled([service.book(input, key), service.book(input, key)]);
    expect(calendar.createEventCalls).toBe(1);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(BookingInProgressError);
  });

  it("G: stale PENDING (updatedAt beyond the threshold) is recovered -- exactly one createEvent", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const { service, bookingAttempts, calendar } = makeService();
    const input = bookingInput();
    const key = randomUUID();
    await bookingAttempts.create({ leadId, idempotencyKey: key, requestFingerprint: fingerprintBooking(input), status: "PENDING" });

    // Advance well past PENDING_STALE_THRESHOLD_MS -- the owning process "died" here.
    vi.setSystemTime(new Date(start.getTime() + PENDING_STALE_THRESHOLD_MS + 5_000));

    const appt = await service.book(input, key);
    expect(appt.status).toBe("BOOKED");
    expect(calendar.createEventCalls).toBe(1);
  });

  it("H: two concurrent recoveries of the same stale PENDING -- exactly one owner, exactly one createEvent", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const { service, bookingAttempts, calendar } = makeService();
    const input = bookingInput();
    const key = randomUUID();
    await bookingAttempts.create({ leadId, idempotencyKey: key, requestFingerprint: fingerprintBooking(input), status: "PENDING" });
    vi.setSystemTime(new Date(start.getTime() + PENDING_STALE_THRESHOLD_MS + 5_000));

    const results = await Promise.allSettled([service.book(input, key), service.book(input, key)]);
    expect(calendar.createEventCalls).toBe(1);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(BookingInProgressError);
  });

  it("I: a PENDING reclaimed less than 2 minutes ago reads as fresh by updatedAt, even though created_at is old", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const { service, bookingAttempts, calendar } = makeService();
    const input = bookingInput();
    const key = randomUUID();
    await bookingAttempts.create({ leadId, idempotencyKey: key, requestFingerprint: fingerprintBooking(input), status: "PENDING" });

    // Original row is already old enough to be "stale" by created_at...
    vi.setSystemTime(new Date(start.getTime() + PENDING_STALE_THRESHOLD_MS + 60_000));
    const seeded = await bookingAttempts.findByKey(key);
    // ...but gets legitimately reclaimed right now (updatedAt bumped by the claim).
    const reclaimed = await bookingAttempts.claimTransition(seeded!.id, "PENDING", "FAILED", {
      updatedBefore: new Date(Date.now() - PENDING_STALE_THRESHOLD_MS),
    });
    expect(reclaimed).not.toBeNull();
    await bookingAttempts.claimTransition(reclaimed!.id, "FAILED", "PENDING");

    // A tiny moment later (well under the 2-minute threshold from the reclaim), a second caller
    // must see this as FRESH -- created_at is still old, but updated_at is brand new.
    vi.setSystemTime(new Date(Date.now() + 1_000));

    await expect(service.book(input, key)).rejects.toThrow(BookingInProgressError);
    expect(calendar.createEventCalls).toBe(0);
  });

  it("J: a DB failure after the Google event is created still triggers the compensating deleteEvent", async () => {
    const input = bookingInput();
    const key = randomUUID();
    const calendar = new CountingCalendarProvider();
    let deletedEventId: string | undefined;
    const originalDelete = calendar.deleteEvent.bind(calendar);
    calendar.deleteEvent = async (eventId: string) => {
      deletedEventId = eventId;
      return originalDelete(eventId);
    };
    const bookingAttempts = new InMemoryBookingAttemptRepository();
    const logger = new FakeLogger();
    const leads = new InMemoryLeadRepository();
    const failingAppointments = {
      async create(): Promise<Appointment> {
        throw new Error("SUPABASE_APPOINTMENT_CREATE_FAILED: simulated DB outage");
      },
      async findById() {
        return null;
      },
      async update(id: string, patch: Partial<Appointment>) {
        return { id, ...patch } as Appointment;
      },
      async findActiveByLeadId() {
        return null;
      },
      async listActiveByLeadId() {
        return [];
      },
      async findMostRecentByLeadId() {
        return null;
      },
      async claimTransition() {
        return null;
      },
    };
    const service = new AppointmentService(calendar, failingAppointments, bookingAttempts, leads, logger);

    await expect(service.book(input, key)).rejects.toThrow();
    expect(calendar.createEventCalls).toBe(1);
    expect(deletedEventId).toBeTruthy();
    const attempt = await bookingAttempts.findByKey(key);
    expect(attempt?.status).toBe("FAILED");
  });

  it("K: a fingerprint mismatch on an existing key is rejected before any Google call", async () => {
    const { service, calendar } = makeService();
    const key = randomUUID();
    await service.book(bookingInput(), key);
    calendar.createEventCalls = 0; // reset the count from the first, legitimate booking

    await expect(service.book(bookingInput({ title: "Otro titulo" }), key)).rejects.toThrow(IdempotencyConflictError);
    expect(calendar.createEventCalls).toBe(0);
  });

  it("L: a create() conflict (23505-equivalent) recovers via findByKey and never duplicates Google", async () => {
    const { service, calendar } = makeService();
    const key = randomUUID();
    const input = bookingInput();

    // First booking wins create() outright.
    const first = await service.book(input, key);
    expect(calendar.createEventCalls).toBe(1);

    // A second call with the same key + same payload must reuse the COMPLETED row, not conflict.
    const second = await service.book(input, key);
    expect(second.id).toBe(first.id);
    expect(calendar.createEventCalls).toBe(1);
  });

  it("still rejects when the slot is occupied, marking the attempt FAILED (existing behavior, unaffected by ownership changes)", async () => {
    const { service, bookingAttempts } = makeService();
    await service.book(bookingInput(), randomUUID());
    const key = randomUUID();
    await expect(service.book(bookingInput(), key)).rejects.toThrow(SlotUnavailableError);
    const attempt = await bookingAttempts.findByKey(key);
    expect(attempt?.status).toBe("FAILED");
  });

  it("still translates a calendar provider failure and marks the attempt FAILED (existing behavior, unaffected)", async () => {
    const appointments = new InMemoryAppointmentRepository();
    const bookingAttempts = new InMemoryBookingAttemptRepository();
    const failingCalendar: CalendarProvider = {
      async getAvailableSlots() {
        return [];
      },
      async isSlotAvailable() {
        return true;
      },
      async createEvent(): Promise<CalendarEventResult> {
        throw new CalendarProviderError("Google is down");
      },
      async deleteEvent() {},
    };
    const leads = new InMemoryLeadRepository();
    const service = new AppointmentService(failingCalendar, appointments, bookingAttempts, leads, new FakeLogger());
    const key = randomUUID();
    await expect(service.book(bookingInput(), key)).rejects.toThrow(CalendarProviderError);
    const attempt = await bookingAttempts.findByKey(key);
    expect(attempt?.status).toBe("FAILED");
  });
});
