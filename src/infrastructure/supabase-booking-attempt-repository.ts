import type { SupabaseClient } from "@supabase/supabase-js";
import type { BookingAttemptRepository } from "../application/ports.js";
import type { BookingAttempt, BookingAttemptStatus } from "../domain/booking-attempt.js";
import { BookingAttemptKeyConflictError } from "../domain/errors.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";

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
  updated_at: string;
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
    updatedAt: new Date(row.updated_at),
  };
}

export function mapBookingAttemptToInsertRow(input: Omit<BookingAttempt, "id" | "createdAt" | "updatedAt">) {
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
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.appointmentId !== undefined) row.appointment_id = patch.appointmentId;
  if (patch.providerEventId !== undefined) row.provider_event_id = patch.providerEventId;
  if (patch.meetingUrl !== undefined) row.meeting_url = patch.meetingUrl;
  return row;
}

/**
 * Ownership model for booking (Phase 3C foundation): create() is a plain insert that either wins
 * outright or reports a conflict; claimTransition() is the only path that mutates an existing
 * row's status, and it is a real compare-and-set (see the WHERE clause below) -- AppointmentService
 * is the sole caller that interprets what "won" / "lost" means. update() remains for the owning
 * request's own in-flight progress writes (providerEventId, meetingUrl, terminal status) once it
 * already holds ownership; it does not itself provide any concurrency guarantee.
 */
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

  async create(input: Omit<BookingAttempt, "id" | "createdAt" | "updatedAt">): Promise<BookingAttempt> {
    const { data, error } = await this.client
      .from("booking_attempts")
      .insert(mapBookingAttemptToInsertRow(input))
      .select()
      .single();
    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) throw new BookingAttemptKeyConflictError(input.idempotencyKey);
      throw new Error(`SUPABASE_BOOKING_ATTEMPT_CREATE_FAILED: ${error.message}`);
    }
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

  async claimTransition(
    id: string,
    expectedStatus: BookingAttemptStatus,
    nextStatus: BookingAttemptStatus,
    options?: { updatedBefore: Date },
  ): Promise<BookingAttempt | null> {
    let query = this.client
      .from("booking_attempts")
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", expectedStatus);
    if (options?.updatedBefore) {
      query = query.lt("updated_at", options.updatedBefore.toISOString());
    }
    // maybeSingle(), not single(): zero matching rows (lost the CAS) is an expected outcome
    // here, not an error -- it must come back as `data: null`, never throw.
    const { data, error } = await query.select().maybeSingle();
    if (error) throw new Error(`SUPABASE_BOOKING_ATTEMPT_CLAIM_FAILED: ${error.message}`);
    return data ? mapRowToBookingAttempt(data as BookingAttemptRow) : null;
  }

  async listByLeadId(leadId: string): Promise<BookingAttempt[]> {
    const { data, error } = await this.client.from("booking_attempts").select().eq("lead_id", leadId);
    if (error) throw new Error(`SUPABASE_BOOKING_ATTEMPT_LIST_FAILED: ${error.message}`);
    return (data as BookingAttemptRow[]).map(mapRowToBookingAttempt);
  }
}
