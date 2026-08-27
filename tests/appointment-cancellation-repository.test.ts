import { describe, it, expect } from "vitest";
import { InMemoryAppointmentCancellationRepository } from "../src/infrastructure/memory-repositories.js";
import { mapRowToAppointmentCancellation, type AppointmentCancellationRow } from "../src/infrastructure/supabase-appointment-cancellation-repository.js";

const BASE_INPUT = {
  appointmentId: "appt-1",
  leadId: "lead-1",
  idempotencyKey: "whatsapp-cancel:lead-1:appt-1",
  calendarEventId: "evt-1",
};

describe("InMemoryAppointmentCancellationRepository", () => {
  it("tryCreate wins outright and defaults status to PENDING, attemptCount to 0", async () => {
    const repo = new InMemoryAppointmentCancellationRepository();
    const row = await repo.tryCreate(BASE_INPUT);
    expect(row).toMatchObject({ ...BASE_INPUT, status: "PENDING", attemptCount: 0 });
    expect(row!.id).toBeTruthy();
  });

  it("two cancellations with the same idempotency_key can never coexist -- the second tryCreate returns null, never throws", async () => {
    const repo = new InMemoryAppointmentCancellationRepository();
    await repo.tryCreate(BASE_INPUT);

    const second = await repo.tryCreate({ ...BASE_INPUT, appointmentId: "appt-DIFFERENT" });

    expect(second).toBeNull();
    expect((await repo.findByIdempotencyKey(BASE_INPUT.idempotencyKey))?.appointmentId).toBe("appt-1");
  });

  it("findByIdempotencyKey returns null when nothing has been tracked yet", async () => {
    const repo = new InMemoryAppointmentCancellationRepository();
    expect(await repo.findByIdempotencyKey("nonexistent")).toBeNull();
  });

  it("update() applies a partial patch and bumps updatedAt", async () => {
    const repo = new InMemoryAppointmentCancellationRepository();
    const created = await repo.tryCreate(BASE_INPUT);
    const updated = await repo.update(created!.id, { status: "COMPLETED", completedAt: new Date("2026-03-01T10:00:05.000Z"), attemptCount: 1 });

    expect(updated.status).toBe("COMPLETED");
    expect(updated.attemptCount).toBe(1);
    expect(updated.completedAt).toEqual(new Date("2026-03-01T10:00:05.000Z"));
  });

  it("update() throws for an unknown id", async () => {
    const repo = new InMemoryAppointmentCancellationRepository();
    await expect(repo.update("nonexistent", { status: "COMPLETED" })).rejects.toThrow();
  });

  it("a cancellation with no Calendar event (calendarEventId undefined) is still tracked correctly", async () => {
    const repo = new InMemoryAppointmentCancellationRepository();
    const row = await repo.tryCreate({ appointmentId: "appt-2", leadId: "lead-2", idempotencyKey: "whatsapp-cancel:lead-2:appt-2" });
    expect(row?.calendarEventId).toBeUndefined();
  });
});

describe("SupabaseAppointmentCancellationRepository -- row mapping (pure, no network)", () => {
  it("maps a snake_case row to the camelCase domain type", () => {
    const row: AppointmentCancellationRow = {
      id: "cancel-1",
      appointment_id: "appt-1",
      lead_id: "lead-1",
      idempotency_key: "whatsapp-cancel:lead-1:appt-1",
      calendar_event_id: "evt-1",
      status: "PENDING",
      attempt_count: 0,
      last_attempt_at: null,
      completed_at: null,
      error_code: null,
      created_at: "2026-03-02T12:00:00.000Z",
      updated_at: "2026-03-02T12:00:00.000Z",
    };

    expect(mapRowToAppointmentCancellation(row)).toEqual({
      id: "cancel-1",
      appointmentId: "appt-1",
      leadId: "lead-1",
      idempotencyKey: "whatsapp-cancel:lead-1:appt-1",
      calendarEventId: "evt-1",
      status: "PENDING",
      attemptCount: 0,
      lastAttemptAt: undefined,
      completedAt: undefined,
      errorCode: undefined,
      createdAt: new Date("2026-03-02T12:00:00.000Z"),
      updatedAt: new Date("2026-03-02T12:00:00.000Z"),
    });
  });

  it("maps a null calendar_event_id to undefined (no Calendar event to clean up)", () => {
    const row: AppointmentCancellationRow = {
      id: "cancel-1", appointment_id: "appt-1", lead_id: "lead-1", idempotency_key: "k",
      calendar_event_id: null, status: "COMPLETED", attempt_count: 0, last_attempt_at: null,
      completed_at: "2026-03-02T12:00:05.000Z", error_code: null,
      created_at: "2026-03-02T12:00:00.000Z", updated_at: "2026-03-02T12:00:05.000Z",
    };
    expect(mapRowToAppointmentCancellation(row).calendarEventId).toBeUndefined();
  });
});
