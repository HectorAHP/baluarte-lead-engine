import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppointmentStatusHistoryRepository } from "../application/ports.js";
import type { AppointmentStatusHistoryEntry } from "../domain/appointment-status-history.js";
import type { AppointmentStatus } from "../domain/appointment.js";

export interface AppointmentStatusHistoryRow {
  id: string;
  appointment_id: string;
  lead_id: string;
  from_status: string;
  to_status: string;
  event_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export function mapRowToAppointmentStatusHistoryEntry(row: AppointmentStatusHistoryRow): AppointmentStatusHistoryEntry {
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    leadId: row.lead_id,
    fromStatus: row.from_status as AppointmentStatus,
    toStatus: row.to_status as AppointmentStatus,
    eventType: row.event_type,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
  };
}

export class SupabaseAppointmentStatusHistoryRepository implements AppointmentStatusHistoryRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: Omit<AppointmentStatusHistoryEntry, "id" | "createdAt">): Promise<AppointmentStatusHistoryEntry> {
    const { data, error } = await this.client
      .from("appointment_status_history")
      .insert({
        appointment_id: input.appointmentId,
        lead_id: input.leadId,
        from_status: input.fromStatus,
        to_status: input.toStatus,
        event_type: input.eventType,
        metadata: input.metadata,
      })
      .select()
      .single();
    if (error) throw new Error(`SUPABASE_APPOINTMENT_STATUS_HISTORY_CREATE_FAILED: ${error.message}`);
    return mapRowToAppointmentStatusHistoryEntry(data as AppointmentStatusHistoryRow);
  }

  async listByAppointmentId(appointmentId: string): Promise<AppointmentStatusHistoryEntry[]> {
    const { data, error } = await this.client
      .from("appointment_status_history")
      .select()
      .eq("appointment_id", appointmentId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`SUPABASE_APPOINTMENT_STATUS_HISTORY_LIST_FAILED: ${error.message}`);
    return (data as AppointmentStatusHistoryRow[]).map(mapRowToAppointmentStatusHistoryEntry);
  }
}
