import { describe, it, expect } from "vitest";
import { InMemoryLeadStatusHistoryRepository } from "../src/infrastructure/memory-repositories.js";
import { mapRowToLeadStatusHistoryEntry, type LeadStatusHistoryRow } from "../src/infrastructure/supabase-lead-status-history-repository.js";

describe("InMemoryLeadStatusHistoryRepository", () => {
  it("create() persists a row with a generated id and createdAt", async () => {
    const repo = new InMemoryLeadStatusHistoryRepository();
    const row = await repo.create({ leadId: "lead-1", fromStatus: "CONTACTED", toStatus: "QUALIFYING", eventType: "QUALIFICATION_STARTED", metadata: {} });
    expect(row.id).toBeTruthy();
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row).toMatchObject({ leadId: "lead-1", fromStatus: "CONTACTED", toStatus: "QUALIFYING", eventType: "QUALIFICATION_STARTED" });
  });

  it("listByLeadId returns only that lead's rows, in chronological order", async () => {
    const repo = new InMemoryLeadStatusHistoryRepository();
    await repo.create({ leadId: "lead-1", fromStatus: "CONTACTED", toStatus: "QUALIFYING", eventType: "QUALIFICATION_STARTED", metadata: {} });
    await repo.create({ leadId: "lead-2", fromStatus: "CONTACTED", toStatus: "QUALIFYING", eventType: "QUALIFICATION_STARTED", metadata: {} });
    await repo.create({ leadId: "lead-1", fromStatus: "QUALIFYING", toStatus: "QUALIFIED_A", eventType: "QUALIFICATION_SCORED", metadata: {} });

    const history = await repo.listByLeadId("lead-1");
    expect(history).toHaveLength(2);
    expect(history[0].toStatus).toBe("QUALIFYING");
    expect(history[1].toStatus).toBe("QUALIFIED_A");
  });

  it("listByLeadId returns an empty array for a lead with no history", async () => {
    const repo = new InMemoryLeadStatusHistoryRepository();
    expect(await repo.listByLeadId("nonexistent")).toEqual([]);
  });

  it("metadata round-trips exactly as given", async () => {
    const repo = new InMemoryLeadStatusHistoryRepository();
    await repo.create({ leadId: "lead-1", fromStatus: "QUALIFYING", toStatus: "QUALIFIED_B", eventType: "QUALIFICATION_SCORED", metadata: { scoreClass: "B" } });
    const [row] = await repo.listByLeadId("lead-1");
    expect(row.metadata).toEqual({ scoreClass: "B" });
  });
});

describe("SupabaseLeadStatusHistoryRepository -- row mapping (pure, no network)", () => {
  it("maps a snake_case row to the camelCase domain type", () => {
    const row: LeadStatusHistoryRow = {
      id: "hist-1",
      lead_id: "lead-1",
      from_status: "BOOKING_PENDING",
      to_status: "BOOKED",
      event_type: "BOOKING_CONFIRMED",
      metadata: { appointmentId: "appt-1" },
      created_at: "2026-03-02T12:00:00.000Z",
    };

    expect(mapRowToLeadStatusHistoryEntry(row)).toEqual({
      id: "hist-1",
      leadId: "lead-1",
      fromStatus: "BOOKING_PENDING",
      toStatus: "BOOKED",
      eventType: "BOOKING_CONFIRMED",
      metadata: { appointmentId: "appt-1" },
      createdAt: new Date("2026-03-02T12:00:00.000Z"),
    });
  });

  it("defaults metadata to {} when the row's metadata is null/undefined", () => {
    const row = {
      id: "hist-1", lead_id: "lead-1", from_status: "NEW", to_status: "CONTACTED",
      event_type: "LEAD_CONTACTED", metadata: null as unknown as Record<string, unknown>,
      created_at: "2026-03-02T12:00:00.000Z",
    } satisfies LeadStatusHistoryRow;

    expect(mapRowToLeadStatusHistoryEntry(row).metadata).toEqual({});
  });
});
