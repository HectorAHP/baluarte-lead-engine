import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppointmentService } from "../src/application/services.js";
import { InMemoryAppointmentRepository, InMemoryBookingAttemptRepository, InMemoryLeadRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { SlotUnavailableError, IdempotencyConflictError, CalendarProviderError } from "../src/domain/errors.js";
import type { CalendarProvider, CalendarEventResult } from "../src/application/ports.js";

function makeService() {
  const calendar = new FakeCalendarProvider();
  const appointments = new InMemoryAppointmentRepository();
  const bookingAttempts = new InMemoryBookingAttemptRepository();
  // Deliberately never populated with `leadId` below -- this fixture exercises the
  // lead.bookedAt-write-fails-but-booking-still-succeeds path on every test in this file.
  const leads = new InMemoryLeadRepository();
  const logger = new FakeLogger();
  const service = new AppointmentService(calendar, appointments, bookingAttempts, leads, logger);
  return { service, calendar, appointments, bookingAttempts, leads, logger };
}

const leadId = "11111111-1111-1111-1111-111111111111";
function bookingInput(overrides: Partial<{ title: string; start: Date; end: Date }> = {}) {
  return {
    leadId,
    title: overrides.title ?? "Cita PPR",
    description: "Reunion inicial",
    start: overrides.start ?? new Date("2026-03-02T15:00:00.000Z"),
    end: overrides.end ?? new Date("2026-03-02T15:30:00.000Z"),
    attendeeEmail: "lead@example.com",
    timezone: "America/Mexico_City",
  };
}

describe("AppointmentService.book idempotency", () => {
  it("same Idempotency-Key + same payload returns the same appointment, without creating a duplicate event", async () => {
    const { service } = makeService();
    const key = randomUUID();
    const first = await service.book(bookingInput(), key);
    const second = await service.book(bookingInput(), key);
    expect(second.id).toBe(first.id);
    expect(second.calendarEventId).toBe(first.calendarEventId);
  });

  it("same Idempotency-Key + different payload is rejected with IdempotencyConflictError", async () => {
    const { service } = makeService();
    const key = randomUUID();
    await service.book(bookingInput(), key);
    await expect(service.book(bookingInput({ title: "Otro titulo" }), key)).rejects.toThrow(IdempotencyConflictError);
  });

  it("still succeeds and returns a valid appointment when updating lead.bookedAt fails, but the failure is observable through the logger rather than silently swallowed", async () => {
    const { service, logger } = makeService();
    const key = randomUUID();
    const appointment = await service.book(bookingInput(), key);
    expect(appointment.status).toBe("BOOKED");

    expect(logger.warnings).toHaveLength(1);
    const [warning] = logger.warnings;
    expect(warning.details.leadId).toBe(leadId);
    expect(warning.details.appointmentId).toBe(appointment.id);
    expect(warning.message).toContain("booked_at");
    // Sanitized: only leadId/appointmentId/reason -- no secrets or provider payloads.
    expect(Object.keys(warning.details).sort()).toEqual(["appointmentId", "leadId", "reason"]);
  });

  it("a new Idempotency-Key is processed as a normal, independent booking", async () => {
    const { service } = makeService();
    const first = await service.book(bookingInput(), randomUUID());
    const second = await service.book(
      bookingInput({ start: new Date("2026-03-02T16:00:00.000Z"), end: new Date("2026-03-02T16:30:00.000Z") }),
      randomUUID(),
    );
    expect(second.id).not.toBe(first.id);
  });
});

describe("AppointmentService.book slot protection", () => {
  it("revalidates and rejects when the slot is already occupied", async () => {
    const { service } = makeService();
    await service.book(bookingInput(), randomUUID());
    await expect(service.book(bookingInput(), randomUUID())).rejects.toThrow(SlotUnavailableError);
  });

  it("marks the booking attempt FAILED when the slot is occupied", async () => {
    const { service, bookingAttempts } = makeService();
    await service.book(bookingInput(), randomUUID());
    const key = randomUUID();
    await expect(service.book(bookingInput(), key)).rejects.toThrow(SlotUnavailableError);
    const attempt = await bookingAttempts.findByKey(key);
    expect(attempt?.status).toBe("FAILED");
  });

  it("translates a calendar provider failure and marks the attempt FAILED", async () => {
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

describe("InMemoryAppointmentRepository double-booking guard", () => {
  it("rejects a second appointment that overlaps an already-booked one, even for a different lead", async () => {
    const repo = new InMemoryAppointmentRepository();
    await repo.create({
      leadId: "lead-a",
      status: "BOOKED",
      startsAt: new Date("2026-03-02T15:00:00.000Z"),
      endsAt: new Date("2026-03-02T15:30:00.000Z"),
      timezone: "America/Mexico_City",
    });
    await expect(
      repo.create({
        leadId: "lead-b",
        status: "BOOKED",
        startsAt: new Date("2026-03-02T15:15:00.000Z"),
        endsAt: new Date("2026-03-02T15:45:00.000Z"),
        timezone: "America/Mexico_City",
      }),
    ).rejects.toThrow(SlotUnavailableError);
  });

  it("allows a new appointment once the conflicting one is CANCELLED", async () => {
    const repo = new InMemoryAppointmentRepository();
    const first = await repo.create({
      leadId: "lead-a",
      status: "BOOKED",
      startsAt: new Date("2026-03-02T15:00:00.000Z"),
      endsAt: new Date("2026-03-02T15:30:00.000Z"),
      timezone: "America/Mexico_City",
    });
    await repo.update(first.id, { status: "CANCELLED" });
    const second = await repo.create({
      leadId: "lead-b",
      status: "BOOKED",
      startsAt: new Date("2026-03-02T15:00:00.000Z"),
      endsAt: new Date("2026-03-02T15:30:00.000Z"),
      timezone: "America/Mexico_City",
    });
    expect(second.id).toBeTruthy();
  });
});
