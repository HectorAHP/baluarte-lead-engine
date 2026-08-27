import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppointmentMessageDeliveryRepository } from "../application/ports.js";
import type { AppointmentMessageDelivery, DeliveryStatus, DeliveryType } from "../domain/appointment-message-delivery.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";

export interface AppointmentMessageDeliveryRow {
  id: string;
  appointment_id: string;
  lead_id: string;
  delivery_type: string;
  status: string;
  scheduled_for: string;
  idempotency_key: string;
  attempt_count: number;
  last_attempt_at: string | null;
  completed_at: string | null;
  provider_message_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export function mapRowToAppointmentMessageDelivery(row: AppointmentMessageDeliveryRow): AppointmentMessageDelivery {
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    leadId: row.lead_id,
    deliveryType: row.delivery_type as DeliveryType,
    status: row.status as DeliveryStatus,
    scheduledFor: new Date(row.scheduled_for),
    idempotencyKey: row.idempotency_key,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    providerMessageId: row.provider_message_id ?? undefined,
    errorCode: row.error_code ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** No caller exists yet in Phase 4A -- this repository is foundation for the Phase 4D/4E
 * scheduler, built and tested standalone now (see docs/PHASE4-DESIGN.md). */
export class SupabaseAppointmentMessageDeliveryRepository implements AppointmentMessageDeliveryRepository {
  constructor(private readonly client: SupabaseClient) {}

  async tryCreate(
    input: Omit<AppointmentMessageDelivery, "id" | "createdAt" | "updatedAt" | "attemptCount" | "status"> & { status?: DeliveryStatus },
  ): Promise<AppointmentMessageDelivery | null> {
    const { data, error } = await this.client
      .from("appointment_message_deliveries")
      .insert({
        appointment_id: input.appointmentId,
        lead_id: input.leadId,
        delivery_type: input.deliveryType,
        status: input.status ?? "PENDING",
        scheduled_for: input.scheduledFor.toISOString(),
        idempotency_key: input.idempotencyKey,
      })
      .select()
      .single();
    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) return null; // already scheduled -- expected, not an error
      throw new Error(`SUPABASE_APPOINTMENT_MESSAGE_DELIVERY_CREATE_FAILED: ${error.message}`);
    }
    return mapRowToAppointmentMessageDelivery(data as AppointmentMessageDeliveryRow);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<AppointmentMessageDelivery | null> {
    const { data, error } = await this.client
      .from("appointment_message_deliveries")
      .select()
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw new Error(`SUPABASE_APPOINTMENT_MESSAGE_DELIVERY_FIND_FAILED: ${error.message}`);
    return data ? mapRowToAppointmentMessageDelivery(data as AppointmentMessageDeliveryRow) : null;
  }

  async update(id: string, patch: Partial<AppointmentMessageDelivery>): Promise<AppointmentMessageDelivery> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.attemptCount !== undefined) row.attempt_count = patch.attemptCount;
    if (patch.lastAttemptAt !== undefined) row.last_attempt_at = patch.lastAttemptAt.toISOString();
    if (patch.completedAt !== undefined) row.completed_at = patch.completedAt.toISOString();
    if (patch.providerMessageId !== undefined) row.provider_message_id = patch.providerMessageId;
    if (patch.errorCode !== undefined) row.error_code = patch.errorCode;
    const { data, error } = await this.client.from("appointment_message_deliveries").update(row).eq("id", id).select().single();
    if (error) throw new Error(`SUPABASE_APPOINTMENT_MESSAGE_DELIVERY_UPDATE_FAILED: ${error.message}`);
    return mapRowToAppointmentMessageDelivery(data as AppointmentMessageDeliveryRow);
  }
}
