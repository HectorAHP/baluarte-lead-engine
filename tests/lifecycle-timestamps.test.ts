import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LeadService, AppointmentService } from "../src/application/services.js";
import { InMemoryLeadRepository, InMemoryLeadScoreRepository, InMemoryAppointmentRepository, InMemoryBookingAttemptRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";

describe("lifecycle timestamps", () => {
  it("sets first_contact_at on markContacted, and it stays stable afterward", async () => {
    const leads = new InMemoryLeadRepository();
    const service = new LeadService(leads, new InMemoryLeadScoreRepository());
    const lead = await service.createLead({ firstName: "Test", productVertical: "PATRIMONIAL" });
    expect(lead.firstContactAt).toBeUndefined();

    const contacted = await service.markContacted(lead.id);
    expect(contacted.firstContactAt).toBeInstanceOf(Date);
    const firstTimestamp = contacted.firstContactAt!.getTime();

    const reloaded = await leads.findById(lead.id);
    expect(reloaded?.firstContactAt?.getTime()).toBe(firstTimestamp);
  });

  it("sets qualified_at only when reaching QUALIFIED_A or QUALIFIED_B, not NURTURE_C", async () => {
    const leads = new InMemoryLeadRepository();
    const service = new LeadService(leads, new InMemoryLeadScoreRepository());
    const lead = await service.createLead({ firstName: "Test", productVertical: "PATRIMONIAL" });
    await service.markContacted(lead.id);
    await service.startQualification(lead.id);

    const nurture = await service.scorePatrimonialLead(lead.id, {
      urgency: "RESEARCHING", monthlyCapacity: "LT_3000", objectiveDefined: false, hasCurrentSavingsOrInvestment: false, acceptsMeeting: false,
    });
    expect(nurture.status).toBe("NURTURE_C");
    expect(nurture.qualifiedAt).toBeUndefined();

    await service.startQualification(lead.id);
    const qualified = await service.scorePatrimonialLead(lead.id, {
      urgency: "THIS_WEEK", monthlyCapacity: "20000_PLUS", objectiveDefined: true, hasCurrentSavingsOrInvestment: true, acceptsMeeting: true,
    });
    expect(qualified.status).toBe("QUALIFIED_A");
    expect(qualified.qualifiedAt).toBeInstanceOf(Date);
  });

  it("sets both booked_at and meeting_at (= appointment.startsAt) on the lead after a successful booking", async () => {
    const leads = new InMemoryLeadRepository();
    const leadService = new LeadService(leads, new InMemoryLeadScoreRepository());
    const lead = await leadService.createLead({ firstName: "Test", productVertical: "PATRIMONIAL" });
    expect(lead.bookedAt).toBeUndefined();
    expect(lead.meetingAt).toBeUndefined();

    const appointmentService = new AppointmentService(
      new FakeCalendarProvider(),
      new InMemoryAppointmentRepository(),
      new InMemoryBookingAttemptRepository(),
      leads,
      new FakeLogger(),
    );

    const start = new Date("2026-03-02T15:00:00.000Z");
    const appointment = await appointmentService.book(
      {
        leadId: lead.id,
        title: "Diagnostico",
        description: "test",
        start,
        end: new Date("2026-03-02T15:30:00.000Z"),
        timezone: "America/Mexico_City",
      },
      randomUUID(),
    );

    const reloaded = await leads.findById(lead.id);
    expect(reloaded?.bookedAt).toBeInstanceOf(Date);
    // Hardening fix: meeting_at used to stay NULL indefinitely (found via a real E2E) -- it is
    // now synced from the appointment's own startsAt in the same completeBooking write that sets
    // bookedAt (see AppointmentService.completeBooking).
    expect(reloaded?.meetingAt).toEqual(appointment.startsAt);
    expect(reloaded?.meetingAt).toEqual(start);
  });
});
