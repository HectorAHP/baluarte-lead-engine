import { describe, it, expect } from "vitest";
import { HumanHandoffRecoveryService, HANDOFF_MANUALLY_RECOVERED_EVENT_TYPE } from "../src/application/human-handoff-recovery-service.js";
import {
  InMemoryLeadRepository, InMemoryAppointmentRepository, InMemoryLeadStatusHistoryRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import type { Lead, LeadStatus } from "../src/domain/lead.js";

/**
 * Fase 7E -- HumanHandoffRecoveryService, the decision logic behind
 * POST /api/leads/:id/recover-handoff. Deliberately does NOT reproduce leadIdLast8 5060d's real
 * data (no production data used anywhere in this file) -- see item 14 of the Fase 7E task: the
 * fixture below reconstructs the SHAPE of that real incident (3 historical exhausted offer rounds,
 * a past BOOKED appointment, escalated via the same BOOKING_INCONSISTENCY_HANDOFF event type) with
 * entirely synthetic ids/dates.
 */
function makeService() {
  const leads = new InMemoryLeadRepository();
  const appointments = new InMemoryAppointmentRepository();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const logger = new FakeLogger();
  const service = new HumanHandoffRecoveryService({ leads, appointments, leadStatusHistory, logger });
  return { leads, appointments, leadStatusHistory, logger, service };
}

async function seedHandoffLead(leads: InMemoryLeadRepository, overrides: Partial<Lead> = {}): Promise<Lead> {
  const created = await leads.create({
    country: "MX", productVertical: "PATRIMONIAL", status: "BOOKED", score: 74, scoreClass: "A",
    assignedAdvisor: "Hector Herrera", consentContact: true,
    ...overrides,
  });
  return leads.update(created.id, { status: "HUMAN_HANDOFF" });
}

const NOW = new Date("2027-01-01T00:00:00.000Z");

describe("HumanHandoffRecoveryService", () => {
  // ---------------------------------------------------------------------------------------
  // Fase 7E §17 item 1 -- appointment futuro válido -> BOOKED
  // ---------------------------------------------------------------------------------------
  it("item 1: HUMAN_HANDOFF + future valid appointment -> BOOKED, never CONFIRMED", async () => {
    const { leads, appointments, leadStatusHistory, service } = makeService();
    const lead = await seedHandoffLead(leads);
    const future = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    await appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: future, endsAt: new Date(future.getTime() + 30 * 60 * 1000), timezone: "America/Mexico_City" });

    const result = await service.recover(lead.id, NOW);

    expect(result).toMatchObject({ outcome: "RECOVERED", previousStatus: "HUMAN_HANDOFF", toStatus: "BOOKED", resolvedAppointmentState: "FUTURE" });
    expect((await leads.findById(lead.id))?.status).toBe("BOOKED");
    const history = await leadStatusHistory.listByLeadId(lead.id);
    const last = history[history.length - 1];
    expect(last.eventType).toBe(HANDOFF_MANUALLY_RECOVERED_EVENT_TYPE);
    expect(last.toStatus).toBe("BOOKED");
    expect(last.metadata).toMatchObject({ resolvedAppointmentState: "FUTURE", previousStatus: "HUMAN_HANDOFF" });
  });

  // ---------------------------------------------------------------------------------------
  // item 2 -- appointment pasado -> BOOKING_PENDING (re-entra al flujo existente)
  // ---------------------------------------------------------------------------------------
  it("item 2: HUMAN_HANDOFF + past appointment -> BOOKING_PENDING (reconstructs the real incident's shape)", async () => {
    const { leads, appointments, service } = makeService();
    const lead = await seedHandoffLead(leads);
    const past = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    await appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: past, endsAt: new Date(past.getTime() + 30 * 60 * 1000), timezone: "America/Mexico_City" });

    const result = await service.recover(lead.id, NOW);

    expect(result).toMatchObject({ outcome: "RECOVERED", toStatus: "BOOKING_PENDING", resolvedAppointmentState: "PAST" });
    expect((await leads.findById(lead.id))?.status).toBe("BOOKING_PENDING");
  });

  // ---------------------------------------------------------------------------------------
  // item 3 -- sin appointment + historial de calificación -> QUALIFIED_A/B correcto
  // ---------------------------------------------------------------------------------------
  it("item 3: HUMAN_HANDOFF + no appointment + scoreClass A on file -> QUALIFIED_A (never QUALIFYING)", async () => {
    const { leads, service } = makeService();
    const lead = await seedHandoffLead(leads, { scoreClass: "A" });

    const result = await service.recover(lead.id, NOW);

    expect(result).toMatchObject({ outcome: "RECOVERED", toStatus: "QUALIFIED_A", resolvedAppointmentState: "NONE" });
  });

  it("item 3b: scoreClass B -> QUALIFIED_B", async () => {
    const { leads, service } = makeService();
    const lead = await seedHandoffLead(leads, { scoreClass: "B" });
    const result = await service.recover(lead.id, NOW);
    expect(result).toMatchObject({ outcome: "RECOVERED", toStatus: "QUALIFIED_B" });
  });

  it("item 3c: scoreClass C -> NURTURE_C (the lead's own true persisted tier, never collapsed to CONTACTED)", async () => {
    const { leads, service } = makeService();
    const lead = await seedHandoffLead(leads, { scoreClass: "C" });
    const result = await service.recover(lead.id, NOW);
    expect(result).toMatchObject({ outcome: "RECOVERED", toStatus: "NURTURE_C" });
  });

  it("item 3d: no scoreClass at all (never qualified) -> CONTACTED, never QUALIFYING", async () => {
    const { leads, service } = makeService();
    const lead = await seedHandoffLead(leads, { scoreClass: undefined });
    const result = await service.recover(lead.id, NOW);
    expect(result).toMatchObject({ outcome: "RECOVERED", toStatus: "CONTACTED" });
  });

  // ---------------------------------------------------------------------------------------
  // item 4 -- multiple ambiguous appointments -> no recovery, 409 equivalent
  // ---------------------------------------------------------------------------------------
  it("item 4: multiple active (BOOKED) appointments -> AMBIGUOUS, never guessed, never recovered", async () => {
    const { leads, appointments, leadStatusHistory, service } = makeService();
    const lead = await seedHandoffLead(leads);
    const futureA = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const futureB = new Date(NOW.getTime() + 48 * 60 * 60 * 1000); // distinct slot -- avoids the calendar-level overlap guard, which is unrelated to this per-lead ambiguity check
    await appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: futureA, endsAt: new Date(futureA.getTime() + 1800_000), timezone: "America/Mexico_City" });
    await appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: futureB, endsAt: new Date(futureB.getTime() + 1800_000), timezone: "America/Mexico_City" });

    const result = await service.recover(lead.id, NOW);

    expect(result).toMatchObject({ outcome: "AMBIGUOUS", activeAppointmentCount: 2 });
    expect((await leads.findById(lead.id))?.status).toBe("HUMAN_HANDOFF"); // untouched
    expect(await leadStatusHistory.listByLeadId(lead.id)).toHaveLength(0); // no history written
  });

  // ---------------------------------------------------------------------------------------
  // item 5 -- DO_NOT_CONTACT nunca recuperado
  // ---------------------------------------------------------------------------------------
  it("item 5: DO_NOT_CONTACT is never recoverable by this service, under any circumstance", async () => {
    const { leads, service } = makeService();
    const created = await leads.create({ country: "MX", productVertical: "PATRIMONIAL", status: "BOOKED", score: 0, assignedAdvisor: "Hector Herrera", consentContact: true });
    const lead = await leads.update(created.id, { status: "DO_NOT_CONTACT" });

    const result = await service.recover(lead.id, NOW);

    expect(result).toMatchObject({ outcome: "NOT_ELIGIBLE", currentStatus: "DO_NOT_CONTACT" });
    expect((await leads.findById(lead.id))?.status).toBe("DO_NOT_CONTACT"); // untouched
  });

  // ---------------------------------------------------------------------------------------
  // item 6 -- status distinto de HUMAN_HANDOFF (nunca lo fue) -> NOT_ELIGIBLE
  // ---------------------------------------------------------------------------------------
  it("item 6: a lead that was never HUMAN_HANDOFF -> NOT_ELIGIBLE, untouched", async () => {
    const { leads, service } = makeService();
    const lead = await leads.create({ country: "MX", productVertical: "PATRIMONIAL", status: "QUALIFIED_A", score: 74, scoreClass: "A", assignedAdvisor: "Hector Herrera", consentContact: true });

    const result = await service.recover(lead.id, NOW);

    expect(result).toMatchObject({ outcome: "NOT_ELIGIBLE", currentStatus: "QUALIFIED_A" });
  });

  it("a nonexistent lead id -> NOT_FOUND", async () => {
    const { service } = makeService();
    const result = await service.recover("00000000-0000-0000-0000-000000000000", NOW);
    expect(result).toEqual({ outcome: "NOT_FOUND" });
  });

  // ---------------------------------------------------------------------------------------
  // item 7 -- duplicate recovery -> idempotente
  // ---------------------------------------------------------------------------------------
  it("item 7: calling recover() twice is idempotent -- second call is ALREADY_RECOVERED, no new write", async () => {
    const { leads, leadStatusHistory, service } = makeService();
    const lead = await seedHandoffLead(leads, { scoreClass: "A" });

    const first = await service.recover(lead.id, NOW);
    expect(first.outcome).toBe("RECOVERED");
    const second = await service.recover(lead.id, NOW);

    expect(second).toMatchObject({ outcome: "ALREADY_RECOVERED" });
    // item 9: HANDOFF_MANUALLY_RECOVERED written exactly once
    const history = await leadStatusHistory.listByLeadId(lead.id);
    expect(history.filter((h) => h.eventType === HANDOFF_MANUALLY_RECOVERED_EVENT_TYPE)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------------------
  // item 8 -- history preservado (BOOKING_INCONSISTENCY_HANDOFF intacto, evento nuevo después)
  // ---------------------------------------------------------------------------------------
  it("item 8/15: prior history (BOOKING_INCONSISTENCY_HANDOFF) is preserved intact -- HANDOFF_MANUALLY_RECOVERED is appended, never rewrites it", async () => {
    const { leads, leadStatusHistory, service } = makeService();
    const lead = await seedHandoffLead(leads, { scoreClass: "A" });
    // Simulate the real escalation history entry that led to HUMAN_HANDOFF, exactly as
    // booking-outcome-dispatch.ts's escalateToHuman would have written it.
    await leadStatusHistory.create({ leadId: lead.id, fromStatus: "BOOKED", toStatus: "HUMAN_HANDOFF", eventType: "BOOKING_INCONSISTENCY_HANDOFF", metadata: {} });

    await service.recover(lead.id, NOW);

    const history = await leadStatusHistory.listByLeadId(lead.id);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ eventType: "BOOKING_INCONSISTENCY_HANDOFF", fromStatus: "BOOKED", toStatus: "HUMAN_HANDOFF" });
    expect(history[1]).toMatchObject({ eventType: HANDOFF_MANUALLY_RECOVERED_EVENT_TYPE, fromStatus: "HUMAN_HANDOFF" });
    // timestamps preserved -- the first row's createdAt never changes
    expect(history[1].createdAt.getTime()).toBeGreaterThanOrEqual(history[0].createdAt.getTime());
  });

  // ---------------------------------------------------------------------------------------
  // item 14 -- reproduce el CASO REAL 5060d, con datos enteramente sintéticos
  // ---------------------------------------------------------------------------------------
  it("item 14: reproduces the real incident's shape (3 historical exhausted rounds, past appointment, BOOKING_INCONSISTENCY_HANDOFF) -> recovers to BOOKING_PENDING", async () => {
    const { leads, appointments, leadStatusHistory, service } = makeService();
    // Synthetic lead, synthetic dates -- NOT leadIdLast8 5060d, NOT any real id/timestamp.
    const lead = await seedHandoffLead(leads, { scoreClass: "A" });
    const bookedAt = new Date(NOW.getTime() - 20 * 60 * 60 * 1000); // booked 20h before "now"
    await appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: bookedAt, endsAt: new Date(bookedAt.getTime() + 30 * 60 * 1000), timezone: "America/Mexico_City" });
    // The real incident's own history: QUALIFICATION_SCORED -> ... -> BOOKING_CONFIRMED -> BOOKING_INCONSISTENCY_HANDOFF.
    // Reconstructed here only as the two entries that matter for this service's own logic.
    await leadStatusHistory.create({ leadId: lead.id, fromStatus: "BOOKING_PENDING", toStatus: "BOOKED", eventType: "BOOKING_CONFIRMED", metadata: {} });
    await leadStatusHistory.create({ leadId: lead.id, fromStatus: "BOOKED", toStatus: "HUMAN_HANDOFF", eventType: "BOOKING_INCONSISTENCY_HANDOFF", metadata: {} });

    const result = await service.recover(lead.id, NOW);

    expect(result).toMatchObject({ outcome: "RECOVERED", toStatus: "BOOKING_PENDING", resolvedAppointmentState: "PAST" });
    const history = await leadStatusHistory.listByLeadId(lead.id);
    expect(history.map((h) => h.eventType)).toEqual(["BOOKING_CONFIRMED", "BOOKING_INCONSISTENCY_HANDOFF", HANDOFF_MANUALLY_RECOVERED_EVENT_TYPE]);
  });

  // ---------------------------------------------------------------------------------------
  // Additional state-machine safety net
  // ---------------------------------------------------------------------------------------
  it("never produces a status the state machine rejects -- assertTransition is never bypassed", async () => {
    // This is a structural guarantee, not a specific scenario: every branch of recover() computes
    // a `toStatus` that Fase 7E's own state-machine additions (HUMAN_HANDOFF -> BOOKED/
    // QUALIFIED_A/QUALIFIED_B/NURTURE_C/BOOKING_PENDING) already allow -- if any of those edges
    // were ever removed, this test (and every other RECOVERED-outcome test above) would start
    // throwing InvalidLeadTransitionError instead of returning RECOVERED.
    const { leads, service } = makeService();
    const scoreClasses: Array<"A" | "B" | "C" | undefined> = ["A", "B", "C", undefined];
    for (const scoreClass of scoreClasses) {
      const lead = await seedHandoffLead(leads, { scoreClass });
      await expect(service.recover(lead.id, NOW)).resolves.toMatchObject({ outcome: "RECOVERED" });
    }
  });
});
