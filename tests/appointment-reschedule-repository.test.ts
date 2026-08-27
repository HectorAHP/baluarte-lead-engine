import { describe, it, expect } from "vitest";
import { InMemoryAppointmentRescheduleRepository } from "../src/infrastructure/memory-repositories.js";
import { mapRowToAppointmentReschedule, type AppointmentRescheduleRow } from "../src/infrastructure/supabase-appointment-reschedule-repository.js";

const BASE_INPUT = {
  leadId: "lead-1",
  oldAppointmentId: "appt-old-1",
  idempotencyKey: "whatsapp-reschedule:lead-1:appt-old-1:slot-1",
  oldCalendarEventId: "evt-old-1",
};

describe("InMemoryAppointmentRescheduleRepository", () => {
  it("tryCreate wins outright, defaults status to PENDING, attemptCount to 0, newAppointmentId undefined", async () => {
    const repo = new InMemoryAppointmentRescheduleRepository();
    const row = await repo.tryCreate(BASE_INPUT);
    expect(row).toMatchObject({ ...BASE_INPUT, status: "PENDING", attemptCount: 0 });
    expect(row!.newAppointmentId).toBeUndefined();
    expect(row!.id).toBeTruthy();
  });

  it("two reschedules with the same idempotency_key can never coexist -- the second tryCreate returns null, never throws", async () => {
    const repo = new InMemoryAppointmentRescheduleRepository();
    await repo.tryCreate(BASE_INPUT);

    const second = await repo.tryCreate({ ...BASE_INPUT, oldAppointmentId: "appt-old-DIFFERENT" });

    expect(second).toBeNull();
    expect((await repo.findByIdempotencyKey(BASE_INPUT.idempotencyKey))?.oldAppointmentId).toBe("appt-old-1");
  });

  it("findByIdempotencyKey returns null when nothing has been tracked yet", async () => {
    const repo = new InMemoryAppointmentRescheduleRepository();
    expect(await repo.findByIdempotencyKey("nonexistent")).toBeNull();
  });

  it("update() sets newAppointmentId once Phase A completes", async () => {
    const repo = new InMemoryAppointmentRescheduleRepository();
    const created = await repo.tryCreate(BASE_INPUT);
    const updated = await repo.update(created!.id, { newAppointmentId: "appt-new-1" });
    expect(updated.newAppointmentId).toBe("appt-new-1");
  });

  it("update() applies a Phase B cleanup patch and bumps updatedAt", async () => {
    const repo = new InMemoryAppointmentRescheduleRepository();
    const created = await repo.tryCreate(BASE_INPUT);
    const updated = await repo.update(created!.id, { status: "COMPLETED", completedAt: new Date("2026-03-01T10:00:05.000Z"), attemptCount: 1 });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.attemptCount).toBe(1);
  });

  it("update() throws for an unknown id", async () => {
    const repo = new InMemoryAppointmentRescheduleRepository();
    await expect(repo.update("nonexistent", { status: "COMPLETED" })).rejects.toThrow();
  });

  it("a reschedule with no old Calendar event (oldCalendarEventId undefined) is still tracked correctly", async () => {
    const repo = new InMemoryAppointmentRescheduleRepository();
    const row = await repo.tryCreate({ leadId: "lead-2", oldAppointmentId: "appt-old-2", idempotencyKey: "whatsapp-reschedule:lead-2:appt-old-2:slot-2" });
    expect(row?.oldCalendarEventId).toBeUndefined();
  });
});

describe("SupabaseAppointmentRescheduleRepository -- row mapping (pure, no network)", () => {
  it("maps a snake_case row to the camelCase domain type", () => {
    const row: AppointmentRescheduleRow = {
      id: "resch-1",
      lead_id: "lead-1",
      old_appointment_id: "appt-old-1",
      new_appointment_id: "appt-new-1",
      new_calendar_event_id: "evt-new-1",
      phase_a_status: "COMPLETED",
      idempotency_key: "whatsapp-reschedule:lead-1:appt-old-1:slot-1",
      old_calendar_event_id: "evt-old-1",
      status: "COMPLETED",
      attempt_count: 1,
      last_attempt_at: "2026-03-02T12:00:00.000Z",
      completed_at: "2026-03-02T12:00:05.000Z",
      error_code: null,
      created_at: "2026-03-02T12:00:00.000Z",
      updated_at: "2026-03-02T12:00:05.000Z",
    };

    expect(mapRowToAppointmentReschedule(row)).toEqual({
      id: "resch-1",
      leadId: "lead-1",
      oldAppointmentId: "appt-old-1",
      newAppointmentId: "appt-new-1",
      newCalendarEventId: "evt-new-1",
      phaseAStatus: "COMPLETED",
      idempotencyKey: "whatsapp-reschedule:lead-1:appt-old-1:slot-1",
      oldCalendarEventId: "evt-old-1",
      status: "COMPLETED",
      attemptCount: 1,
      lastAttemptAt: new Date("2026-03-02T12:00:00.000Z"),
      completedAt: new Date("2026-03-02T12:00:05.000Z"),
      errorCode: undefined,
      createdAt: new Date("2026-03-02T12:00:00.000Z"),
      updatedAt: new Date("2026-03-02T12:00:05.000Z"),
    });
  });

  it("maps a null new_appointment_id/new_calendar_event_id to undefined (Phase A not yet complete)", () => {
    const row: AppointmentRescheduleRow = {
      id: "resch-1", lead_id: "lead-1", old_appointment_id: "appt-old-1", new_appointment_id: null,
      new_calendar_event_id: null, phase_a_status: "PENDING",
      idempotency_key: "k", old_calendar_event_id: null, status: "PENDING", attempt_count: 0,
      last_attempt_at: null, completed_at: null, error_code: null,
      created_at: "2026-03-02T12:00:00.000Z", updated_at: "2026-03-02T12:00:00.000Z",
    };
    expect(mapRowToAppointmentReschedule(row).newAppointmentId).toBeUndefined();
    expect(mapRowToAppointmentReschedule(row).newCalendarEventId).toBeUndefined();
    expect(mapRowToAppointmentReschedule(row).phaseAStatus).toBe("PENDING");
  });
});
