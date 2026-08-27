import { describe, it, expect } from "vitest";
import { LeadService, AppointmentService } from "../src/application/services.js";
import { SlotOfferingService } from "../src/application/slot-offering-service.js";
import { markLeadBooked } from "../src/application/booking-outcome-dispatch.js";
import {
  InMemoryLeadRepository, InMemoryLeadScoreRepository, InMemoryLeadStatusHistoryRepository,
  InMemoryAppointmentStatusHistoryRepository, InMemoryAppointmentRepository, InMemoryBookingAttemptRepository,
  InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";
import type { Lead } from "../src/domain/lead.js";

/**
 * Phase 4A, requirement §7: the existing Phase 3C E2E (qualification -> BOOKING_PENDING ->
 * BOOKED) must keep behaving identically AND must now also produce correct lead_status_history.
 * Exercises the real choke points (LeadService.transitionTo, SlotOfferingService.
 * ensureBookingPending, booking-outcome-dispatch.markLeadBooked) directly with real in-memory
 * repositories -- not a re-test of the conversational qualifier engine (covered elsewhere), only
 * of the audit trail these already-existing status-changing calls now produce.
 */
describe("Phase 4A: lead_status_history across the real Phase 3C booking lifecycle", () => {
  it("produces the exact expected sequence, and forces NO artificial appointment_status_history for a freshly-created appointment", async () => {
    const leads = new InMemoryLeadRepository();
    const leadScores = new InMemoryLeadScoreRepository();
    const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
    const appointmentStatusHistory = new InMemoryAppointmentStatusHistoryRepository();
    const appointments = new InMemoryAppointmentRepository();
    const bookingAttempts = new InMemoryBookingAttemptRepository();
    const offeredSlots = new InMemoryOfferedSlotRepository();
    const slotOfferClaims = new InMemorySlotOfferClaimRepository();
    const calendar = new FakeCalendarProvider();
    const logger = new FakeLogger();

    const leadService = new LeadService(leads, leadScores, leadStatusHistory, logger);
    const slotOffering = new SlotOfferingService(calendar, offeredSlots, appointments, leads, slotOfferClaims, leadStatusHistory, logger);
    const appointmentService = new AppointmentService(calendar, appointments, bookingAttempts, leads, logger);

    // 1-3: NEW -> CONTACTED -> QUALIFYING (mirrors handleInboundWhatsAppText's real sequence).
    let lead = await leadService.createLead({ firstName: "Ana", productVertical: "GMM" });
    lead = await leadService.markContacted(lead.id);
    lead = await leadService.startQualification(lead.id);

    // 4: QUALIFYING -> QUALIFIED_B (mirrors WhatsAppQualificationHandler.applyOutcome's
    // QUALIFICATION_COMPLETE branch calling leadService.applyQualificationScore).
    lead = await leadService.applyQualificationScore(lead.id, {
      vertical: "GMM", total: 71, scoreClass: "B", breakdown: { total: 71 }, rulesVersion: "TEST_V1",
    });
    expect(lead.status).toBe("QUALIFIED_B");

    // 5: QUALIFIED_B -> BOOKING_PENDING (mirrors the qualification-complete -> slot-offer wiring).
    const conversationId = "conv-1";
    const now = new Date("2026-03-01T09:00:00.000Z");
    const offerOutcome = await slotOffering.getOrCreateOffer({ lead, conversationId, now });
    if (offerOutcome.type !== "CREATED") throw new Error(`unreachable: ${offerOutcome.type}`);
    lead = offerOutcome.lead;
    expect(lead.status).toBe("BOOKING_PENDING");

    // 6: appointment created directly as BOOKED (mirrors AppointmentService.completeBooking) --
    // no appointment_status_history row should ever be forced here (see §7 -- "NO fuerces una
    // historia artificial si la fila nace directamente en BOOKED").
    const slot = offerOutcome.slots[0];
    const appointment = await appointmentService.book(
      { leadId: lead.id, title: "Cita", description: "", start: slot.slotStart, end: slot.slotEnd, timezone: "America/Mexico_City" },
      `test-idempotency-key:${lead.id}`,
    );
    expect(appointment.status).toBe("BOOKED");

    // 7: BOOKING_PENDING -> BOOKED (mirrors WhatsAppBookingHandler.handleSelection calling
    // markLeadBooked).
    lead = await markLeadBooked({ leads, leadStatusHistory, logger }, lead, appointment);
    expect(lead.status).toBe("BOOKED");

    // --- lead_status_history assertions -----------------------------------------------------
    const history = await leadStatusHistory.listByLeadId(lead.id);
    expect(history.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      ["NEW", "CONTACTED"],
      ["CONTACTED", "QUALIFYING"],
      ["QUALIFYING", "QUALIFIED_B"],
      ["QUALIFIED_B", "BOOKING_PENDING"],
      ["BOOKING_PENDING", "BOOKED"],
    ]);
    expect(history.map((h) => h.eventType)).toEqual([
      "LEAD_CONTACTED", "QUALIFICATION_STARTED", "QUALIFICATION_SCORED", "BOOKING_OFFER_STARTED", "BOOKING_CONFIRMED",
    ]);

    // --- appointment_status_history assertion: none forced on creation -----------------------
    expect(await appointmentStatusHistory.listByAppointmentId(appointment.id)).toEqual([]);
  });

  it("markLeadBooked idempotent retry (appointment already exists) never writes a second lead_status_history row", async () => {
    const leads = new InMemoryLeadRepository();
    const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
    const logger = new FakeLogger();
    const appointments = new InMemoryAppointmentRepository();

    let lead: Lead = await leads.create({
      country: "MX", productVertical: "GMM", status: "BOOKING_PENDING", score: 71,
      assignedAdvisor: "Hector Herrera", consentContact: true,
    });
    const appointment = await appointments.create({ leadId: lead.id, status: "BOOKED", startsAt: new Date("2026-03-02T15:00:00.000Z"), endsAt: new Date("2026-03-02T15:30:00.000Z"), timezone: "America/Mexico_City" });

    lead = await markLeadBooked({ leads, leadStatusHistory, logger }, lead, appointment);
    expect((await leadStatusHistory.listByLeadId(lead.id))).toHaveLength(1);

    // A second, reprocessed call (e.g. a duplicate webhook) with the now-BOOKED lead snapshot:
    // fully idempotent no-op (patch is empty), must never write a second history row.
    const again = await markLeadBooked({ leads, leadStatusHistory, logger }, lead, appointment);
    expect(again.status).toBe("BOOKED");
    expect((await leadStatusHistory.listByLeadId(lead.id))).toHaveLength(1);
  });
});
