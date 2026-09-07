import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseArgs, planRepair, applyTargets, classify,
  type AppointmentRow, type RepairIO, type ClassifiedRow,
} from "../scripts/repair-orphaned-appointments.js";

/**
 * Fase 7H.1 -- targeted, fail-closed execution of the orphaned-appointment repair tool. This file
 * never touches a network or a real database: makeIO() below is a plain in-memory RepairIO fake,
 * same pattern as every other in-memory repository fake in this codebase (see
 * src/infrastructure/memory-repositories.ts) -- the tool's planning/apply logic is exercised
 * exactly as the CLI would drive it, minus the real Supabase calls.
 */

const NOW = new Date("2026-09-10T00:00:00.000Z");
const PAST_START = new Date("2026-09-03T16:00:00.000Z");
const PAST_END = new Date("2026-09-03T16:30:00.000Z");
const FUTURE_START = new Date("2026-09-15T15:00:00.000Z");
const FUTURE_END = new Date("2026-09-15T15:30:00.000Z");

function row(overrides: Partial<AppointmentRow> & { lead_id: string }): AppointmentRow {
  return {
    id: overrides.id ?? randomUUID(),
    lead_id: overrides.lead_id,
    status: overrides.status ?? "BOOKED",
    starts_at: overrides.starts_at ?? PAST_START.toISOString(),
    ends_at: overrides.ends_at ?? PAST_END.toISOString(),
    calendar_event_id: overrides.calendar_event_id ?? "real-calendar-event",
    created_at: overrides.created_at ?? PAST_START.toISOString(),
  };
}

function makeIO(seed: AppointmentRow[]) {
  const data = new Map<string, AppointmentRow>(seed.map((r) => [r.id, r]));
  const history: Array<{ appointment_id: string; lead_id: string; from_status: string; to_status: string; event_type: string; metadata: Record<string, unknown> }> = [];
  const io: RepairIO = {
    async getAllBooked() {
      return [...data.values()].filter((r) => r.status === "BOOKED");
    },
    async getAppointmentsForLead(leadId: string) {
      return [...data.values()].filter((r) => r.lead_id === leadId);
    },
    async getAppointment(id: string) {
      return data.get(id) ?? null;
    },
    async claimTransition(id: string, expectedStatus: string, nextStatus: string) {
      const current = data.get(id);
      if (!current || current.status !== expectedStatus) return false;
      data.set(id, { ...current, status: nextStatus });
      return true;
    },
    async insertHistory(entry) {
      history.push(entry);
    },
  };
  return { io, data, history };
}

describe("Fase 7H.1 -- parseArgs fail-closed behavior", () => {
  it("item 1: --apply with no --lead-id/--appointment-id is REJECTED", () => {
    const result = parseArgs(["--apply"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/requires --lead-id or --appointment-id/);
  });

  it("item 2: an invalid UUID for --lead-id or --appointment-id is REJECTED", () => {
    const a = parseArgs(["--apply", "--lead-id", "not-a-uuid"]);
    expect(a.ok).toBe(false);
    const b = parseArgs(["--dry-run", "--appointment-id", "also-not-a-uuid"]);
    expect(b.ok).toBe(false);
  });

  it("accepts --dry-run with a valid --lead-id or --appointment-id", () => {
    const leadId = randomUUID();
    const a = parseArgs(["--dry-run", "--lead-id", leadId]);
    expect(a.ok).toBe(true);
    const appointmentId = randomUUID();
    const b = parseArgs(["--dry-run", "--appointment-id", appointmentId]);
    expect(b.ok).toBe(true);
  });

  it("accepts --apply with a valid --appointment-id or --lead-id", () => {
    const a = parseArgs(["--apply", "--appointment-id", randomUUID()]);
    expect(a.ok).toBe(true);
    const b = parseArgs(["--apply", "--lead-id", randomUUID()]);
    expect(b.ok).toBe(true);
  });

  it("no flags at all defaults to dry-run, unfiltered", () => {
    const result = parseArgs([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args).toEqual({ mode: "dry-run", leadId: undefined, appointmentId: undefined });
  });
});

describe("Fase 7H.1 -- planRepair + applyTargets: targeted, fail-closed writes", () => {
  it("item 3: --appointment-id targeting a SAFE_TO_EXPIRE appointment expires ONLY that one", async () => {
    const leadId = randomUUID();
    const stale = row({ lead_id: leadId, id: "aaaaaaaa-0000-0000-0000-000000000001" });
    const replacement = row({ lead_id: leadId, id: "aaaaaaaa-0000-0000-0000-000000000002", starts_at: FUTURE_START.toISOString(), ends_at: FUTURE_END.toISOString() });
    const { io, data, history } = makeIO([stale, replacement]);

    const parsed = parseArgs(["--apply", "--appointment-id", stale.id]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plan = await planRepair(parsed.args, io, NOW);
    expect(plan.kind).toBe("PLAN");
    if (plan.kind !== "PLAN") return;
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0].appointment.id).toBe(stale.id);

    const outcomes = await applyTargets(plan.targets, io, NOW);
    expect(outcomes).toEqual([{ appointmentId: stale.id, result: "EXPIRED" }]);
    expect(data.get(stale.id)?.status).toBe("EXPIRED");
    expect(history).toHaveLength(1);
  });

  it("item 4: a DIFFERENT SAFE_TO_EXPIRE appointment elsewhere is never touched by an --appointment-id-scoped apply", async () => {
    const leadA = randomUUID();
    const leadB = randomUUID();
    const staleA = row({ lead_id: leadA, id: "bbbbbbbb-0000-0000-0000-000000000001" });
    const replacementA = row({ lead_id: leadA, id: "bbbbbbbb-0000-0000-0000-000000000002", starts_at: FUTURE_START.toISOString(), ends_at: FUTURE_END.toISOString() });
    // A second, ALSO-genuinely-SAFE_TO_EXPIRE orphan, belonging to a totally different lead.
    const staleB = row({ lead_id: leadB, id: "bbbbbbbb-0000-0000-0000-000000000003" });
    const replacementB = row({ lead_id: leadB, id: "bbbbbbbb-0000-0000-0000-000000000004", starts_at: FUTURE_START.toISOString(), ends_at: FUTURE_END.toISOString() });
    const { io, data } = makeIO([staleA, replacementA, staleB, replacementB]);

    const parsed = parseArgs(["--apply", "--appointment-id", staleA.id]);
    if (!parsed.ok) throw new Error("unreachable");
    const plan = await planRepair(parsed.args, io, NOW);
    if (plan.kind !== "PLAN") throw new Error("unreachable");
    await applyTargets(plan.targets, io, NOW);

    expect(data.get(staleA.id)?.status).toBe("EXPIRED");
    expect(data.get(staleB.id)?.status).toBe("BOOKED"); // untouched, even though it's also SAFE_TO_EXPIRE
  });

  it("item 5: an AMBIGUOUS appointment is REJECTED by the plan and never written", async () => {
    const leadId = randomUUID();
    // No replacement at all -- classify() resolves this to AMBIGUOUS, not SAFE_TO_EXPIRE.
    const ambiguous = row({ lead_id: leadId });
    const { io, data } = makeIO([ambiguous]);

    const parsed = parseArgs(["--apply", "--appointment-id", ambiguous.id]);
    if (!parsed.ok) throw new Error("unreachable");
    const plan = await planRepair(parsed.args, io, NOW);
    if (plan.kind !== "PLAN") throw new Error("unreachable");
    expect(plan.rows[0].classification).toBe("AMBIGUOUS");
    expect(plan.targets).toHaveLength(0);

    await applyTargets(plan.targets, io, NOW);
    expect(data.get(ambiguous.id)?.status).toBe("BOOKED"); // never written
  });

  it("item 6: a FUTURE appointment is REJECTED by the plan and never written", async () => {
    const leadId = randomUUID();
    const future = row({ lead_id: leadId, starts_at: FUTURE_START.toISOString(), ends_at: FUTURE_END.toISOString() });
    const { io, data } = makeIO([future]);

    const parsed = parseArgs(["--apply", "--appointment-id", future.id]);
    if (!parsed.ok) throw new Error("unreachable");
    const plan = await planRepair(parsed.args, io, NOW);
    if (plan.kind !== "PLAN") throw new Error("unreachable");
    expect(plan.rows[0].classification).toBe("FUTURE");
    expect(plan.targets).toHaveLength(0);

    await applyTargets(plan.targets, io, NOW);
    expect(data.get(future.id)?.status).toBe("BOOKED");
  });

  it("item 7: an already-terminal appointment (CANCELLED/COMPLETED/NO_SHOW/EXPIRED) is REJECTED by the plan and never written", async () => {
    const leadId = randomUUID();
    for (const status of ["CANCELLED", "COMPLETED", "NO_SHOW", "EXPIRED"] as const) {
      const terminal = row({ lead_id: leadId, id: randomUUID(), status });
      const { io, data } = makeIO([terminal]);
      const parsed = parseArgs(["--apply", "--appointment-id", terminal.id]);
      if (!parsed.ok) throw new Error("unreachable");
      const plan = await planRepair(parsed.args, io, NOW);
      if (plan.kind !== "PLAN") throw new Error("unreachable");
      expect(plan.rows[0].classification).toBe("ALREADY_TERMINAL");
      expect(plan.targets).toHaveLength(0);
      await applyTargets(plan.targets, io, NOW);
      expect(data.get(terminal.id)?.status).toBe(status); // untouched
    }
  });

  it("item 8: a CAS loss (status changed between planning and applying) results in no write", async () => {
    const leadId = randomUUID();
    const stale = row({ lead_id: leadId });
    const replacement = row({ lead_id: leadId, starts_at: FUTURE_START.toISOString(), ends_at: FUTURE_END.toISOString() });
    const { io, data } = makeIO([stale, replacement]);

    const parsed = parseArgs(["--apply", "--appointment-id", stale.id]);
    if (!parsed.ok) throw new Error("unreachable");
    const plan = await planRepair(parsed.args, io, NOW);
    if (plan.kind !== "PLAN") throw new Error("unreachable");
    expect(plan.targets).toHaveLength(1);

    // Simulate a concurrent change (e.g. a real cancellation) landing between planning and apply.
    data.set(stale.id, { ...data.get(stale.id)!, status: "CANCELLED" });

    const outcomes = await applyTargets(plan.targets, io, NOW);
    expect(outcomes).toEqual([{ appointmentId: stale.id, result: "SKIPPED_NO_LONGER_SAFE" }]);
    expect(data.get(stale.id)?.status).toBe("CANCELLED"); // left exactly as the concurrent change set it
  });

  it("item 9: --lead-id scope never affects a different lead's appointments, even if also SAFE_TO_EXPIRE", async () => {
    const leadA = randomUUID();
    const leadB = randomUUID();
    const staleA = row({ lead_id: leadA });
    const replacementA = row({ lead_id: leadA, starts_at: FUTURE_START.toISOString(), ends_at: FUTURE_END.toISOString() });
    const staleB = row({ lead_id: leadB });
    const replacementB = row({ lead_id: leadB, starts_at: FUTURE_START.toISOString(), ends_at: FUTURE_END.toISOString() });
    const { io, data } = makeIO([staleA, replacementA, staleB, replacementB]);

    const parsed = parseArgs(["--apply", "--lead-id", leadA]);
    if (!parsed.ok) throw new Error("unreachable");
    const plan = await planRepair(parsed.args, io, NOW);
    if (plan.kind !== "PLAN") throw new Error("unreachable");
    expect(plan.targets.map((t) => t.appointment.id)).toEqual([staleA.id]);

    await applyTargets(plan.targets, io, NOW);
    expect(data.get(staleA.id)?.status).toBe("EXPIRED");
    expect(data.get(staleB.id)?.status).toBe("BOOKED"); // a different lead -- never touched
  });

  it("item 10: --appointment-id + --lead-id mismatch is REJECTED", async () => {
    const leadA = randomUUID();
    const leadB = randomUUID();
    const appointment = row({ lead_id: leadA });
    const { io, data } = makeIO([appointment]);

    const parsed = parseArgs(["--apply", "--appointment-id", appointment.id, "--lead-id", leadB]);
    if (!parsed.ok) throw new Error("unreachable");
    const plan = await planRepair(parsed.args, io, NOW);
    expect(plan.kind).toBe("REJECTED");
    if (plan.kind === "REJECTED") expect(plan.reason).toMatch(/does not belong to lead/);
    expect(data.get(appointment.id)?.status).toBe("BOOKED"); // never touched
  });

  it("item 11: dry-run never writes, even when the target is genuinely SAFE_TO_EXPIRE", async () => {
    const leadId = randomUUID();
    const stale = row({ lead_id: leadId });
    const replacement = row({ lead_id: leadId, starts_at: FUTURE_START.toISOString(), ends_at: FUTURE_END.toISOString() });
    const { io, data } = makeIO([stale, replacement]);

    const parsed = parseArgs(["--dry-run", "--appointment-id", stale.id]);
    if (!parsed.ok) throw new Error("unreachable");
    const plan = await planRepair(parsed.args, io, NOW);
    if (plan.kind !== "PLAN") throw new Error("unreachable");
    expect(plan.targets).toHaveLength(1); // correctly identified as a target...

    // ...but the CLI never calls applyTargets() in dry-run mode -- planning alone must never write.
    expect(data.get(stale.id)?.status).toBe("BOOKED");
  });

  it("item 12: the history event for a successful repair is exactly BOOKED->EXPIRED, event_type APPOINTMENT_EXPIRED_MANUAL_REPAIR", async () => {
    const leadId = randomUUID();
    const stale = row({ lead_id: leadId });
    const replacement = row({ lead_id: leadId, starts_at: FUTURE_START.toISOString(), ends_at: FUTURE_END.toISOString() });
    const { io, history } = makeIO([stale, replacement]);

    const parsed = parseArgs(["--apply", "--appointment-id", stale.id]);
    if (!parsed.ok) throw new Error("unreachable");
    const plan = await planRepair(parsed.args, io, NOW);
    if (plan.kind !== "PLAN") throw new Error("unreachable");
    await applyTargets(plan.targets, io, NOW);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      appointment_id: stale.id, lead_id: leadId,
      from_status: "BOOKED", to_status: "EXPIRED", event_type: "APPOINTMENT_EXPIRED_MANUAL_REPAIR",
    });
    expect(history[0].event_type).not.toBe("APPOINTMENT_EXPIRED_ON_REBOOK"); // manual repair is distinguishable from the automatic path
  });

  it("item 13: RepairIO exposes no Calendar-touching method at all -- the repair can structurally never call Calendar", () => {
    // The RepairIO interface (see scripts/repair-orphaned-appointments.ts) only has
    // getAllBooked/getAppointmentsForLead/getAppointment/claimTransition/insertHistory -- no
    // deleteEvent, no createEvent, nothing Calendar-shaped. This is a structural guarantee, not
    // just a runtime one: applyTargets() has no way to reach Calendar even if it wanted to.
    const { io } = makeIO([]);
    const keys = Object.keys(io).sort();
    expect(keys).toEqual(["claimTransition", "getAllBooked", "getAppointment", "getAppointmentsForLead", "insertHistory"].sort());
  });
});

describe("Fase 7H.1 -- classify() sanity (already covered indirectly above, kept for direct regression coverage)", () => {
  it("a lone past BOOKED appointment with no siblings at all is AMBIGUOUS, never SAFE_TO_EXPIRE", () => {
    const leadId = randomUUID();
    const lone = row({ lead_id: leadId });
    const result: ClassifiedRow = classify(lone, [lone], NOW);
    expect(result.classification).toBe("AMBIGUOUS");
  });
});
