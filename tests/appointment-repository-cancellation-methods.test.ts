import { describe, it, expect } from "vitest";
import { InMemoryAppointmentRepository } from "../src/infrastructure/memory-repositories.js";

const BASE = { leadId: "lead-1", startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City" };

describe("InMemoryAppointmentRepository -- Phase 4B additions", () => {
  it("listActiveByLeadId returns every BOOKED appointment for the lead, and none for other leads/statuses", async () => {
    const repo = new InMemoryAppointmentRepository();
    const a = await repo.create({ ...BASE, status: "BOOKED" });
    // Different lead AND a non-overlapping time -- the repository's overlap guard is global
    // (single-calendar), so an overlapping time would collide regardless of leadId.
    await repo.create({ ...BASE, leadId: "lead-2", status: "BOOKED", startsAt: new Date("2026-03-05T15:00:00.000Z"), endsAt: new Date("2026-03-05T15:30:00.000Z") });
    await repo.update(a.id, {}); // no-op, keeps status BOOKED

    const active = await repo.listActiveByLeadId("lead-1");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(a.id);
  });

  it("listActiveByLeadId returns an empty array once the appointment is CANCELLED", async () => {
    const repo = new InMemoryAppointmentRepository();
    const a = await repo.create({ ...BASE, status: "BOOKED" });
    await repo.update(a.id, { status: "CANCELLED" });

    expect(await repo.listActiveByLeadId("lead-1")).toEqual([]);
  });

  it("listActiveByLeadId surfaces MORE THAN ONE active appointment for the same lead (a genuine data-consistency signal findActiveByLeadId's single-row contract cannot express)", async () => {
    const repo = new InMemoryAppointmentRepository();
    // Two non-overlapping BOOKED appointments for the same lead -- InMemoryAppointmentRepository's
    // overlap guard only rejects overlapping time ranges, so this is a legitimate way to end up
    // with two active rows for one lead (mirrors what a real data-consistency bug would look like).
    await repo.create({ ...BASE, status: "BOOKED" });
    await repo.create({ ...BASE, status: "BOOKED", startsAt: new Date("2026-03-03T15:00:00.000Z"), endsAt: new Date("2026-03-03T15:30:00.000Z") });

    expect(await repo.listActiveByLeadId("lead-1")).toHaveLength(2);
  });

  it("findMostRecentByLeadId returns the appointment regardless of status", async () => {
    const repo = new InMemoryAppointmentRepository();
    const a = await repo.create({ ...BASE, status: "BOOKED" });
    await repo.update(a.id, { status: "CANCELLED" });

    const mostRecent = await repo.findMostRecentByLeadId("lead-1");
    expect(mostRecent?.id).toBe(a.id);
    expect(mostRecent?.status).toBe("CANCELLED");
  });

  it("findMostRecentByLeadId returns null when the lead never had an appointment", async () => {
    const repo = new InMemoryAppointmentRepository();
    expect(await repo.findMostRecentByLeadId("nonexistent-lead")).toBeNull();
  });

  it("claimTransition wins when the current status matches expectedStatus, and returns the updated row", async () => {
    const repo = new InMemoryAppointmentRepository();
    const a = await repo.create({ ...BASE, status: "BOOKED" });

    const claimed = await repo.claimTransition(a.id, "BOOKED", "CANCELLED");

    expect(claimed?.status).toBe("CANCELLED");
    expect((await repo.findById(a.id))?.status).toBe("CANCELLED");
  });

  it("claimTransition returns null (never throws) when the current status does not match expectedStatus", async () => {
    const repo = new InMemoryAppointmentRepository();
    const a = await repo.create({ ...BASE, status: "BOOKED" });
    await repo.update(a.id, { status: "CANCELLED" });

    const result = await repo.claimTransition(a.id, "BOOKED", "CANCELLED");

    expect(result).toBeNull();
  });

  it("claimTransition returns null for an unknown id", async () => {
    const repo = new InMemoryAppointmentRepository();
    expect(await repo.claimTransition("nonexistent", "BOOKED", "CANCELLED")).toBeNull();
  });

  it("concurrent claimTransition calls: only one of two callers racing the same CAS wins", async () => {
    const repo = new InMemoryAppointmentRepository();
    const a = await repo.create({ ...BASE, status: "BOOKED" });

    const [r1, r2] = await Promise.all([
      repo.claimTransition(a.id, "BOOKED", "CANCELLED"),
      repo.claimTransition(a.id, "BOOKED", "CANCELLED"),
    ]);

    const results = [r1, r2];
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect((await repo.findById(a.id))?.status).toBe("CANCELLED");
  });
});
