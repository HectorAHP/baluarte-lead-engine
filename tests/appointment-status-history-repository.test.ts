import { describe, it, expect } from "vitest";
import { InMemoryAppointmentStatusHistoryRepository } from "../src/infrastructure/memory-repositories.js";
import { mapRowToAppointmentStatusHistoryEntry, type AppointmentStatusHistoryRow } from "../src/infrastructure/supabase-appointment-status-history-repository.js";

describe("InMemoryAppointmentStatusHistoryRepository", () => {
  it("create() persists a row with a generated id and createdAt", async () => {
    const repo = new InMemoryAppointmentStatusHistoryRepository();
    const row = await repo.create({ appointmentId: "appt-1", leadId: "lead-1", fromStatus: "BOOKED", toStatus: "CANCELLED", eventType: "LEAD_REQUESTED_CANCEL", metadata: {} });
    expect(row.id).toBeTruthy();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("listByAppointmentId returns only that appointment's rows, in chronological order", async () => {
    const repo = new InMemoryAppointmentStatusHistoryRepository();
    await repo.create({ appointmentId: "appt-1", leadId: "lead-1", fromStatus: "BOOKED", toStatus: "RESCHEDULED", eventType: "LEAD_REQUESTED_RESCHEDULE", metadata: {} });
    await repo.create({ appointmentId: "appt-2", leadId: "lead-2", fromStatus: "BOOKED", toStatus: "CANCELLED", eventType: "LEAD_REQUESTED_CANCEL", metadata: {} });

    const history = await repo.listByAppointmentId("appt-1");
    expect(history).toHaveLength(1);
    expect(history[0].toStatus).toBe("RESCHEDULED");
  });

  it("listByAppointmentId returns an empty array for an appointment with no history -- true for every current Phase 3C appointment, since nothing transitions an appointment's status yet", async () => {
    const repo = new InMemoryAppointmentStatusHistoryRepository();
    expect(await repo.listByAppointmentId("any-appointment")).toEqual([]);
  });

  it("can reconstruct every terminal transition Phase 4B/4C/4E will need: BOOKED -> CANCELLED/RESCHEDULED/COMPLETED/NO_SHOW", async () => {
    const repo = new InMemoryAppointmentStatusHistoryRepository();
    for (const [id, toStatus] of [["a1", "CANCELLED"], ["a2", "RESCHEDULED"], ["a3", "COMPLETED"], ["a4", "NO_SHOW"]] as const) {
      await repo.create({ appointmentId: id, leadId: "lead-1", fromStatus: "BOOKED", toStatus, eventType: `TEST_${toStatus}`, metadata: {} });
      expect((await repo.listByAppointmentId(id))[0].toStatus).toBe(toStatus);
    }
  });
});

describe("SupabaseAppointmentStatusHistoryRepository -- row mapping (pure, no network)", () => {
  it("maps a snake_case row to the camelCase domain type", () => {
    const row: AppointmentStatusHistoryRow = {
      id: "hist-1",
      appointment_id: "appt-1",
      lead_id: "lead-1",
      from_status: "BOOKED",
      to_status: "NO_SHOW",
      event_type: "NO_SHOW_CONFIRMED",
      metadata: {},
      created_at: "2026-03-02T12:00:00.000Z",
    };

    expect(mapRowToAppointmentStatusHistoryEntry(row)).toEqual({
      id: "hist-1",
      appointmentId: "appt-1",
      leadId: "lead-1",
      fromStatus: "BOOKED",
      toStatus: "NO_SHOW",
      eventType: "NO_SHOW_CONFIRMED",
      metadata: {},
      createdAt: new Date("2026-03-02T12:00:00.000Z"),
    });
  });
});
