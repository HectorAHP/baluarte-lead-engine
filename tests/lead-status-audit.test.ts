import { describe, expect, it, vi } from "vitest";
import { recordLeadStatusTransition, recordAppointmentStatusTransition } from "../src/application/lead-status-audit.js";
import { InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";

describe("recordLeadStatusTransition", () => {
  it("writes exactly one lead_status_history row for a real transition", async () => {
    const repo = new InMemoryLeadStatusHistoryRepository();
    const logger = new FakeLogger();

    await recordLeadStatusTransition(repo, logger, {
      leadId: "lead-1", fromStatus: "CONTACTED", toStatus: "QUALIFYING", eventType: "QUALIFICATION_STARTED",
    });

    const history = await repo.listByLeadId("lead-1");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      leadId: "lead-1", fromStatus: "CONTACTED", toStatus: "QUALIFYING", eventType: "QUALIFICATION_STARTED", metadata: {},
    });
    expect(history[0].createdAt).toBeInstanceOf(Date);
  });

  it("a no-op (fromStatus === toStatus) never writes a row, even if called directly", async () => {
    const repo = new InMemoryLeadStatusHistoryRepository();
    const logger = new FakeLogger();

    await recordLeadStatusTransition(repo, logger, {
      leadId: "lead-1", fromStatus: "BOOKING_PENDING", toStatus: "BOOKING_PENDING", eventType: "BOOKING_OFFER_STARTED",
    });

    expect(await repo.listByLeadId("lead-1")).toHaveLength(0);
  });

  it("calling it twice for two genuinely different transitions writes two rows, never collapsed/deduped incorrectly", async () => {
    const repo = new InMemoryLeadStatusHistoryRepository();
    const logger = new FakeLogger();

    await recordLeadStatusTransition(repo, logger, { leadId: "lead-1", fromStatus: "CONTACTED", toStatus: "QUALIFYING", eventType: "QUALIFICATION_STARTED" });
    await recordLeadStatusTransition(repo, logger, { leadId: "lead-1", fromStatus: "QUALIFYING", toStatus: "QUALIFIED_A", eventType: "QUALIFICATION_SCORED" });

    const history = await repo.listByLeadId("lead-1");
    expect(history).toHaveLength(2);
    expect(history[0].toStatus).toBe("QUALIFYING");
    expect(history[1].toStatus).toBe("QUALIFIED_A");
  });

  it("never throws when the repository write fails -- logs a sanitized warning instead", async () => {
    const repo = new InMemoryLeadStatusHistoryRepository();
    vi.spyOn(repo, "create").mockRejectedValueOnce(new Error("SUPABASE_DOWN"));
    const logger = new FakeLogger();

    await expect(
      recordLeadStatusTransition(repo, logger, { leadId: "lead-1", fromStatus: "CONTACTED", toStatus: "QUALIFYING", eventType: "QUALIFICATION_STARTED" }),
    ).resolves.toBeUndefined();

    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0].details).toMatchObject({ leadId: "lead-1", fromStatus: "CONTACTED", toStatus: "QUALIFYING", eventType: "QUALIFICATION_STARTED" });
  });

  it("metadata is stored exactly as given -- never enriched with message bodies or clinical content by the helper itself", async () => {
    const repo = new InMemoryLeadStatusHistoryRepository();
    const logger = new FakeLogger();

    await recordLeadStatusTransition(repo, logger, {
      leadId: "lead-1", fromStatus: "QUALIFYING", toStatus: "QUALIFIED_B", eventType: "QUALIFICATION_SCORED",
      metadata: { scoreClass: "B" },
    });

    const [row] = await repo.listByLeadId("lead-1");
    expect(row.metadata).toEqual({ scoreClass: "B" });
    expect(Object.keys(row.metadata)).not.toContain("message");
    expect(Object.keys(row.metadata)).not.toContain("inboundText");
  });

  it("defaults metadata to {} when omitted", async () => {
    const repo = new InMemoryLeadStatusHistoryRepository();
    const logger = new FakeLogger();

    await recordLeadStatusTransition(repo, logger, { leadId: "lead-1", fromStatus: "CONTACTED", toStatus: "QUALIFYING", eventType: "QUALIFICATION_STARTED" });

    expect((await repo.listByLeadId("lead-1"))[0].metadata).toEqual({});
  });
});

describe("recordAppointmentStatusTransition", () => {
  it("writes exactly one appointment_status_history row for a real transition", async () => {
    const repo = new InMemoryAppointmentStatusHistoryRepository();
    const logger = new FakeLogger();

    await recordAppointmentStatusTransition(repo, logger, {
      appointmentId: "appt-1", leadId: "lead-1", fromStatus: "BOOKED", toStatus: "CANCELLED", eventType: "LEAD_REQUESTED_CANCEL",
    });

    const history = await repo.listByAppointmentId("appt-1");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ appointmentId: "appt-1", leadId: "lead-1", fromStatus: "BOOKED", toStatus: "CANCELLED", eventType: "LEAD_REQUESTED_CANCEL" });
  });

  it("a no-op (fromStatus === toStatus) never writes a row", async () => {
    const repo = new InMemoryAppointmentStatusHistoryRepository();
    const logger = new FakeLogger();

    await recordAppointmentStatusTransition(repo, logger, {
      appointmentId: "appt-1", leadId: "lead-1", fromStatus: "BOOKED", toStatus: "BOOKED", eventType: "NOOP",
    });

    expect(await repo.listByAppointmentId("appt-1")).toHaveLength(0);
  });

  it("never throws when the repository write fails -- logs a sanitized warning instead", async () => {
    const repo = new InMemoryAppointmentStatusHistoryRepository();
    vi.spyOn(repo, "create").mockRejectedValueOnce(new Error("SUPABASE_DOWN"));
    const logger = new FakeLogger();

    await expect(
      recordAppointmentStatusTransition(repo, logger, { appointmentId: "appt-1", leadId: "lead-1", fromStatus: "BOOKED", toStatus: "NO_SHOW", eventType: "NO_SHOW_CONFIRMED" }),
    ).resolves.toBeUndefined();

    expect(logger.warnings).toHaveLength(1);
  });
});
