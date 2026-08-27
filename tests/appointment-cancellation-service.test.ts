import { describe, it, expect, vi } from "vitest";
import { AppointmentCancellationService } from "../src/application/appointment-cancellation-service.js";
import { InMemoryAppointmentRepository, InMemoryAppointmentCancellationRepository, InMemoryAppointmentStatusHistoryRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { CalendarProviderError } from "../src/domain/errors.js";
import type { CalendarProvider } from "../src/application/ports.js";

/** Wraps a real FakeCalendarProvider but forces deleteEvent to throw a transient/5xx-style
 * CalendarProviderError -- mirrors the ThrowingCreateEventCalendar pattern already established in
 * whatsapp-booking-handler.test.ts, applied to deleteEvent instead. */
class ThrowingDeleteEventCalendar implements CalendarProvider {
  deleteEventCalls = 0;
  constructor(private readonly inner: CalendarProvider) {}
  getAvailableSlots(...args: Parameters<CalendarProvider["getAvailableSlots"]>) { return this.inner.getAvailableSlots(...args); }
  isSlotAvailable(...args: Parameters<CalendarProvider["isSlotAvailable"]>) { return this.inner.isSlotAvailable(...args); }
  createEvent(...args: Parameters<CalendarProvider["createEvent"]>) { return this.inner.createEvent(...args); }
  async deleteEvent(): Promise<void> {
    this.deleteEventCalls++;
    throw new CalendarProviderError("Google Calendar is down");
  }
}

function makeHarness(overrides: { calendar?: CalendarProvider } = {}) {
  const calendar = overrides.calendar ?? new FakeCalendarProvider();
  const appointments = new InMemoryAppointmentRepository();
  const cancellations = new InMemoryAppointmentCancellationRepository();
  const appointmentStatusHistory = new InMemoryAppointmentStatusHistoryRepository();
  const logger = new FakeLogger();
  const service = new AppointmentCancellationService(calendar, appointments, cancellations, appointmentStatusHistory, logger);
  return { calendar, appointments, cancellations, appointmentStatusHistory, logger, service };
}

const BASE = { leadId: "lead-1", startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City" };

describe("AppointmentCancellationService.cancel", () => {
  it("BOOKED -> CANCELLED via CAS, exactly one appointment_status_history row, Calendar delete succeeds", async () => {
    const { appointments, appointmentStatusHistory, service } = makeHarness();
    const appt = await appointments.create({ ...BASE, status: "BOOKED", calendarEventId: "evt-1" });

    const outcome = await service.cancel(appt, "lead-1");

    expect(outcome).toEqual({ type: "CANCELLED", appointment: { ...appt, status: "CANCELLED" } });
    expect((await appointments.findById(appt.id))?.status).toBe("CANCELLED");
    const history = await appointmentStatusHistory.listByAppointmentId(appt.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "CANCELLED", eventType: "APPOINTMENT_CANCELLED" });
  });

  it("appointment with no calendarEventId completes cleanup immediately, no Calendar call attempted", async () => {
    const { appointments, cancellations, service } = makeHarness();
    const appt = await appointments.create({ ...BASE, status: "BOOKED" }); // no calendarEventId

    await service.cancel(appt, "lead-1");

    const op = await cancellations.findByIdempotencyKey(`whatsapp-cancel:lead-1:${appt.id}`);
    expect(op?.status).toBe("COMPLETED");
  });

  it("neither BOOKED nor CANCELLED -- returns INCONSISTENT, never touches the appointment", async () => {
    const { appointments, appointmentStatusHistory, service } = makeHarness();
    const appt = await appointments.create({ ...BASE, status: "PENDING" });

    const outcome = await service.cancel(appt, "lead-1");

    expect(outcome).toEqual({ type: "INCONSISTENT" });
    expect((await appointments.findById(appt.id))?.status).toBe("PENDING");
    expect(await appointmentStatusHistory.listByAppointmentId(appt.id)).toEqual([]);
  });

  it("concurrent cancel: two callers racing the same appointment -- only one owner writes history, both resolve CANCELLED", async () => {
    const { appointments, appointmentStatusHistory, service } = makeHarness();
    const appt = await appointments.create({ ...BASE, status: "BOOKED", calendarEventId: "evt-1" });

    const [r1, r2] = await Promise.all([service.cancel(appt, "lead-1"), service.cancel(appt, "lead-1")]);

    expect(r1.type).toBe("CANCELLED");
    expect(r2.type).toBe("CANCELLED");
    expect((await appointments.findById(appt.id))?.status).toBe("CANCELLED");
    // Exactly ONE history row for the real transition -- the loser found it already CANCELLED and
    // never re-ran the CAS or wrote a second row.
    expect(await appointmentStatusHistory.listByAppointmentId(appt.id)).toHaveLength(1);
  });

  it("idempotent retry (appointment already CANCELLED) never writes a second history row and never re-attempts a completed Calendar cleanup", async () => {
    const { appointments, cancellations, appointmentStatusHistory, calendar, service } = makeHarness();
    const appt = await appointments.create({ ...BASE, status: "BOOKED", calendarEventId: "evt-1" });
    await service.cancel(appt, "lead-1");
    const deleteSpy = vi.spyOn(calendar, "deleteEvent");

    const cancelledAppt = (await appointments.findById(appt.id))!;
    const second = await service.cancel(cancelledAppt, "lead-1");

    expect(second.type).toBe("CANCELLED");
    expect(await appointmentStatusHistory.listByAppointmentId(appt.id)).toHaveLength(1);
    expect(deleteSpy).not.toHaveBeenCalled(); // already COMPLETED -- ensureCleanup short-circuits
    expect((await cancellations.findByIdempotencyKey(`whatsapp-cancel:lead-1:${appt.id}`))?.status).toBe("COMPLETED");
  });

  it("Calendar delete succeeds (2xx-equivalent) -- cleanup marked COMPLETED", async () => {
    const { cancellations, appointments, service } = makeHarness();
    const appt = await appointments.create({ ...BASE, status: "BOOKED", calendarEventId: "evt-1" });

    await service.cancel(appt, "lead-1");

    const op = await cancellations.findByIdempotencyKey(`whatsapp-cancel:lead-1:${appt.id}`);
    expect(op?.status).toBe("COMPLETED");
    expect(op?.completedAt).toBeInstanceOf(Date);
    expect(op?.attemptCount).toBe(1);
  });

  it("Calendar delete fails (transient/5xx) -- appointment stays CANCELLED, cleanup marked PENDING with an attempt recorded, never reverted", async () => {
    const inner = new FakeCalendarProvider();
    const throwing = new ThrowingDeleteEventCalendar(inner);
    const { appointments, cancellations, service, logger } = makeHarness({ calendar: throwing });
    const appt = await appointments.create({ ...BASE, status: "BOOKED", calendarEventId: "evt-1" });

    const outcome = await service.cancel(appt, "lead-1");

    expect(outcome.type).toBe("CANCELLED"); // the DB side is still a success -- Calendar cleanup is a separate concern
    expect((await appointments.findById(appt.id))?.status).toBe("CANCELLED"); // never reverted to BOOKED
    const op = await cancellations.findByIdempotencyKey(`whatsapp-cancel:lead-1:${appt.id}`);
    expect(op?.status).toBe("PENDING");
    expect(op?.attemptCount).toBe(1);
    expect(op?.errorCode).toBe("CALENDAR_PROVIDER_ERROR");
    expect(logger.warnings.length).toBeGreaterThan(0);
  });

  it("retry cleanup: a later cancel() call for the same (now-CANCELLED) appointment retries the pending Calendar delete safely", async () => {
    const inner = new FakeCalendarProvider();
    const throwing = new ThrowingDeleteEventCalendar(inner);
    const { appointments, cancellations, service } = makeHarness({ calendar: throwing });
    const appt = await appointments.create({ ...BASE, status: "BOOKED", calendarEventId: "evt-1" });
    await service.cancel(appt, "lead-1"); // first attempt fails, cleanup left PENDING
    expect((await cancellations.findByIdempotencyKey(`whatsapp-cancel:lead-1:${appt.id}`))?.status).toBe("PENDING");

    // Simulate the reconciliation retry: same appointment (now CANCELLED), a working calendar this time.
    const cancelledAppt = (await appointments.findById(appt.id))!;
    const { service: recoveredService, cancellations: sameCancellations } = (() => {
      // Reuse the SAME cancellations store by constructing a second service against it, with a
      // working calendar -- mirrors a real reconciliation job retrying with the real provider.
      return { service: new AppointmentCancellationService(inner, appointments, cancellations, new InMemoryAppointmentStatusHistoryRepository(), new FakeLogger()), cancellations };
    })();
    const retryOutcome = await recoveredService.cancel(cancelledAppt, "lead-1");

    expect(retryOutcome.type).toBe("CANCELLED");
    const op = await sameCancellations.findByIdempotencyKey(`whatsapp-cancel:lead-1:${appt.id}`);
    expect(op?.status).toBe("COMPLETED");
    expect(op?.attemptCount).toBe(2); // first (failed) attempt + this successful retry
  });

  it("ensureCleanup never throws even when the cancellations repository itself fails -- the CANCELLED outcome is still returned", async () => {
    const { appointments, cancellations, service, logger } = makeHarness();
    vi.spyOn(cancellations, "tryCreate").mockRejectedValue(new Error("SUPABASE_DOWN"));
    vi.spyOn(cancellations, "findByIdempotencyKey").mockRejectedValue(new Error("SUPABASE_DOWN"));
    const appt = await appointments.create({ ...BASE, status: "BOOKED", calendarEventId: "evt-1" });

    const outcome = await service.cancel(appt, "lead-1");

    expect(outcome.type).toBe("CANCELLED");
    expect((await appointments.findById(appt.id))?.status).toBe("CANCELLED"); // real cancellation unaffected
    expect(logger.warnings.length).toBeGreaterThan(0);
  });
});
