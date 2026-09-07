import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppointmentService } from "../src/application/services.js";
import { InMemoryAppointmentRepository, InMemoryBookingAttemptRepository, InMemoryLeadRepository, InMemoryAppointmentStatusHistoryRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { SlotUnavailableError, IdempotencyConflictError, CalendarProviderError } from "../src/domain/errors.js";
import type { CalendarProvider, CalendarEventResult } from "../src/application/ports.js";
import { isWithinBusinessHours, type AvailabilityRules } from "../src/domain/availability.js";

/**
 * Fase 7F -- wraps FakeCalendarProvider for free/busy (never a real business-hours concept, see
 * that class's own doc comment) but implements isWithinBusinessHours using the REAL domain
 * function with real weekly rules -- proves AppointmentService.completeBooking actually calls and
 * respects this check for a "direct" booking (an exact start/end, never routed through
 * getAvailableSlots' own output), not just that the port method exists.
 */
function makeRulesEnforcingCalendar(rules: AvailabilityRules): CalendarProvider {
  const inner = new FakeCalendarProvider();
  return {
    getAvailableSlots: (...args) => inner.getAvailableSlots(...args),
    isSlotAvailable: (...args) => inner.isSlotAvailable(...args),
    isWithinBusinessHours: (start, end) => isWithinBusinessHours(start, end, rules),
    createEvent: (...args) => inner.createEvent(...args),
    deleteEvent: (...args) => inner.deleteEvent(...args),
  };
}
const REAL_WEEKLY_RULES: AvailabilityRules = {
  timezone: "America/Mexico_City",
  workdayStart: "09:00",
  workdayEnd: "19:00",
  saturdayWorkdayEnd: "14:00",
  sundayBookingEnabled: false,
  minNoticeHours: 2,
  maxDaysAhead: 14,
  maxSlots: 3,
};

function makeService() {
  const calendar = new FakeCalendarProvider();
  const appointments = new InMemoryAppointmentRepository();
  const bookingAttempts = new InMemoryBookingAttemptRepository();
  // Deliberately never populated with `leadId` below -- this fixture exercises the
  // lead.bookedAt-write-fails-but-booking-still-succeeds path on every test in this file.
  const leads = new InMemoryLeadRepository();
  const logger = new FakeLogger();
  const service = new AppointmentService(calendar, appointments, bookingAttempts, leads, logger, new InMemoryAppointmentStatusHistoryRepository());
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
      isWithinBusinessHours() {
        return true;
      },
      async createEvent(): Promise<CalendarEventResult> {
        throw new CalendarProviderError("Google is down");
      },
      async deleteEvent() {},
    };
    const leads = new InMemoryLeadRepository();
    const service = new AppointmentService(failingCalendar, appointments, bookingAttempts, leads, new FakeLogger(), new InMemoryAppointmentStatusHistoryRepository());
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

describe("InMemoryAppointmentRepository.findActiveByLeadId", () => {
  it("A: a lead with no BOOKED appointment -> null", async () => {
    const repo = new InMemoryAppointmentRepository();
    expect(await repo.findActiveByLeadId("lead-none")).toBeNull();
  });

  it("B: a lead with a BOOKED appointment -> returns it", async () => {
    const repo = new InMemoryAppointmentRepository();
    const appt = await repo.create({
      leadId: "lead-a", status: "BOOKED",
      startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"),
      timezone: "America/Mexico_City",
    });
    const found = await repo.findActiveByLeadId("lead-a");
    expect(found?.id).toBe(appt.id);
  });

  it("C: a lead with multiple appointments -> returns the most recently created BOOKED one", async () => {
    const repo = new InMemoryAppointmentRepository();
    const older = await repo.create({
      leadId: "lead-a", status: "BOOKED",
      startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"),
      timezone: "America/Mexico_City",
    });
    await repo.update(older.id, { status: "CANCELLED" });
    const newer = await repo.create({
      leadId: "lead-a", status: "BOOKED",
      startsAt: new Date("2026-03-03T15:00:00.000Z"), endsAt: new Date("2026-03-03T15:30:00.000Z"),
      timezone: "America/Mexico_City",
    });
    const found = await repo.findActiveByLeadId("lead-a");
    expect(found?.id).toBe(newer.id);
  });

  it("D: a lead with only non-BOOKED appointments -> null", async () => {
    const repo = new InMemoryAppointmentRepository();
    const appt = await repo.create({
      leadId: "lead-a", status: "BOOKED",
      startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"),
      timezone: "America/Mexico_City",
    });
    await repo.update(appt.id, { status: "CANCELLED" });
    expect(await repo.findActiveByLeadId("lead-a")).toBeNull();
  });
});

describe("AppointmentService.book -- meeting_at sync", () => {
  it("sets both bookedAt and meetingAt (= appointment.startsAt) on a fresh successful booking", async () => {
    const { service, leads } = makeService();
    const lead = await leads.create({
      country: "MX", productVertical: "PATRIMONIAL", status: "BOOKING_PENDING",
      score: 80, assignedAdvisor: "Hector Herrera", consentContact: true,
    });
    const start = new Date("2026-03-02T15:00:00.000Z");
    const end = new Date("2026-03-02T15:30:00.000Z");

    const appointment = await service.book(
      { leadId: lead.id, title: "Cita PPR", description: "Reunion inicial", start, end, attendeeEmail: "lead@example.com", timezone: "America/Mexico_City" },
      randomUUID(),
    );

    const reloaded = await leads.findById(lead.id);
    expect(reloaded?.bookedAt).toBeInstanceOf(Date);
    expect(reloaded?.meetingAt).toEqual(appointment.startsAt);
    expect(reloaded?.meetingAt).toEqual(start);
  });

  it("an idempotent retry (same idempotency key) returns the existing appointment without re-writing bookedAt/meetingAt", async () => {
    const { service, leads } = makeService();
    const lead = await leads.create({
      country: "MX", productVertical: "PATRIMONIAL", status: "BOOKING_PENDING",
      score: 80, assignedAdvisor: "Hector Herrera", consentContact: true,
    });
    const key = randomUUID();
    const input = {
      leadId: lead.id, title: "Cita PPR", description: "Reunion inicial",
      start: new Date("2026-03-02T15:00:00.000Z"), end: new Date("2026-03-02T15:30:00.000Z"),
      attendeeEmail: "lead@example.com", timezone: "America/Mexico_City",
    };

    const first = await service.book(input, key);
    // Deliberately corrupt meetingAt after the first booking: if a retry ever re-touched this
    // field, this corrupted value would get silently overwritten back to something plausible,
    // hiding a real bug. Leaving it corrupted after the retry is exactly what proves the retry
    // never wrote anything.
    const sentinel = new Date("1999-01-01T00:00:00.000Z");
    await leads.update(lead.id, { meetingAt: sentinel });

    const second = await service.book(input, key);

    expect(second.id).toBe(first.id); // same appointment, not a duplicate
    const afterRetry = await leads.findById(lead.id);
    expect(afterRetry?.meetingAt).toEqual(sentinel); // untouched -- claimExistingAttempt never re-enters completeBooking
  });
});

// ---------------------------------------------------------------------------------------------
// Fase 7F items 17/18 -- "booking directo" (an exact start/end passed straight to
// AppointmentService.book, never picked from getAvailableSlots' own output -- e.g. a raw
// POST /api/appointments call) must be rejected the same way an out-of-hours slot is already
// absent from getAvailableSlots. Uses makeRulesEnforcingCalendar (real domain rules), never
// FakeCalendarProvider alone -- that fake is deliberately permissive (see its own doc comment) and
// would never catch a regression here.
// ---------------------------------------------------------------------------------------------
describe("AppointmentService.book -- Fase 7F direct-booking business-hours protection", () => {
  it("item 17: a direct booking on Sunday is rejected, even though the calendar itself is free", async () => {
    const calendar = makeRulesEnforcingCalendar(REAL_WEEKLY_RULES);
    const appointments = new InMemoryAppointmentRepository();
    const bookingAttempts = new InMemoryBookingAttemptRepository();
    const leads = new InMemoryLeadRepository();
    const service = new AppointmentService(calendar, appointments, bookingAttempts, leads, new FakeLogger(), new InMemoryAppointmentStatusHistoryRepository());
    // 2026-03-08 is a Sunday (see tests/availability.test.ts's own reference week).
    const input = bookingInput({ start: new Date("2026-03-08T18:00:00.000Z"), end: new Date("2026-03-08T18:30:00.000Z") });

    await expect(service.book(input, randomUUID())).rejects.toThrow(SlotUnavailableError);
  });

  it("item 18: a direct booking on Saturday ending after 14:00 is rejected", async () => {
    const calendar = makeRulesEnforcingCalendar(REAL_WEEKLY_RULES);
    const appointments = new InMemoryAppointmentRepository();
    const bookingAttempts = new InMemoryBookingAttemptRepository();
    const leads = new InMemoryLeadRepository();
    const service = new AppointmentService(calendar, appointments, bookingAttempts, leads, new FakeLogger(), new InMemoryAppointmentStatusHistoryRepository());
    // 2026-03-07 is a Saturday; 20:00-20:30 UTC == 14:00-14:30 America/Mexico_City.
    const input = bookingInput({ start: new Date("2026-03-07T20:00:00.000Z"), end: new Date("2026-03-07T20:30:00.000Z") });

    await expect(service.book(input, randomUUID())).rejects.toThrow(SlotUnavailableError);
  });

  it("a direct booking on Saturday ending exactly at 14:00 is accepted (the boundary itself is never over-restricted)", async () => {
    const calendar = makeRulesEnforcingCalendar(REAL_WEEKLY_RULES);
    const appointments = new InMemoryAppointmentRepository();
    const bookingAttempts = new InMemoryBookingAttemptRepository();
    const leads = new InMemoryLeadRepository();
    const service = new AppointmentService(calendar, appointments, bookingAttempts, leads, new FakeLogger(), new InMemoryAppointmentStatusHistoryRepository());
    // 19:30-20:00 UTC == 13:30-14:00 America/Mexico_City.
    const input = bookingInput({ start: new Date("2026-03-07T19:30:00.000Z"), end: new Date("2026-03-07T20:00:00.000Z") });

    const appt = await service.book(input, randomUUID());
    expect(appt.status).toBe("BOOKED");
  });

  it("the booking_attempts row is marked FAILED, never left PENDING, when rejected for being outside business hours", async () => {
    const calendar = makeRulesEnforcingCalendar(REAL_WEEKLY_RULES);
    const appointments = new InMemoryAppointmentRepository();
    const bookingAttempts = new InMemoryBookingAttemptRepository();
    const leads = new InMemoryLeadRepository();
    const service = new AppointmentService(calendar, appointments, bookingAttempts, leads, new FakeLogger(), new InMemoryAppointmentStatusHistoryRepository());
    const input = bookingInput({ start: new Date("2026-03-08T18:00:00.000Z"), end: new Date("2026-03-08T18:30:00.000Z") });
    const key = randomUUID();

    await expect(service.book(input, key)).rejects.toThrow(SlotUnavailableError);

    const attempt = await bookingAttempts.findByKey(key);
    expect(attempt?.status).toBe("FAILED");
  });

  it("a direct booking within normal weekday hours is completely unaffected by the new check", async () => {
    const calendar = makeRulesEnforcingCalendar(REAL_WEEKLY_RULES);
    const appointments = new InMemoryAppointmentRepository();
    const bookingAttempts = new InMemoryBookingAttemptRepository();
    const leads = new InMemoryLeadRepository();
    const service = new AppointmentService(calendar, appointments, bookingAttempts, leads, new FakeLogger(), new InMemoryAppointmentStatusHistoryRepository());
    const appt = await service.book(bookingInput(), randomUUID()); // Monday 09:00, the file's own default

    expect(appt.status).toBe("BOOKED");
  });
});
