import type { SupabaseClient } from "@supabase/supabase-js";
import type { HubSpotSyncOutboxRepository, AtomicFiscalCaptureRepository, AtomicFiscalScoreWithOutboxInput, AtomicFiscalScoreWithOutboxResult } from "../application/ports.js";
import type { HubSpotSyncOutboxEntry, HubSpotSyncOutboxPayload, HubSpotSyncOutboxStatus } from "../domain/hubspot-sync-outbox.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";

export interface HubSpotSyncOutboxRow {
  id: string;
  lead_id: string;
  submission_id: string;
  contact_email: string | null;
  contact_phone: string | null;
  payload: HubSpotSyncOutboxPayload;
  status: string;
  attempt_count: number;
  next_attempt_at: string;
  last_attempt_at: string | null;
  last_error_code: string | null;
  hubspot_contact_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export function mapRowToHubSpotSyncOutboxEntry(row: HubSpotSyncOutboxRow): HubSpotSyncOutboxEntry {
  return {
    id: row.id,
    leadId: row.lead_id,
    submissionId: row.submission_id,
    contactEmail: row.contact_email ?? undefined,
    contactPhone: row.contact_phone ?? undefined,
    payload: row.payload,
    status: row.status as HubSpotSyncOutboxStatus,
    attemptCount: row.attempt_count,
    nextAttemptAt: new Date(row.next_attempt_at),
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at) : undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    hubspotContactId: row.hubspot_contact_id ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
  };
}

/**
 * Fase 7C -- see ports.ts's HubSpotSyncOutboxRepository doc comment and migration
 * 020_hubspot_sync_outbox.sql. `claimBatch` calls the migration's own
 * claim_hubspot_sync_outbox_batch RPC (a single atomic `UPDATE ... FOR UPDATE SKIP LOCKED`) --
 * deliberately NOT a separate select-then-update from this class, which would reopen exactly the
 * race window the RPC exists to close (see the migration's own doc comment).
 */
export class SupabaseHubSpotSyncOutboxRepository implements HubSpotSyncOutboxRepository {
  constructor(private readonly client: SupabaseClient) {}

  async tryCreate(
    input: Omit<HubSpotSyncOutboxEntry, "id" | "createdAt" | "updatedAt" | "attemptCount" | "status" | "nextAttemptAt"> & { status?: HubSpotSyncOutboxStatus; nextAttemptAt?: Date },
  ): Promise<HubSpotSyncOutboxEntry | null> {
    const { data, error } = await this.client
      .from("hubspot_sync_outbox")
      .insert({
        lead_id: input.leadId,
        submission_id: input.submissionId,
        contact_email: input.contactEmail ?? null,
        contact_phone: input.contactPhone ?? null,
        payload: input.payload,
        status: input.status ?? "PENDING",
        next_attempt_at: (input.nextAttemptAt ?? new Date()).toISOString(),
      })
      .select()
      .single();
    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) return null; // already scheduled -- expected, not an error
      throw new Error(`SUPABASE_HUBSPOT_SYNC_OUTBOX_CREATE_FAILED: ${error.message}`);
    }
    return mapRowToHubSpotSyncOutboxEntry(data as HubSpotSyncOutboxRow);
  }

  async findById(id: string): Promise<HubSpotSyncOutboxEntry | null> {
    const { data, error } = await this.client.from("hubspot_sync_outbox").select().eq("id", id).maybeSingle();
    if (error) throw new Error(`SUPABASE_HUBSPOT_SYNC_OUTBOX_FIND_FAILED: ${error.message}`);
    return data ? mapRowToHubSpotSyncOutboxEntry(data as HubSpotSyncOutboxRow) : null;
  }

  async findByLeadAndSubmission(leadId: string, submissionId: string): Promise<HubSpotSyncOutboxEntry | null> {
    const { data, error } = await this.client
      .from("hubspot_sync_outbox")
      .select()
      .eq("lead_id", leadId)
      .eq("submission_id", submissionId)
      .maybeSingle();
    if (error) throw new Error(`SUPABASE_HUBSPOT_SYNC_OUTBOX_FIND_FAILED: ${error.message}`);
    return data ? mapRowToHubSpotSyncOutboxEntry(data as HubSpotSyncOutboxRow) : null;
  }

  async claimBatch(now: Date, limit: number, staleBefore: Date): Promise<HubSpotSyncOutboxEntry[]> {
    const { data, error } = await this.client.rpc("claim_hubspot_sync_outbox_batch", {
      p_limit: limit,
      p_now: now.toISOString(),
      p_stale_before: staleBefore.toISOString(),
    });
    if (error) throw new Error(`SUPABASE_HUBSPOT_SYNC_OUTBOX_CLAIM_FAILED: ${error.message}`);
    return ((data ?? []) as HubSpotSyncOutboxRow[]).map(mapRowToHubSpotSyncOutboxEntry);
  }

  async update(id: string, patch: Partial<HubSpotSyncOutboxEntry>): Promise<HubSpotSyncOutboxEntry> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.attemptCount !== undefined) row.attempt_count = patch.attemptCount;
    if (patch.nextAttemptAt !== undefined) row.next_attempt_at = patch.nextAttemptAt.toISOString();
    if (patch.lastAttemptAt !== undefined) row.last_attempt_at = patch.lastAttemptAt.toISOString();
    if (patch.lastErrorCode !== undefined) row.last_error_code = patch.lastErrorCode;
    if (patch.hubspotContactId !== undefined) row.hubspot_contact_id = patch.hubspotContactId;
    if (patch.completedAt !== undefined) row.completed_at = patch.completedAt.toISOString();
    const { data, error } = await this.client.from("hubspot_sync_outbox").update(row).eq("id", id).select().single();
    if (error) throw new Error(`SUPABASE_HUBSPOT_SYNC_OUTBOX_UPDATE_FAILED: ${error.message}`);
    return mapRowToHubSpotSyncOutboxEntry(data as HubSpotSyncOutboxRow);
  }

  async listByStatus(status: HubSpotSyncOutboxStatus): Promise<HubSpotSyncOutboxEntry[]> {
    const { data, error } = await this.client.from("hubspot_sync_outbox").select().eq("status", status);
    if (error) throw new Error(`SUPABASE_HUBSPOT_SYNC_OUTBOX_LIST_FAILED: ${error.message}`);
    return (data as HubSpotSyncOutboxRow[]).map(mapRowToHubSpotSyncOutboxEntry);
  }
}

/**
 * Fase 7C.1 §1/§2 -- the REAL atomic implementation of AtomicFiscalCaptureRepository, backed by
 * migration 021's create_fiscal_score_with_outbox RPC (a single PL/pgSQL function -- BEGIN/COMMIT
 * implicit, one Postgres transaction covering both inserts). This is what actually closes the gap
 * the Fase 7C "transactional outbox" naming got ahead of -- see that migration's own doc comment.
 */
export class SupabaseAtomicFiscalCaptureRepository implements AtomicFiscalCaptureRepository {
  constructor(private readonly client: SupabaseClient) {}

  async createFiscalScoreWithOutbox(input: AtomicFiscalScoreWithOutboxInput): Promise<AtomicFiscalScoreWithOutboxResult> {
    const { data, error } = await this.client.rpc("create_fiscal_score_with_outbox", {
      p_lead_id: input.leadId,
      p_submission_id: input.submissionId,
      p_score: input.score,
      p_score_class: input.scoreClass,
      p_version: input.version,
      p_reasons: input.reasons,
      p_monthly_income_band: input.monthlyIncomeBand,
      p_annual_contribution_band: input.annualContributionBand,
      p_has_ppr: input.hasPpr ?? null,
      p_files_annual_return: input.filesAnnualReturn ?? null,
      p_outbox_payload: input.outbox?.payload ?? null,
      p_contact_email: input.outbox?.contactEmail ?? null,
      p_contact_phone: input.outbox?.contactPhone ?? null,
    });
    if (error) throw new Error(`SUPABASE_CREATE_FISCAL_SCORE_WITH_OUTBOX_FAILED: ${error.message}`);
    const result = data as { fiscalScoreCreated: boolean; fiscalScoreId: string | null; outboxCreated: boolean; outboxId: string | null };
    return { fiscalScoreCreated: result.fiscalScoreCreated, outboxCreated: result.outboxCreated };
  }
}
