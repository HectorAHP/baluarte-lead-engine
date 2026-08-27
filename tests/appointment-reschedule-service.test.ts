import { describe, it, expect, vi } from "vitest";
import { AppointmentRescheduleService } from "../src/application/appointment-reschedule-service.js";
import { AppointmentCancellationService } from "../src/application/appointment-cancellation-service.js";
import {
  InMemoryAppointmentRepository, InMemoryAppointmentRescheduleRepository, InMemoryAppointmentStatusHistoryRepository,
  InMemoryAppointmentCancellationRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import { CalendarProviderError, RescheduleInProgressError } from "../src/domain/errors.js";
import type { CalendarProvider, CalendarEventInput } from "../src/application/ports.js";

class ThrowingDeleteEventCalendar implements CalendarProvider {
  constructor(private readonly inner: CalendarProvider) {}
  getAvailableSlots(...args: Parameters<CalendarProvider["getAvailableSlots"]>) { return this.inner.getAvailableSlots(...args); }
  isSlotAvailable(...args: Parameters<CalendarProvider["isSlotAvailable"]>) { return this.inner.isSlotAvailable(...args); }
  createEvent(...args: Parameters<CalendarProvider["createEvent"]>) { return this.inner.createEvent(...args); }
  async deleteEvent(): Promise<void> {
    throw new CalendarProviderError("Google Calendar is down");
  }
}

class ThrowingCreateEventCalendar implements CalendarProvider {
  constructor(private readonly inner: CalendarProvider) {}
  getAvailableSlots(...args: Parameters<CalendarProvider["getAvailableSlots"]>) { return this.inner.getAvailableSlots(...args); }
  isSlotAvailable(...args: Parameters<CalendarProvider["isSlotAvailable"]>) { return this.inner.isSlotAvailable(...args); }
  async createEvent(_input: CalendarEventInput): Promise<never> {
    throw new CalendarProviderError("Google Calendar is down");
  }
  deleteEvent(...args: Parameters<CalendarProvider["deleteEvent"]>) { return this.inner.deleteEvent(...args); }
}

function makeHarness(overrides: { calendar?: CalendarProvider } = {}) {
  const calendar = overrides.calendar ?? new FakeCalendarProvider();
  const appointments = new InMemoryAppointmentRepository();
  const reschedules = new InMemoryAppointmentRescheduleRepository();
  const appointmentStatusHistory = new InMemoryAppointmentStatusHistoryRepository();
  const cancellations = new InMemoryAppointmentCancellationRepository();
  const logger = new FakeLogger();
  const cancellationService = new AppointmentCancellationService(calendar, appointments, cancellations, appointmentStatusHistory, logger);
  const service = new AppointmentRescheduleService(calendar, appointments, reschedules, appointmentStatusHistory, cancellationService, logger);
  return { calendar, appointments, reschedules, appointmentStatusHistory, cancellations, logger, cancellationService, service };
}

const OLD_BASE = { leadId: "lead-1", startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City" };
const NEW_SLOT = { start: new Date("2026-03-05T16:00:00.000Z"), end: new Date("2026-03-05T16:30:00.000Z") };

function rescheduleParams(overrides: Partial<Parameters<AppointmentRescheduleService["reschedule"]>[0]> & { oldAppointment: Parameters<AppointmentRescheduleService["reschedule"]>[0]["oldAppointment"] }) {
  return {
    leadId: "lead-1",
    offeredSlotId: "slot-1",
    start: NEW_SLOT.start,
    end: NEW_SLOT.end,
    title: "Cita con Héctor Herrera",
    description: "Cita reagendada automáticamente vía WhatsApp (Baluarte Capital).",
    timezone: "America/Mexico_City",
    ...overrides,
  };
}

describe("AppointmentRescheduleService.reschedule -- happy path", () => {
  it("new appointment BOOKED with rescheduledFrom=old.id, old -> RESCHEDULED, exactly one appointment_status_history row, old Calendar event deleted", async () => {
    const { appointments, appointmentStatusHistory, reschedules, service } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });

    const outcome = await service.reschedule(rescheduleParams({ oldAppointment: old }));

    expect(outcome.type).toBe("RESCHEDULED");
    if (outcome.type !== "RESCHEDULED") throw new Error("unreachable");
    expect(outcome.newAppointment.status).toBe("BOOKED");
    expect(outcome.newAppointment.rescheduledFrom).toBe(old.id);
    expect(outcome.oldAppointment.status).toBe("RESCHEDULED");
    expect((await appointments.findById(old.id))?.status).toBe("RESCHEDULED");

    const history = await appointmentStatusHistory.listByAppointmentId(old.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "RESCHEDULED", eventType: "APPOINTMENT_RESCHEDULED" });

    const op = await reschedules.findByIdempotencyKey(`whatsapp-reschedule:lead-1:${old.id}:slot-1`);
    expect(op?.newAppointmentId).toBe(outcome.newAppointment.id);
    expect(op?.status).toBe("COMPLETED");
  });

  it("new appointment with no old Calendar event completes cleanup immediately, no Calendar delete attempted", async () => {
    const { appointments, reschedules, calendar, service } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED" }); // no calendarEventId
    const deleteSpy = vi.spyOn(calendar, "deleteEvent");

    await service.reschedule(rescheduleParams({ oldAppointment: old }));

    expect(deleteSpy).not.toHaveBeenCalled();
    const op = await reschedules.findByIdempotencyKey(`whatsapp-reschedule:lead-1:${old.id}:slot-1`);
    expect(op?.status).toBe("COMPLETED");
  });

  it("old appointment neither BOOKED nor already-completed-by-this-op -- INCONSISTENT, never touches Calendar or appointments", async () => {
    const { appointments, service } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "CANCELLED" });

    const outcome = await service.reschedule(rescheduleParams({ oldAppointment: old }));

    expect(outcome).toEqual({ type: "INCONSISTENT" });
    expect((await appointments.findById(old.id))?.status).toBe("CANCELLED");
  });
});

describe("AppointmentRescheduleService.reschedule -- idempotency", () => {
  it("duplicate selection (same lead+old+slot) is idempotent: exactly one new appointment, one Calendar event, one history row", async () => {
    const { appointments, appointmentStatusHistory, calendar, service } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });
    const createSpy = vi.spyOn(calendar, "createEvent");

    const first = await service.reschedule(rescheduleParams({ oldAppointment: old }));
    if (first.type !== "RESCHEDULED") throw new Error("unreachable");
    const secondOld = (await appointments.findById(old.id))!; // now RESCHEDULED, as a retry would re-fetch
    const second = await service.reschedule(rescheduleParams({ oldAppointment: secondOld }));

    expect(second).toEqual(first);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await appointmentStatusHistory.listByAppointmentId(old.id)).toHaveLength(1);
  });

  it("two callers racing the SAME idempotency key: only one creates a Calendar event/appointment, the other gets RescheduleInProgressError", async () => {
    const { appointments, calendar, service } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });
    const createSpy = vi.spyOn(calendar, "createEvent");

    const results = await Promise.allSettled([
      service.reschedule(rescheduleParams({ oldAppointment: old })),
      service.reschedule(rescheduleParams({ oldAppointment: old })),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RescheduleInProgressError);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("a failed Phase A attempt (Calendar throws) leaves the op row unclaimed forever for that exact idempotency key -- a retry with the SAME key gets RescheduleInProgressError, never a second Calendar attempt (bounded by the offered slot's own TTL/round, not retried here)", async () => {
    const inner = new FakeCalendarProvider();
    const throwing = new ThrowingCreateEventCalendar(inner);
    const { appointments, service } = makeHarness({ calendar: throwing });
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });

    await expect(service.reschedule(rescheduleParams({ oldAppointment: old }))).rejects.toThrow(CalendarProviderError);
    expect((await appointments.findById(old.id))?.status).toBe("BOOKED"); // untouched

    await expect(service.reschedule(rescheduleParams({ oldAppointment: old }))).rejects.toThrow(RescheduleInProgressError);
  });
});

describe("AppointmentRescheduleService.reschedule -- double-booking race (item 7)", () => {
  it("two DIFFERENT concurrent slot selections for the same old appointment converge on ONE winner; the loser's spurious new appointment is rolled back to CANCELLED (via AppointmentCancellationService, reused not reimplemented) with durable cleanup tracking, and never two appointments stay BOOKED", async () => {
    const { appointments, cancellations, service } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });
    const createdIds: string[] = [];
    const createSpy = vi.spyOn(appointments, "create");
    createSpy.mockImplementation(async (input) => {
      const appt = await InMemoryAppointmentRepository.prototype.create.call(appointments, input);
      createdIds.push(appt.id);
      return appt;
    });

    const [r1, r2] = await Promise.all([
      service.reschedule(rescheduleParams({ oldAppointment: old, offeredSlotId: "slot-A", start: new Date("2026-03-05T16:00:00.000Z"), end: new Date("2026-03-05T16:30:00.000Z") })),
      service.reschedule(rescheduleParams({ oldAppointment: old, offeredSlotId: "slot-B", start: new Date("2026-03-06T16:00:00.000Z"), end: new Date("2026-03-06T16:30:00.000Z") })),
    ]);

    expect(r1.type).toBe("RESCHEDULED");
    expect(r2.type).toBe("RESCHEDULED");
    if (r1.type !== "RESCHEDULED" || r2.type !== "RESCHEDULED") throw new Error("unreachable");

    // Both callers converge on the SAME winning appointment -- never two different "successful"
    // new appointments reported to two different callers.
    expect(r1.newAppointment.id).toBe(r2.newAppointment.id);
    expect(createdIds).toHaveLength(2); // both attempts DID create a real appointment...

    const winnerId = r1.newAppointment.id;
    const loserId = createdIds.find((id) => id !== winnerId)!;
    expect(loserId).toBeTruthy();

    // ...but only one stays BOOKED. The loser is durably CANCELLED, not silently orphaned.
    expect((await appointments.findById(winnerId))?.status).toBe("BOOKED");
    expect((await appointments.findById(loserId))?.status).toBe("CANCELLED");
    const statuses = await Promise.all([old.id, winnerId, loserId].map((id) => appointments.findById(id)));
    expect(statuses.filter((a) => a?.status === "BOOKED")).toHaveLength(1);

    // The rollback reused AppointmentCancellationService's own durable Calendar-cleanup tracking
    // -- not a bespoke reimplementation.
    const cleanupOp = await cancellations.findByIdempotencyKey(`whatsapp-cancel:lead-1:${loserId}`);
    expect(cleanupOp?.status).toBe("COMPLETED");
  });
});

describe("AppointmentRescheduleService.reschedule -- old-Calendar cleanup durability (Phase B)", () => {
  it("old Calendar delete fails (5xx/transient) -- old stays RESCHEDULED, reschedule-op stays PENDING with an attempt recorded, never reverted", async () => {
    const inner = new FakeCalendarProvider();
    const throwing = new ThrowingDeleteEventCalendar(inner);
    const { appointments, reschedules, service, logger } = makeHarness({ calendar: throwing });
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });

    const outcome = await service.reschedule(rescheduleParams({ oldAppointment: old }));

    expect(outcome.type).toBe("RESCHEDULED"); // the DB side is still a success -- Calendar cleanup is a separate concern
    expect((await appointments.findById(old.id))?.status).toBe("RESCHEDULED"); // never reverted to BOOKED
    const op = await reschedules.findByIdempotencyKey(`whatsapp-reschedule:lead-1:${old.id}:slot-1`);
    expect(op?.status).toBe("PENDING");
    expect(op?.attemptCount).toBe(1);
    expect(op?.errorCode).toBe("CALENDAR_PROVIDER_ERROR");
    expect(logger.warnings.length).toBeGreaterThan(0);
  });

  it("old Calendar delete succeeds (2xx-equivalent) -- cleanup marked COMPLETED", async () => {
    const { appointments, reschedules, service } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });

    await service.reschedule(rescheduleParams({ oldAppointment: old }));

    const op = await reschedules.findByIdempotencyKey(`whatsapp-reschedule:lead-1:${old.id}:slot-1`);
    expect(op?.status).toBe("COMPLETED");
    expect(op?.completedAt).toBeInstanceOf(Date);
    expect(op?.attemptCount).toBe(1);
  });

  it("a 404/410 on old Calendar delete is treated as success (via GoogleCalendarProvider's idempotent deleteEvent, exercised through FakeCalendarProvider deleting an already-gone event without throwing)", async () => {
    const { appointments, calendar, reschedules, service } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });
    await calendar.deleteEvent("evt-old-1"); // pre-delete: FakeCalendarProvider's deleteEvent never throws for an unknown id, mirroring 404/410

    const outcome = await service.reschedule(rescheduleParams({ oldAppointment: old }));

    expect(outcome.type).toBe("RESCHEDULED");
    const op = await reschedules.findByIdempotencyKey(`whatsapp-reschedule:lead-1:${old.id}:slot-1`);
    expect(op?.status).toBe("COMPLETED");
  });

  it("ensureOldCleanup never throws even when the reschedules repository itself fails on the Phase B (cleanup) write -- the RESCHEDULED outcome is still returned", async () => {
    const { appointments, reschedules, service, logger } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });
    const originalUpdate = reschedules.update.bind(reschedules);
    vi.spyOn(reschedules, "update")
      .mockImplementationOnce(originalUpdate) // Phase A: the newAppointmentId write succeeds
      .mockRejectedValue(new Error("SUPABASE_DOWN")); // Phase B: every cleanup write fails

    const outcome = await service.reschedule(rescheduleParams({ oldAppointment: old }));

    expect(outcome.type).toBe("RESCHEDULED");
    expect((await appointments.findById(old.id))?.status).toBe("RESCHEDULED"); // real transition unaffected
    expect(logger.warnings.length).toBeGreaterThan(0);
  });
});
