import type { SupabaseClient } from "@supabase/supabase-js";
import type { BookingAttemptRepository } from "../application/ports.js";
import type { BookingAttempt } from "../domain/booking-attempt.js";

export interface BookingAttemptRow {
  id: string;
  lead_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: string;
  appointment_id: string | null;
  provider_event_id: string | null;
  meeting_url: string | null;
  created_at: string;
}

export function mapRowToBookingAttempt(row: BookingAttemptRow): BookingAttempt {
  return {
    id: row.id,
    leadId: row.lead_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status as BookingAttempt["status"],
    appointmentId: row.appointment_id ?? undefined,
    providerEventId: row.provider_event_id ?? undefined,
    meetingUrl: row.meeting_url ?? undefined,
    createdAt: new Date(row.created_at),
  };
}

export function mapBookingAttemptToInsertRow(input: Omit<BookingAttempt, "id" | "createdAt">) {
  return {
    lead_id: input.leadId,
    idempotency_key: input.idempotencyKey,
    request_fingerprint: input.requestFingerprint,
    status: input.status,
    appointment_id: input.appointmentId ?? null,
    provider_event_id: input.providerEventId ?? null,
    meeting_url: input.meetingUrl ?? null,
  };
}

export function mapBookingAttemptPatchToRow(patch: Partial<BookingAttempt>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.appointmentId !== undefined) row.appointment_id = patch.appointmentId;
  if (patch.providerEventId !== undefined) row.provider_event_id = patch.providerEventId;
  if (patch.meetingUrl !== undefined) row.meeting_url = patch.meetingUrl;
  return row;
}

export class SupabaseBookingAttemptRepository implements BookingAttemptRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findByKey(idempotencyKey: string): Promise<BookingAttempt | null> {
    const { data, error } = await this.client
      .from("booking_attempts")
      .select()
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw new Error(`SUPABASE_BOOKING_ATTEMPT_FIND_FAILED: ${error.message}`);
    return data ? mapRowToBookingAttempt(data as BookingAttemptRow) : null;
  }

  async create(input: Omit<BookingAttempt, "id" | "createdAt">): Promise<BookingAttempt> {
    const { data, error } = await this.client
      .from("booking_attempts")
      .insert(mapBookingAttemptToInsertRow(input))
      .select()
      .single();
    if (error) throw new Error(`SUPABASE_BOOKING_ATTEMPT_CREATE_FAILED: ${error.message}`);
    return mapRowToBookingAttempt(data as BookingAttemptRow);
  }

  async update(id: string, patch: Partial<BookingAttempt>): Promise<BookingAttempt> {
    const { data, error } = await this.client
      .from("booking_attempts")
      .update(mapBookingAttemptPatchToRow(patch))
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(`SUPABASE_BOOKING_ATTEMPT_UPDATE_FAILED: ${error.message}`);
    return mapRowToBookingAttempt(data as BookingAttemptRow);
  }
}
