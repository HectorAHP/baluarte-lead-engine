import { describe, expect, it } from "vitest";
import { mapRowToLead, mapLeadToInsertRow, mapLeadPatchToRow, type LeadRow } from "../src/infrastructure/supabase-lead-repository.js";
import { mapRowToAppointment, mapAppointmentToInsertRow, mapAppointmentPatchToRow, type AppointmentRow } from "../src/infrastructure/supabase-appointment-repository.js";
import type { Lead } from "../src/domain/lead.js";
import type { Appointment } from "../src/domain/appointment.js";

const leadRow: LeadRow = {
  id: "11111111-1111-1111-1111-111111111111",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  first_name: "Hector",
  last_name: "Herrera",
  phone_raw: "4775551234",
  phone_e164: "+524775551234",
  email: "hector@example.com",
  city: "Leon",
  state: "Guanajuato",
  country: "MX",
  source: "manual",
  source_detail: null,
  meta_lead_id: null,
  whatsapp_user_id: null,
  campaign_id: null,
  campaign_name: null,
  adset_id: null,
  adset_name: null,
  ad_id: null,
  ad_name: null,
  product_vertical: "PATRIMONIAL",
  product_interest: "PPR",
  status: "QUALIFIED_A",
  score: 93,
  score_class: "A",
  assigned_advisor: "Hector Herrera",
  notes: null,
  consent_contact: true,
  privacy_accepted_at: "2026-01-01T00:30:00.000Z",
  first_contact_at: "2026-01-01T01:00:00.000Z",
  first_response_at: null,
  qualified_at: "2026-01-01T02:00:00.000Z",
  booking_started_at: null,
  booked_at: null,
  meeting_at: null,
  closed_at: null,
};

describe("supabase lead mapping", () => {
  it("maps a DB row to the domain Lead", () => {
    const lead = mapRowToLead(leadRow);
    expect(lead.id).toBe(leadRow.id);
    expect(lead.firstName).toBe("Hector");
    expect(lead.productVertical).toBe("PATRIMONIAL");
    expect(lead.status).toBe("QUALIFIED_A");
    expect(lead.createdAt).toBeInstanceOf(Date);
    expect(lead.phoneE164).toBe("+524775551234");
    expect(lead.consentContact).toBe(true);
    expect(lead.firstContactAt).toBeInstanceOf(Date);
    expect(lead.qualifiedAt).toBeInstanceOf(Date);
    expect(lead.bookedAt).toBeUndefined();
  });

  it("maps null columns to undefined, not null", () => {
    const lead = mapRowToLead(leadRow);
    expect(lead.campaignId).toBeUndefined();
    expect(lead.notes).toBeUndefined();
    expect(lead.metaLeadId).toBeUndefined();
    expect(lead.firstResponseAt).toBeUndefined();
  });

  it("maps a create input to snake_case columns", () => {
    const input: Omit<Lead, "id" | "createdAt" | "updatedAt"> = {
      country: "MX",
      productVertical: "GMM",
      status: "NEW",
      score: 0,
      assignedAdvisor: "Hector Herrera",
      firstName: "Ana",
      consentContact: false,
    };
    const row = mapLeadToInsertRow(input);
    expect(row.first_name).toBe("Ana");
    expect(row.product_vertical).toBe("GMM");
    expect(row.assigned_advisor).toBe("Hector Herrera");
    expect(row.consent_contact).toBe(false);
    expect(row.qualified_at).toBeNull();
  });

  it("only includes patched fields plus updated_at", () => {
    const row = mapLeadPatchToRow({ score: 80, scoreClass: "A" });
    expect(row.score).toBe(80);
    expect(row.score_class).toBe("A");
    expect(row.first_name).toBeUndefined();
    expect(typeof row.updated_at).toBe("string");
  });
});

const appointmentRow: AppointmentRow = {
  id: "22222222-2222-2222-2222-222222222222",
  lead_id: "11111111-1111-1111-1111-111111111111",
  status: "BOOKED",
  starts_at: "2026-03-01T15:00:00.000Z",
  ends_at: "2026-03-01T15:30:00.000Z",
  timezone: "America/Mexico_City",
  calendar_event_id: "evt_1",
  meeting_provider: "GOOGLE_MEET",
  meeting_url: "https://meet.google.com/abc-defg-hij",
  rescheduled_from: null,
};

describe("supabase appointment mapping", () => {
  it("maps a DB row to the domain Appointment", () => {
    const appt = mapRowToAppointment(appointmentRow);
    expect(appt.leadId).toBe(appointmentRow.lead_id);
    expect(appt.startsAt).toBeInstanceOf(Date);
    expect(appt.meetingProvider).toBe("GOOGLE_MEET");
  });

  it("maps a create input to snake_case columns", () => {
    const input: Omit<Appointment, "id"> = {
      leadId: "11111111-1111-1111-1111-111111111111",
      status: "BOOKED",
      startsAt: new Date("2026-03-01T15:00:00.000Z"),
      endsAt: new Date("2026-03-01T15:30:00.000Z"),
      timezone: "America/Mexico_City",
    };
    const row = mapAppointmentToInsertRow(input);
    expect(row.lead_id).toBe(input.leadId);
    expect(row.starts_at).toBe("2026-03-01T15:00:00.000Z");
    expect(row.calendar_event_id).toBeNull();
  });

  it("only includes patched fields", () => {
    const row = mapAppointmentPatchToRow({ status: "CONFIRMED" });
    expect(row.status).toBe("CONFIRMED");
    expect(row.starts_at).toBeUndefined();
  });
});
