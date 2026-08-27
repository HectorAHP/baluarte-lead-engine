import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppointmentRescheduleRepository } from "../application/ports.js";
import type { AppointmentReschedule, AppointmentRescheduleCleanupStatus } from "../domain/appointment-reschedule.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";

export interface AppointmentRescheduleRow {
  id: string;
  lead_id: string;
  old_appointment_id: string;
  new_appointment_id: string | null;
  idempotency_key: string;
  old_calendar_event_id: string | null;
  status: string;
  attempt_count: number;
  last_attempt_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export function mapRowToAppointmentReschedule(row: AppointmentRescheduleRow): AppointmentReschedule {
  return {
    id: row.id,
    leadId: row.lead_id,
    oldAppointmentId: row.old_appointment_id,
    newAppointmentId: row.new_appointment_id ?? undefined,
    idempotencyKey: row.idempotency_key,
    oldCalendarEventId: row.old_calendar_event_id ?? undefined,
    status: row.status as AppointmentRescheduleCleanupStatus,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    errorCode: row.error_code ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class SupabaseAppointmentRescheduleRepository implements AppointmentRescheduleRepository {
  constructor(private readonly client: SupabaseClient) {}

  async tryCreate(
    input: Omit<AppointmentReschedule, "id" | "createdAt" | "updatedAt" | "attemptCount" | "status" | "newAppointmentId"> & { status?: AppointmentRescheduleCleanupStatus },
  ): Promise<AppointmentReschedule | null> {
    const { data, error } = await this.client
      .from("appointment_reschedules")
      .insert({
        lead_id: input.leadId,
        old_appointment_id: input.oldAppointmentId,
        idempotency_key: input.idempotencyKey,
        old_calendar_event_id: input.oldCalendarEventId ?? null,
        status: input.status ?? "PENDING",
      })
      .select()
      .single();
    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) return null; // already tracked -- expected, not an error
      throw new Error(`SUPABASE_APPOINTMENT_RESCHEDULE_CREATE_FAILED: ${error.message}`);
    }
    return mapRowToAppointmentReschedule(data as AppointmentRescheduleRow);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<AppointmentReschedule | null> {
    const { data, error } = await this.client
      .from("appointment_reschedules")
      .select()
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw new Error(`SUPABASE_APPOINTMENT_RESCHEDULE_FIND_FAILED: ${error.message}`);
    return data ? mapRowToAppointmentReschedule(data as AppointmentRescheduleRow) : null;
  }

  async update(id: string, patch: Partial<AppointmentReschedule>): Promise<AppointmentReschedule> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.newAppointmentId !== undefined) row.new_appointment_id = patch.newAppointmentId;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.attemptCount !== undefined) row.attempt_count = patch.attemptCount;
    if (patch.lastAttemptAt !== undefined) row.last_attempt_at = patch.lastAttemptAt.toISOString();
    if (patch.completedAt !== undefined) row.completed_at = patch.completedAt.toISOString();
    if (patch.errorCode !== undefined) row.error_code = patch.errorCode;
    const { data, error } = await this.client.from("appointment_reschedules").update(row).eq("id", id).select().single();
    if (error) throw new Error(`SUPABASE_APPOINTMENT_RESCHEDULE_UPDATE_FAILED: ${error.message}`);
    return mapRowToAppointmentReschedule(data as AppointmentRescheduleRow);
  }
}
