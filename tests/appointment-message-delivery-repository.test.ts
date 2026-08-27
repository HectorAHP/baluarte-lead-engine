import { describe, it, expect } from "vitest";
import { InMemoryAppointmentMessageDeliveryRepository } from "../src/infrastructure/memory-repositories.js";
import { mapRowToAppointmentMessageDelivery, type AppointmentMessageDeliveryRow } from "../src/infrastructure/supabase-appointment-message-delivery-repository.js";

const BASE_INPUT = {
  appointmentId: "appt-1",
  leadId: "lead-1",
  deliveryType: "REMINDER_24H" as const,
  scheduledFor: new Date("2026-03-01T10:00:00.000Z"),
  idempotencyKey: "REMINDER_24H:appt-1",
};

describe("InMemoryAppointmentMessageDeliveryRepository", () => {
  it("tryCreate wins outright and defaults status to PENDING, attemptCount to 0", async () => {
    const repo = new InMemoryAppointmentMessageDeliveryRepository();
    const row = await repo.tryCreate(BASE_INPUT);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({ ...BASE_INPUT, status: "PENDING", attemptCount: 0 });
    expect(row!.id).toBeTruthy();
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.updatedAt).toBeInstanceOf(Date);
  });

  it("two deliveries with the same idempotency_key can never coexist -- the second tryCreate returns null, never throws", async () => {
    const repo = new InMemoryAppointmentMessageDeliveryRepository();
    const first = await repo.tryCreate(BASE_INPUT);
    expect(first).not.toBeNull();

    // Same idempotencyKey, even with a different scheduledFor/appointmentId -- the key alone is
    // the uniqueness anchor, mirroring the real table's `unique (idempotency_key)` constraint.
    const second = await repo.tryCreate({ ...BASE_INPUT, appointmentId: "appt-DIFFERENT", scheduledFor: new Date("2026-03-05T00:00:00.000Z") });

    expect(second).toBeNull();
    // The original row is untouched by the losing attempt.
    const found = await repo.findByIdempotencyKey(BASE_INPUT.idempotencyKey);
    expect(found?.appointmentId).toBe("appt-1");
  });

  it("a different delivery_type for the same appointment gets its own idempotency_key and coexists fine", async () => {
    const repo = new InMemoryAppointmentMessageDeliveryRepository();
    const reminder24h = await repo.tryCreate(BASE_INPUT);
    const reminder2h = await repo.tryCreate({ ...BASE_INPUT, deliveryType: "REMINDER_2H", idempotencyKey: "REMINDER_2H:appt-1" });

    expect(reminder24h).not.toBeNull();
    expect(reminder2h).not.toBeNull();
    expect(reminder24h!.id).not.toBe(reminder2h!.id);
  });

  it("findByIdempotencyKey returns null when nothing has been scheduled yet", async () => {
    const repo = new InMemoryAppointmentMessageDeliveryRepository();
    expect(await repo.findByIdempotencyKey("nonexistent")).toBeNull();
  });

  it("update() applies a partial patch and bumps updatedAt", async () => {
    const repo = new InMemoryAppointmentMessageDeliveryRepository();
    const created = await repo.tryCreate(BASE_INPUT);
    const updated = await repo.update(created!.id, { status: "COMPLETED", completedAt: new Date("2026-03-01T10:00:05.000Z"), providerMessageId: "wamid.123" });

    expect(updated.status).toBe("COMPLETED");
    expect(updated.providerMessageId).toBe("wamid.123");
    expect(updated.completedAt).toEqual(new Date("2026-03-01T10:00:05.000Z"));
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created!.updatedAt.getTime());
  });

  it("update() throws for an unknown id", async () => {
    const repo = new InMemoryAppointmentMessageDeliveryRepository();
    await expect(repo.update("nonexistent", { status: "FAILED" })).rejects.toThrow();
  });
});

describe("SupabaseAppointmentMessageDeliveryRepository -- row mapping (pure, no network)", () => {
  it("maps a snake_case row to the camelCase domain type", () => {
    const row: AppointmentMessageDeliveryRow = {
      id: "delivery-1",
      appointment_id: "appt-1",
      lead_id: "lead-1",
      delivery_type: "POST_MEETING_FOLLOWUP",
      status: "PENDING",
      scheduled_for: "2026-03-02T15:00:00.000Z",
      idempotency_key: "POST_MEETING_FOLLOWUP:appt-1",
      attempt_count: 0,
      last_attempt_at: null,
      completed_at: null,
      provider_message_id: null,
      error_code: null,
      created_at: "2026-03-02T12:00:00.000Z",
      updated_at: "2026-03-02T12:00:00.000Z",
    };

    expect(mapRowToAppointmentMessageDelivery(row)).toEqual({
      id: "delivery-1",
      appointmentId: "appt-1",
      leadId: "lead-1",
      deliveryType: "POST_MEETING_FOLLOWUP",
      status: "PENDING",
      scheduledFor: new Date("2026-03-02T15:00:00.000Z"),
      idempotencyKey: "POST_MEETING_FOLLOWUP:appt-1",
      attemptCount: 0,
      lastAttemptAt: undefined,
      completedAt: undefined,
      providerMessageId: undefined,
      errorCode: undefined,
      createdAt: new Date("2026-03-02T12:00:00.000Z"),
      updatedAt: new Date("2026-03-02T12:00:00.000Z"),
    });
  });
});
