import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppointmentService } from "../src/application/services.js";
import { HumanHandoffRecoveryService } from "../src/application/human-handoff-recovery-service.js";
import {
  InMemoryAppointmentRepository, InMemoryBookingAttemptRepository, InMemoryLeadRepository,
  InMemoryAppointmentStatusHistoryRepository, InMemoryLeadStatusHistoryRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import type { CalendarProvider, CalendarEventInput, CalendarEventResult } from "../src/application/ports.js";

/**
 * Fase 7H -- real incident this closes: lead eb95060d had an old BOOKED appointment left behind
 * after a HUMAN_HANDOFF recovery, then booked a brand-new one independently, ending up with TWO
 * "active" (status=BOOKED) appointments for the same lead -- which made
 * WhatsAppCancellationHandler/WhatsAppRescheduleHandler's findTargetAppointment see ">1 active"
 * and escalate every subsequent "cancelar"/"reagendar" straight to HUMAN_HANDOFF instead of acting
 * on the real upcoming appointment. This file tests
 * AppointmentService.expirePriorStaleBookedAppointments, the fix: a private step, run immediately
 * before every new appointment is created, that closes out any of the SAME lead's other BOOKED
 * appointments whose endsAt has already passed -- transitioning them to EXPIRED (never
 * COMPLETED/NO_SHOW, which are genuine attendance determinations -- see AppointmentStatus's own
 * doc comment), never touching a future/current one, and never touching Calendar.
 */

function makeService(overrides: { calendar?: CalendarProvider } = {}) {
  const calendar = overrides.calendar ?? new FakeCalendarProvider();
  const appointments = new InMemoryAppointmentRepository();
  const bookingAttempts = new InMemoryBookingAttemptRepository();
  const leads = new InMemoryLeadRepository();
  const logger = new FakeLogger();
  const appointmentStatusHistory = new InMemoryAppointmentStatusHistoryRepository();
  const service = new AppointmentService(calendar, appointments, bookingAttempts, leads, logger, appointmentStatusHistory);
  return { service, calendar, appointments, bookingAttempts, leads, logger, appointmentStatusHistory };
}

function bookingInput(leadId: string, overrides: Partial<{ start: Date; end: Date }> = {}) {
  const start = overrides.start ?? new Date(Date.now() + 2 * 24 * 3600 * 1000);
  const end = overrides.end ?? new Date(start.getTime() + 30 * 60 * 1000);
  return {
    leadId,
    title: "Cita PPR",
    description: "Reunion inicial",
    start,
    end,
    attendeeEmail: "lead@example.com",
    timezone: "America/Mexico_City",
  };
}

/** A BOOKED appointment whose window ended in the past -- the exact shape of the real orphan. */
async function seedPastBookedAppointment(appointments: InMemoryAppointmentRepository, leadId: string, calendarEventId = "old-real-event") {
  return appointments.create({
    leadId,
    status: "BOOKED",
    startsAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
    endsAt: new Date(Date.now() - 5 * 24 * 3600 * 1000 + 30 * 60 * 1000),
    timezone: "America/Mexico_City",
    calendarEventId,
  });
}

describe("Fase 7H -- AppointmentService.expirePriorStaleBookedAppointments", () => {
  it("item 1: an old BOOKED appointment whose endsAt has passed transitions to EXPIRED when a new appointment is booked for the same lead", async () => {
    const { service, appointments, appointmentStatusHistory } = makeService();
    const leadId = randomUUID();
    const old = await seedPastBookedAppointment(appointments, leadId);

    const fresh = await service.book(bookingInput(leadId), randomUUID());

    const reread = await appointments.findById(old.id);
    expect(reread?.status).toBe("EXPIRED");
    expect(fresh.status).toBe("BOOKED");
    expect(fresh.id).not.toBe(old.id);

    const history = await appointmentStatusHistory.listByAppointmentId(old.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: "BOOKED", toStatus: "EXPIRED", eventType: "APPOINTMENT_EXPIRED_ON_REBOOK" });
  });

  it("item 2: a future/current BOOKED appointment is NEVER auto-closed by a new booking for the same lead", async () => {
    const { service, appointments } = makeService();
    const leadId = randomUUID();
    const future = await appointments.create({
      leadId, status: "BOOKED",
      startsAt: new Date(Date.now() + 6 * 24 * 3600 * 1000),
      endsAt: new Date(Date.now() + 6 * 24 * 3600 * 1000 + 30 * 60 * 1000),
      timezone: "America/Mexico_City",
      calendarEventId: "future-event",
    });

    // A second, later, non-overlapping booking for the same lead.
    await service.book(bookingInput(leadId, { start: new Date(Date.now() + 8 * 24 * 3600 * 1000), end: new Date(Date.now() + 8 * 24 * 3600 * 1000 + 30 * 60 * 1000) }), randomUUID());

    const reread = await appointments.findById(future.id);
    expect(reread?.status).toBe("BOOKED"); // untouched -- still a live commitment
  });

  it("item 3: a COMPLETED appointment is never touched, even with an endsAt in the past", async () => {
    const { service, appointments } = makeService();
    const leadId = randomUUID();
    const completed = await seedPastBookedAppointment(appointments, leadId);
    await appointments.update(completed.id, { status: "COMPLETED" });

    await service.book(bookingInput(leadId), randomUUID());

    const reread = await appointments.findById(completed.id);
    expect(reread?.status).toBe("COMPLETED");
  });

  it("item 4: a CANCELLED appointment is never touched", async () => {
    const { service, appointments } = makeService();
    const leadId = randomUUID();
    const cancelled = await seedPastBookedAppointment(appointments, leadId);
    await appointments.update(cancelled.id, { status: "CANCELLED" });

    await service.book(bookingInput(leadId), randomUUID());

    const reread = await appointments.findById(cancelled.id);
    expect(reread?.status).toBe("CANCELLED");
  });

  it("item 5: a NO_SHOW appointment is never touched", async () => {
    const { service, appointments } = makeService();
    const leadId = randomUUID();
    const noShow = await seedPastBookedAppointment(appointments, leadId);
    await appointments.update(noShow.id, { status: "NO_SHOW" });

    await service.book(bookingInput(leadId), randomUUID());

    const reread = await appointments.findById(noShow.id);
    expect(reread?.status).toBe("NO_SHOW");
  });

  it("item 6: expiring an old appointment never infers attendance -- it becomes EXPIRED, never COMPLETED or NO_SHOW", async () => {
    const { service, appointments } = makeService();
    const leadId = randomUUID();
    const old = await seedPastBookedAppointment(appointments, leadId);

    await service.book(bookingInput(leadId), randomUUID());

    const reread = await appointments.findById(old.id);
    expect(reread?.status).not.toBe("COMPLETED");
    expect(reread?.status).not.toBe("NO_SHOW");
    expect(reread?.status).toBe("EXPIRED");
  });

  it("item 7: a real appointment_status_history row is written for the expiry, distinct from cancellation/completion/no-show event types", async () => {
    const { service, appointments, appointmentStatusHistory } = makeService();
    const leadId = randomUUID();
    const old = await seedPastBookedAppointment(appointments, leadId);

    await service.book(bookingInput(leadId), randomUUID());

    const [entry] = await appointmentStatusHistory.listByAppointmentId(old.id);
    expect(entry.eventType).toBe("APPOINTMENT_EXPIRED_ON_REBOOK");
    expect(entry.eventType).not.toBe("APPOINTMENT_CANCELLED");
    expect(entry.eventType).not.toBe("APPOINTMENT_MARKED_COMPLETED");
    expect(entry.eventType).not.toBe("APPOINTMENT_MARKED_NO_SHOW");
  });

  it("item 8: retrying book() with the same idempotency key never double-processes the same old appointment", async () => {
    const { service, appointments, appointmentStatusHistory } = makeService();
    const leadId = randomUUID();
    const old = await seedPastBookedAppointment(appointments, leadId);
    const key = randomUUID();
    const input = bookingInput(leadId);

    const first = await service.book(input, key);
    const second = await service.book(input, key); // idempotent retry -- same key + same payload

    expect(second.id).toBe(first.id);
    const history = await appointmentStatusHistory.listByAppointmentId(old.id);
    expect(history).toHaveLength(1); // never a duplicate EXPIRED row for the same appointment
  });

  it("items 9/10: after the fix, listActiveByLeadId returns exactly the new appointment -- cancellation/reschedule's own findTargetAppointment no longer sees >1", async () => {
    const { service, appointments } = makeService();
    const leadId = randomUUID();
    await seedPastBookedAppointment(appointments, leadId);

    const fresh = await service.book(bookingInput(leadId), randomUUID());

    const active = await appointments.listActiveByLeadId(leadId);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(fresh.id);
  });

  it("item 11: a HUMAN_HANDOFF recovery followed by a fresh booking never leaves two BOOKED appointments -- the real eb95060d incident, reproduced and fixed", async () => {
    const leads = new InMemoryLeadRepository();
    const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
    const appointments = new InMemoryAppointmentRepository();
    const appointmentStatusHistory = new InMemoryAppointmentStatusHistoryRepository();
    const bookingAttempts = new InMemoryBookingAttemptRepository();
    const calendar = new FakeCalendarProvider();
    const logger = new FakeLogger();
    const appointmentService = new AppointmentService(calendar, appointments, bookingAttempts, leads, logger, appointmentStatusHistory);
    const recoveryService = new HumanHandoffRecoveryService({ leads, appointments, leadStatusHistory, logger });

    const lead = await leads.create({
      country: "MX", productVertical: "PATRIMONIAL", status: "HUMAN_HANDOFF", score: 78, scoreClass: "A",
      assignedAdvisor: "Hector Herrera", consentContact: true,
    });
    const oldAppointment = await seedPastBookedAppointment(appointments, lead.id, "old-real-google-event");

    // Caso B (PAST): recovery resolves to BOOKING_PENDING, exactly the real lead's history.
    const recovery = await recoveryService.recover(lead.id, new Date());
    expect(recovery.outcome).toBe("RECOVERED");
    if (recovery.outcome === "RECOVERED") {
      expect(recovery.toStatus).toBe("BOOKING_PENDING");
      expect(recovery.resolvedAppointmentState).toBe("PAST");
    }

    // The lead now re-books normally through WhatsApp (AppointmentService.book -- the same choke
    // point WhatsAppBookingHandler itself calls).
    const newAppointment = await appointmentService.book(bookingInput(lead.id), randomUUID());

    const active = await appointments.listActiveByLeadId(lead.id);
    expect(active).toHaveLength(1); // never 2 -- the real bug is fixed
    expect(active[0].id).toBe(newAppointment.id);

    const oldReread = await appointments.findById(oldAppointment.id);
    expect(oldReread?.status).toBe("EXPIRED");
  });

  it("item 12: expiring the old appointment never calls Calendar.deleteEvent for it -- the real Calendar event is left exactly as it is", async () => {
    const deletedEventIds: string[] = [];
    const inner = new FakeCalendarProvider();
    const spyCalendar: CalendarProvider = {
      getAvailableSlots: (...args) => inner.getAvailableSlots(...args),
      isSlotAvailable: (...args) => inner.isSlotAvailable(...args),
      isWithinBusinessHours: (...args) => inner.isWithinBusinessHours(...args),
      createEvent: (input: CalendarEventInput): Promise<CalendarEventResult> => inner.createEvent(input),
      deleteEvent: (eventId: string) => {
        deletedEventIds.push(eventId);
        return inner.deleteEvent(eventId);
      },
    };
    const { service, appointments } = makeService({ calendar: spyCalendar });
    const leadId = randomUUID();
    await seedPastBookedAppointment(appointments, leadId, "old-real-event-must-survive");

    await service.book(bookingInput(leadId), randomUUID());

    expect(deletedEventIds).not.toContain("old-real-event-must-survive");
  });

  it("item 13: the new appointment's own Calendar event is created normally, unaffected by the old-appointment expiry step", async () => {
    const { service, appointments } = makeService();
    const leadId = randomUUID();
    await seedPastBookedAppointment(appointments, leadId);

    const fresh = await service.book(bookingInput(leadId), randomUUID());

    expect(fresh.calendarEventId).toBeTruthy();
    expect(fresh.meetingUrl).toBeTruthy();
  });
});
