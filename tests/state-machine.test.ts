import { describe, expect, it } from "vitest";
import { canTransition, assertTransition } from "../src/domain/state-machine.js";

describe("lead state machine", () => {
  it("allows", () => expect(canTransition("QUALIFYING", "QUALIFIED_A")).toBe(true));
  it("blocks", () => {
    expect(canTransition("NEW", "CLOSED_WON")).toBe(false);
    expect(() => assertTransition("NEW", "CLOSED_WON")).toThrow();
  });
});

// Phase 4A: the state machine already contained RESCHEDULE_REQUESTED/NO_SHOW/MEETING_COMPLETED
// (unused until now) -- these tests cover only the transitions actually added or corrected in
// this block. See docs/PHASE4-DESIGN.md §3.2 for the design rationale.
describe("lead state machine -- Phase 4A additions", () => {
  it("BOOKED -> CANCEL_PENDING is allowed (cancellation entry point)", () => {
    expect(canTransition("BOOKED", "CANCEL_PENDING")).toBe(true);
  });

  it("CONFIRMED -> CANCEL_PENDING is allowed (consistency with BOOKED)", () => {
    expect(canTransition("CONFIRMED", "CANCEL_PENDING")).toBe(true);
  });

  it("CANCEL_PENDING -> CANCELLED is allowed (lead confirms cancellation)", () => {
    expect(canTransition("CANCEL_PENDING", "CANCELLED")).toBe(true);
  });

  it("CANCEL_PENDING -> BOOKED is allowed (lead declines / ambiguous reply / timeout -- never auto-cancels)", () => {
    expect(canTransition("CANCEL_PENDING", "BOOKED")).toBe(true);
  });

  it("CANCEL_PENDING -> HUMAN_HANDOFF and -> DO_NOT_CONTACT are allowed (same escape valves as every other awaiting state)", () => {
    expect(canTransition("CANCEL_PENDING", "HUMAN_HANDOFF")).toBe(true);
    expect(canTransition("CANCEL_PENDING", "DO_NOT_CONTACT")).toBe(true);
  });

  it("CANCELLED -> BOOKING_PENDING is allowed (a cancelled lead can come back later, same principle as NO_SHOW)", () => {
    expect(canTransition("CANCELLED", "BOOKING_PENDING")).toBe(true);
  });

  it("CANCELLED -> HUMAN_HANDOFF and -> DO_NOT_CONTACT are allowed", () => {
    expect(canTransition("CANCELLED", "HUMAN_HANDOFF")).toBe(true);
    expect(canTransition("CANCELLED", "DO_NOT_CONTACT")).toBe(true);
  });

  it("CANCELLED is terminal otherwise -- no direct path back to BOOKED or CANCEL_PENDING", () => {
    expect(canTransition("CANCELLED", "BOOKED")).toBe(false);
    expect(canTransition("CANCELLED", "CANCEL_PENDING")).toBe(false);
  });

  it("RESCHEDULE_REQUESTED -> HUMAN_HANDOFF is now allowed (was missing -- a data-consistency error during reschedule had nowhere to escalate)", () => {
    expect(canTransition("RESCHEDULE_REQUESTED", "HUMAN_HANDOFF")).toBe(true);
  });

  it("RESCHEDULE_REQUESTED -> BOOKED and -> DO_NOT_CONTACT are still allowed (unchanged from before this block)", () => {
    expect(canTransition("RESCHEDULE_REQUESTED", "BOOKED")).toBe(true);
    expect(canTransition("RESCHEDULE_REQUESTED", "DO_NOT_CONTACT")).toBe(true);
  });

  it("no other lead status can jump directly to CANCEL_PENDING or CANCELLED (only BOOKED/CONFIRMED can enter cancellation)", () => {
    expect(canTransition("QUALIFIED_A", "CANCEL_PENDING")).toBe(false);
    expect(canTransition("BOOKING_PENDING", "CANCEL_PENDING")).toBe(false);
    expect(canTransition("NURTURE_C", "CANCELLED")).toBe(false);
  });

  it("assertTransition throws InvalidLeadTransitionError for every disallowed Phase 4A edge, and not for allowed ones", () => {
    expect(() => assertTransition("BOOKED", "CANCEL_PENDING")).not.toThrow();
    expect(() => assertTransition("CANCEL_PENDING", "CANCELLED")).not.toThrow();
    expect(() => assertTransition("CANCELLED", "BOOKING_PENDING")).not.toThrow();
    expect(() => assertTransition("RESCHEDULE_REQUESTED", "HUMAN_HANDOFF")).not.toThrow();
    expect(() => assertTransition("CANCELLED", "QUALIFIED_A")).toThrow();
  });
});
