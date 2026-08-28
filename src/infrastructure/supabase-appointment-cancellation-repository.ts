import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppointmentCancellationRepository } from "../application/ports.js";
import type { AppointmentCancellation, AppointmentCancellationCleanupStatus } from "../domain/appointment-cancellation.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";

export interface AppointmentCancellationRow {
  id: string;
  appointment_id: string;
  lead_id: string;
  idempotency_key: string;
  calendar_event_id: string | null;
  status: string;
  attempt_count: number;
  last_attempt_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export function mapRowToAppointmentCancellation(row: AppointmentCancellationRow): AppointmentCancellation {
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    leadId: row.lead_id,
    idempotencyKey: row.idempotency_key,
    calendarEventId: row.calendar_event_id ?? undefined,
    status: row.status as AppointmentCancellationCleanupStatus,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    errorCode: row.error_code ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class SupabaseAppointmentCancellationRepository implements AppointmentCancellationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async tryCreate(
    input: Omit<AppointmentCancellation, "id" | "createdAt" | "updatedAt" | "attemptCount" | "status"> & { status?: AppointmentCancellationCleanupStatus },
  ): Promise<AppointmentCancellation | null> {
    const { data, error } = await this.client
      .from("appointment_cancellations")
      .insert({
        appointment_id: input.appointmentId,
        lead_id: input.leadId,
        idempotency_key: input.idempotencyKey,
        calendar_event_id: input.calendarEventId ?? null,
        status: input.status ?? "PENDING",
      })
      .select()
      .single();
    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) return null; // already tracked -- expected, not an error
      throw new Error(`SUPABASE_APPOINTMENT_CANCELLATION_CREATE_FAILED: ${error.message}`);
    }
    return mapRowToAppointmentCancellation(data as AppointmentCancellationRow);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<AppointmentCancellation | null> {
    const { data, error } = await this.client
      .from("appointment_cancellations")
      .select()
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw new Error(`SUPABASE_APPOINTMENT_CANCELLATION_FIND_FAILED: ${error.message}`);
    return data ? mapRowToAppointmentCancellation(data as AppointmentCancellationRow) : null;
  }

  async update(id: string, patch: Partial<AppointmentCancellation>): Promise<AppointmentCancellation> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.attemptCount !== undefined) row.attempt_count = patch.attemptCount;
    if (patch.lastAttemptAt !== undefined) row.last_attempt_at = patch.lastAttemptAt.toISOString();
    if (patch.completedAt !== undefined) row.completed_at = patch.completedAt.toISOString();
    if (patch.errorCode !== undefined) row.error_code = patch.errorCode;
    const { data, error } = await this.client.from("appointment_cancellations").update(row).eq("id", id).select().single();
    if (error) throw new Error(`SUPABASE_APPOINTMENT_CANCELLATION_UPDATE_FAILED: ${error.message}`);
    return mapRowToAppointmentCancellation(data as AppointmentCancellationRow);
  }

  async listByLeadId(leadId: string): Promise<AppointmentCancellation[]> {
    const { data, error } = await this.client.from("appointment_cancellations").select().eq("lead_id", leadId);
    if (error) throw new Error(`SUPABASE_APPOINTMENT_CANCELLATION_LIST_FAILED: ${error.message}`);
    return (data as AppointmentCancellationRow[]).map(mapRowToAppointmentCancellation);
  }
}
