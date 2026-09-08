import { describe, it, expect } from "vitest";
import {
  daypartQuestionMetadata,
  bookingCommitmentMetadata,
  resolvePendingBookingFlowState,
} from "../src/domain/booking-flow-state.js";
import type { Message } from "../src/domain/message.js";

function outbound(metadata: Record<string, unknown>): Message {
  return {
    id: "m1",
    conversationId: "c1",
    leadId: "l1",
    direction: "OUTBOUND",
    channel: "WHATSAPP",
    aiGenerated: true,
    metadata,
    createdAt: new Date(),
  };
}

describe("booking-flow-state (Fase 7K sections 5/13/38)", () => {
  it("1. resolves null with no messages", () => {
    expect(resolvePendingBookingFlowState([])).toBeNull();
  });

  it("2. resolves DAYPART from a marked outbound message", () => {
    const msgs = [outbound(daypartQuestionMetadata({ mode: "BOOKING", offerAction: "NEW" }))];
    const state = resolvePendingBookingFlowState(msgs);
    expect(state).toEqual({ type: "DAYPART", data: { mode: "BOOKING", offerAction: "NEW" } });
  });

  it("3. DAYPART preserves targetDate/weekday already known before the question was asked", () => {
    const msgs = [outbound(daypartQuestionMetadata({ mode: "BOOKING", targetDate: "2026-09-12", offerAction: "NEW" }))];
    const state = resolvePendingBookingFlowState(msgs);
    expect(state?.data).toEqual({ mode: "BOOKING", targetDate: "2026-09-12", offerAction: "NEW" });
  });

  it("4. DAYPART preserves mode RESCHEDULE + oldAppointmentId", () => {
    const msgs = [outbound(daypartQuestionMetadata({ mode: "RESCHEDULE", oldAppointmentId: "appt-1", offerAction: "NEW" }))];
    const state = resolvePendingBookingFlowState(msgs);
    expect(state).toEqual({ type: "DAYPART", data: { mode: "RESCHEDULE", oldAppointmentId: "appt-1", offerAction: "NEW" } });
  });

  it("5. resolves COMMITMENT from a marked outbound message with full payload", () => {
    const payload = {
      selectedSlotId: "slot-1",
      slotStart: "2026-09-10T16:30:00.000Z",
      slotEnd: "2026-09-10T17:00:00.000Z",
      slotOfferRoundId: "round-1",
      mode: "BOOKING" as const,
      timestamp: "2026-09-08T12:00:00.000Z",
      clarificationAsked: false,
      daypart: "MORNING" as const,
    };
    const msgs = [outbound(bookingCommitmentMetadata(payload))];
    const state = resolvePendingBookingFlowState(msgs);
    expect(state).toEqual({ type: "COMMITMENT", data: payload });
  });

  it("6. COMMITMENT preserves oldAppointmentId for a reschedule episode", () => {
    const payload = {
      selectedSlotId: "slot-1",
      slotStart: "2026-09-10T16:30:00.000Z",
      slotEnd: "2026-09-10T17:00:00.000Z",
      slotOfferRoundId: "round-1",
      mode: "RESCHEDULE" as const,
      oldAppointmentId: "appt-old",
      timestamp: "2026-09-08T12:00:00.000Z",
      clarificationAsked: true,
      daypart: "AFTERNOON" as const,
    };
    const msgs = [outbound(bookingCommitmentMetadata(payload))];
    const state = resolvePendingBookingFlowState(msgs);
    expect(state).toEqual({ type: "COMMITMENT", data: payload });
  });

  it("7. returns null for an unrelated marker (e.g. the qualified-menu namespace)", () => {
    const msgs = [outbound({ expectedIntent: "QUALIFIED_MAIN_MENU" })];
    expect(resolvePendingBookingFlowState(msgs)).toBeNull();
  });

  it("8. returns null for empty metadata", () => {
    const msgs = [outbound({})];
    expect(resolvePendingBookingFlowState(msgs)).toBeNull();
  });

  it("9. only looks at the LAST outbound message, not an earlier one", () => {
    const msgs = [
      outbound(daypartQuestionMetadata({ mode: "BOOKING", offerAction: "NEW" })),
      outbound({ expectedIntent: "QUALIFIED_MAIN_MENU" }),
    ];
    expect(resolvePendingBookingFlowState(msgs)).toBeNull();
  });

  it("10. malformed COMMITMENT payload (missing required field) resolves to null, never a guess", () => {
    const msgs = [
      outbound({
        expectedIntent: "AWAITING_BOOKING_COMMITMENT",
        selectedSlotId: "slot-1",
        // slotStart missing
        slotEnd: "2026-09-10T17:00:00.000Z",
        slotOfferRoundId: "round-1",
        mode: "BOOKING",
        timestamp: "2026-09-08T12:00:00.000Z",
        clarificationAsked: false,
        daypart: "MORNING",
      }),
    ];
    expect(resolvePendingBookingFlowState(msgs)).toBeNull();
  });

  it("11. malformed DAYPART payload (invalid mode) resolves to null", () => {
    const msgs = [outbound({ expectedIntent: "AWAITING_DAYPART_PREFERENCE", mode: "BOGUS", offerAction: "NEW" })];
    expect(resolvePendingBookingFlowState(msgs)).toBeNull();
  });

  it("12. ignores INBOUND messages entirely when looking for the last outbound", () => {
    const outboundMsg = outbound(daypartQuestionMetadata({ mode: "BOOKING", offerAction: "NEW" }));
    const inboundMsg: Message = { ...outboundMsg, id: "m2", direction: "INBOUND", metadata: {} };
    expect(resolvePendingBookingFlowState([outboundMsg, inboundMsg])).toEqual({
      type: "DAYPART",
      data: { mode: "BOOKING", offerAction: "NEW" },
    });
  });

  it("13. COMMITMENT payload with an invalid daypart value resolves to null", () => {
    const msgs = [
      outbound({
        expectedIntent: "AWAITING_BOOKING_COMMITMENT",
        selectedSlotId: "slot-1",
        slotStart: "2026-09-10T16:30:00.000Z",
        slotEnd: "2026-09-10T17:00:00.000Z",
        slotOfferRoundId: "round-1",
        mode: "BOOKING",
        timestamp: "2026-09-08T12:00:00.000Z",
        clarificationAsked: false,
        daypart: "NIGHT",
      }),
    ];
    expect(resolvePendingBookingFlowState(msgs)).toBeNull();
  });

  it("14. DAYPART payload missing offerAction resolves to null (never guesses NEW vs REPLACE)", () => {
    const msgs = [outbound({ expectedIntent: "AWAITING_DAYPART_PREFERENCE", mode: "BOOKING" })];
    expect(resolvePendingBookingFlowState(msgs)).toBeNull();
  });

  it("15. DAYPART preserves offerAction REPLACE for a mid-round preference change", () => {
    const msgs = [outbound(daypartQuestionMetadata({ mode: "BOOKING", offerAction: "REPLACE" }))];
    const state = resolvePendingBookingFlowState(msgs);
    expect(state?.data).toMatchObject({ offerAction: "REPLACE" });
  });
});
