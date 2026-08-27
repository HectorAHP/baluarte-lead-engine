import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppointmentRepository } from "../application/ports.js";
import type { Appointment } from "../domain/appointment.js";
import { SlotUnavailableError } from "../domain/errors.js";

const POSTGRES_EXCLUSION_VIOLATION = "23P01";

export interface AppointmentRow {
  id: string;
  lead_id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  calendar_event_id: string | null;
  meeting_provider: string | null;
  meeting_url: string | null;
  rescheduled_from: string | null;
}

export function mapRowToAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    leadId: row.lead_id,
    status: row.status as Appointment["status"],
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    timezone: row.timezone,
    calendarEventId: row.calendar_event_id ?? undefined,
    meetingProvider: (row.meeting_provider as Appointment["meetingProvider"]) ?? undefined,
    meetingUrl: row.meeting_url ?? undefined,
    rescheduledFrom: row.rescheduled_from ?? undefined,
  };
}

export function mapAppointmentToInsertRow(input: Omit<Appointment, "id">) {
  return {
    lead_id: input.leadId,
    status: input.status,
    starts_at: input.startsAt.toISOString(),
    ends_at: input.endsAt.toISOString(),
    timezone: input.timezone,
    calendar_event_id: input.calendarEventId ?? null,
    meeting_provider: input.meetingProvider ?? null,
    meeting_url: input.meetingUrl ?? null,
    rescheduled_from: input.rescheduledFrom ?? null,
  };
}

export function mapAppointmentPatchToRow(patch: Partial<Appointment>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.startsAt !== undefined) row.starts_at = patch.startsAt.toISOString();
  if (patch.endsAt !== undefined) row.ends_at = patch.endsAt.toISOString();
  if (patch.timezone !== undefined) row.timezone = patch.timezone;
  if (patch.calendarEventId !== undefined) row.calendar_event_id = patch.calendarEventId;
  if (patch.meetingProvider !== undefined) row.meeting_provider = patch.meetingProvider;
  if (patch.meetingUrl !== undefined) row.meeting_url = patch.meetingUrl;
  if (patch.rescheduledFrom !== undefined) row.rescheduled_from = patch.rescheduledFrom;
  return row;
}

export class SupabaseAppointmentRepository implements AppointmentRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: Omit<Appointment, "id">): Promise<Appointment> {
    const { data, error } = await this.client
      .from("appointments")
      .insert(mapAppointmentToInsertRow(input))
      .select()
      .single();
    if (error) {
      if (error.code === POSTGRES_EXCLUSION_VIOLATION) throw new SlotUnavailableError();
      throw new Error(`SUPABASE_APPOINTMENT_CREATE_FAILED: ${error.message}`);
    }
    return mapRowToAppointment(data as AppointmentRow);
  }

  async findById(id: string): Promise<Appointment | null> {
    const { data, error } = await this.client.from("appointments").select().eq("id", id).maybeSingle();
    if (error) throw new Error(`SUPABASE_APPOINTMENT_FIND_FAILED: ${error.message}`);
    return data ? mapRowToAppointment(data as AppointmentRow) : null;
  }

  async update(id: string, patch: Partial<Appointment>): Promise<Appointment> {
    const { data, error } = await this.client
      .from("appointments")
      .update(mapAppointmentPatchToRow(patch))
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(`SUPABASE_APPOINTMENT_UPDATE_FAILED: ${error.message}`);
    return mapRowToAppointment(data as AppointmentRow);
  }

  async findActiveByLeadId(leadId: string): Promise<Appointment | null> {
    const { data, error } = await this.client
      .from("appointments")
      .select()
      .eq("lead_id", leadId)
      .eq("status", "BOOKED")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`SUPABASE_APPOINTMENT_FIND_ACTIVE_FAILED: ${error.message}`);
    return data ? mapRowToAppointment(data as AppointmentRow) : null;
  }

  async listActiveByLeadId(leadId: string): Promise<Appointment[]> {
    const { data, error } = await this.client.from("appointments").select().eq("lead_id", leadId).eq("status", "BOOKED");
    if (error) throw new Error(`SUPABASE_APPOINTMENT_LIST_ACTIVE_FAILED: ${error.message}`);
    return (data as AppointmentRow[]).map(mapRowToAppointment);
  }

  async findMostRecentByLeadId(leadId: string): Promise<Appointment | null> {
    const { data, error } = await this.client
      .from("appointments")
      .select()
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`SUPABASE_APPOINTMENT_FIND_MOST_RECENT_FAILED: ${error.message}`);
    return data ? mapRowToAppointment(data as AppointmentRow) : null;
  }

  async claimTransition(id: string, expectedStatus: Appointment["status"], nextStatus: Appointment["status"]): Promise<Appointment | null> {
    // maybeSingle(), not single(): zero matching rows (lost the CAS) is an expected outcome here,
    // never an error -- must come back as `data: null`.
    const { data, error } = await this.client
      .from("appointments")
      .update({ status: nextStatus })
      .eq("id", id)
      .eq("status", expectedStatus)
      .select()
      .maybeSingle();
    if (error) throw new Error(`SUPABASE_APPOINTMENT_CLAIM_TRANSITION_FAILED: ${error.message}`);
    return data ? mapRowToAppointment(data as AppointmentRow) : null;
  }
}
