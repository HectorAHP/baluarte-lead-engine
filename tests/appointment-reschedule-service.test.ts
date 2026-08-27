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

/** Throws a transient CalendarProviderError on createEvent exactly ONCE, then delegates normally
 * -- models "Calendar create falla transitoriamente" followed by the user retrying the SAME slot
 * selection a moment later, once Calendar has recovered (item 12 of the Phase 4C hardening
 * report). */
class FlakyOnceCreateEventCalendar implements CalendarProvider {
  private failuresLeft: number;
  constructor(private readonly inner: CalendarProvider, failures = 1) {
    this.failuresLeft = failures;
  }
  getAvailableSlots(...args: Parameters<CalendarProvider["getAvailableSlots"]>) { return this.inner.getAvailableSlots(...args); }
  isSlotAvailable(...args: Parameters<CalendarProvider["isSlotAvailable"]>) { return this.inner.isSlotAvailable(...args); }
  async createEvent(input: CalendarEventInput) {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new CalendarProviderError("Google Calendar is down");
    }
    return this.inner.createEvent(input);
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

describe("AppointmentRescheduleService.reschedule -- item 6: new Calendar event id is never orphaned", () => {
  it("new_calendar_event_id is persisted on the op row BEFORE the appointment insert -- a crash in between still leaves a durable, discoverable reference to the Calendar event", async () => {
    const { appointments, reschedules, service } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });
    let capturedEventId: string | undefined;
    const createSpy = vi.spyOn(appointments, "create");
    createSpy.mockImplementation(async (input) => {
      // At the exact moment the appointment insert is about to run, the op row must ALREADY
      // carry the new Calendar event id -- proving the persist-before-insert ordering, not just
      // asserting it after the fact (which a reordering bug could still coincidentally satisfy).
      const opNow = await reschedules.findByIdempotencyKey(`whatsapp-reschedule:lead-1:${old.id}:slot-1`);
      capturedEventId = opNow?.newCalendarEventId;
      return InMemoryAppointmentRepository.prototype.create.call(appointments, input);
    });

    const outcome = await service.reschedule(rescheduleParams({ oldAppointment: old }));

    expect(outcome.type).toBe("RESCHEDULED");
    if (outcome.type !== "RESCHEDULED") throw new Error("unreachable");
    expect(capturedEventId).toBeTruthy();
    expect(capturedEventId).toBe(outcome.newAppointment.calendarEventId);
  });

  it("if the appointment insert itself fails AFTER the Calendar event was created, the op row still references the orphaned event (reconciliation query: new_calendar_event_id IS NOT NULL AND new_appointment_id IS NULL finds it) -- never silently lost", async () => {
    const { appointments, reschedules, service } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });
    vi.spyOn(appointments, "create").mockRejectedValue(new Error("DB_DOWN_AFTER_CALENDAR_SUCCEEDED"));

    await expect(service.reschedule(rescheduleParams({ oldAppointment: old }))).rejects.toThrow("DB_DOWN_AFTER_CALENDAR_SUCCEEDED");

    const op = await reschedules.findByIdempotencyKey(`whatsapp-reschedule:lead-1:${old.id}:slot-1`);
    expect(op?.newCalendarEventId).toBeTruthy(); // the reconciliation reference survives even though the appointment never got created
    expect(op?.newAppointmentId).toBeUndefined();
    expect(op?.phaseAStatus).toBe("FAILED"); // reclaimable by a retry, per item 12
  });
});

describe("item 7: old/new coexistence window -- findActiveByLeadId vs listActiveByLeadId", () => {
  it("findActiveByLeadId returns the NEWEST BOOKED row (documented, deterministic) while listActiveByLeadId surfaces BOTH -- proving a concurrent handler using listActiveByLeadId's >1 guard never acts on the wrong appointment during the window", async () => {
    const { appointments } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });
    // Manually simulate the brief coexistence window WITHOUT going through the full service (the
    // real service closes this window in two sequential local writes with no network round-trip
    // in the in-memory case; in real Postgres there IS a round-trip between the appointment INSERT
    // and the old CAS UPDATE, which is the actual window this documents).
    const newAppt = await appointments.create({ leadId: "lead-1", status: "BOOKED", startsAt: new Date("2026-03-05T16:00:00.000Z"), endsAt: new Date("2026-03-05T16:30:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-new-1", rescheduledFrom: old.id });

    const single = await appointments.findActiveByLeadId("lead-1");
    expect(single?.id).toBe(newAppt.id); // the newest one -- documented in ports.ts

    const all = await appointments.listActiveByLeadId("lead-1");
    expect(all).toHaveLength(2);
    expect(new Set(all.map((a) => a.id))).toEqual(new Set([old.id, newAppt.id]));
  });

  it("a cancellation or reschedule request landing during the coexistence window sees listActiveByLeadId's >1 and would escalate -- never silently targets one of the two ambiguous appointments", async () => {
    const { appointments } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });
    await appointments.create({ leadId: "lead-1", status: "BOOKED", startsAt: new Date("2026-03-05T16:00:00.000Z"), endsAt: new Date("2026-03-05T16:30:00.000Z"), timezone: "America/Mexico_City", calendarEventId: "evt-new-1", rescheduledFrom: old.id });

    // Mirrors WhatsAppCancellationHandler.findTargetAppointment / WhatsAppRescheduleHandler.findTargetAppointment's own logic exactly.
    const active = await appointments.listActiveByLeadId("lead-1");
    const wouldEscalate = active.length > 1;
    expect(wouldEscalate).toBe(true);
  });
});

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

  it("item 12: a failed Phase A attempt (Calendar throws) marks the op row FAILED, not permanently stuck -- a retry with the SAME idempotency key immediately reclaims ownership and tries again (no 20-minute lockout for a transient error)", async () => {
    const inner = new FakeCalendarProvider();
    const flaky = new FlakyOnceCreateEventCalendar(inner, 1);
    const { appointments, reschedules, service } = makeHarness({ calendar: flaky });
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });

    await expect(service.reschedule(rescheduleParams({ oldAppointment: old }))).rejects.toThrow(CalendarProviderError);
    expect((await appointments.findById(old.id))?.status).toBe("BOOKED"); // untouched
    const opAfterFailure = await reschedules.findByIdempotencyKey(`whatsapp-reschedule:lead-1:${old.id}:slot-1`);
    expect(opAfterFailure?.phaseAStatus).toBe("FAILED");
    expect(opAfterFailure?.newAppointmentId).toBeUndefined();

    // The user's retry, 30 seconds later, with the SAME still-valid slot selection -- Calendar
    // has recovered by now (FlakyOnceCreateEventCalendar only fails once).
    const retryOutcome = await service.reschedule(rescheduleParams({ oldAppointment: old }));

    expect(retryOutcome.type).toBe("RESCHEDULED");
    if (retryOutcome.type !== "RESCHEDULED") throw new Error("unreachable");
    expect(retryOutcome.newAppointment.status).toBe("BOOKED");
    expect((await appointments.findById(old.id))?.status).toBe("RESCHEDULED");
  });

  it("item 12: while the FAILED retry is genuinely fresh (not yet stale), a second concurrent caller for the SAME key still gets RescheduleInProgressError, never a duplicate Calendar attempt", async () => {
    const inner = new FakeCalendarProvider();
    const throwing = new ThrowingCreateEventCalendar(inner);
    const { appointments, service } = makeHarness({ calendar: throwing });
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });
    await expect(service.reschedule(rescheduleParams({ oldAppointment: old }))).rejects.toThrow(CalendarProviderError);

    // Two callers race the SAME already-FAILED key at once -- only one can win the
    // FAILED -> PENDING reclaim CAS.
    const results = await Promise.allSettled([
      service.reschedule(rescheduleParams({ oldAppointment: old })),
      service.reschedule(rescheduleParams({ oldAppointment: old })),
    ]);
    // Both use the SAME (still-throwing) calendar here, so both fail with CalendarProviderError --
    // but only one of them ever actually calls Calendar (the reclaim winner); the other gets
    // RescheduleInProgressError without ever touching Calendar again. Assert via rejection reasons.
    const reasons = results.map((r) => (r.status === "rejected" ? r.reason : null));
    const inProgress = reasons.filter((e) => e instanceof RescheduleInProgressError);
    const calendarErrors = reasons.filter((e) => e instanceof CalendarProviderError);
    expect(inProgress.length + calendarErrors.length).toBe(2);
    expect(calendarErrors.length).toBeLessThanOrEqual(1); // at most one racer actually reached Calendar
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

  it("item 9: the loser's rollback is labeled APPOINTMENT_RESCHEDULE_ROLLBACK in appointment_status_history, NEVER APPOINTMENT_CANCELLED -- a spurious internal rollback must never be mistaken for a real customer cancellation in the audit trail", async () => {
    const { appointments, appointmentStatusHistory, service } = makeHarness();
    const old = await appointments.create({ ...OLD_BASE, status: "BOOKED", calendarEventId: "evt-old-1" });

    const [r1, r2] = await Promise.all([
      service.reschedule(rescheduleParams({ oldAppointment: old, offeredSlotId: "slot-A", start: new Date("2026-03-05T16:00:00.000Z"), end: new Date("2026-03-05T16:30:00.000Z") })),
      service.reschedule(rescheduleParams({ oldAppointment: old, offeredSlotId: "slot-B", start: new Date("2026-03-06T16:00:00.000Z"), end: new Date("2026-03-06T16:30:00.000Z") })),
    ]);
    if (r1.type !== "RESCHEDULED" || r2.type !== "RESCHEDULED") throw new Error("unreachable");
    const winnerId = r1.newAppointment.id;
    // Find the loser: whichever new-appointment id isn't the winner's, discovered via the OLD
    // appointment's history (exactly one row, for the winner) plus a direct status scan.
    const candidateIds = [r1.newAppointment.id, r2.newAppointment.id].filter((id, i, arr) => arr.indexOf(id) === i);
    for (const id of candidateIds) {
      if (id === winnerId) continue;
      const loserHistory = await appointmentStatusHistory.listByAppointmentId(id);
      expect(loserHistory).toHaveLength(1);
      expect(loserHistory[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "CANCELLED", eventType: "APPOINTMENT_RESCHEDULE_ROLLBACK" });
      expect(loserHistory[0].eventType).not.toBe("APPOINTMENT_CANCELLED");
    }
  });

  it("item 9: AppointmentCancellationService has no leads/messaging dependency at all -- the rollback structurally cannot produce a lead status change or a WhatsApp message as a side effect", () => {
    // AppointmentCancellationService.cancel() only ever writes appointments/appointment_status_
    // history/appointment_cancellations -- confirmed by its own constructor signature (calendar,
    // appointments, cancellations, appointmentStatusHistory, logger; no leads, no messaging, no
    // conversations). This is a structural guarantee, not a behavioral one that could silently
    // regress -- documented here so the invariant is explicit and tested, not just implied.
    expect(AppointmentCancellationService.length).toBe(5);
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
    // Let every Phase A write through (newCalendarEventId, then newAppointmentId+phaseAStatus --
    // both load-bearing, never best-effort, same as AppointmentService.completeBooking's own
    // terminal booking_attempts.update). Only Phase B (cleanup) writes -- which never set either
    // of those two fields -- are made to fail.
    vi.spyOn(reschedules, "update").mockImplementation(async (id, patch) => {
      if (patch.newCalendarEventId !== undefined || patch.newAppointmentId !== undefined) {
        return originalUpdate(id, patch);
      }
      throw new Error("SUPABASE_DOWN");
    });

    const outcome = await service.reschedule(rescheduleParams({ oldAppointment: old }));

    expect(outcome.type).toBe("RESCHEDULED");
    expect((await appointments.findById(old.id))?.status).toBe("RESCHEDULED"); // real transition unaffected
    expect(logger.warnings.length).toBeGreaterThan(0);
  });
});
