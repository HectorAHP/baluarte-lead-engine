/**
 * Fase 7C -- transactional-outbox pattern for HubSpot delivery (spec §5). Decouples "the lead was
 * captured" (Supabase, the critical path -- see WebLeadCaptureService) from "HubSpot has been
 * notified" (this table, delivered asynchronously by HubSpotOutboxProcessorService). A row here is
 * written SYNCHRONOUSLY, in the same request that persists the lead -- but the actual HubSpot HTTP
 * call is never awaited by that request. See migration 020_hubspot_sync_outbox.sql.
 *
 * `payload` is a frozen SNAPSHOT of exactly what HubSpotCRMProvider.upsertContact needs --
 * computed once, synchronously, at write time (buildHubSpotFiscalProperties is pure, no I/O) and
 * never recomputed from a possibly-since-changed Lead at processing time. This is also what makes
 * every retry byte-for-byte identical to the first attempt, regardless of how many times or how
 * much later it runs.
 */
export type HubSpotSyncOutboxStatus = "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_PERMANENT";

/** Exactly HubSpotContactUpsertInput's shape (ports.ts) -- duplicated as its own named type here,
 * not imported, so this domain file never depends on the application layer. */
export interface HubSpotSyncOutboxPayload {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  city?: string;
  state?: string;
  properties: Record<string, string | number | boolean>;
}

export interface HubSpotSyncOutboxEntry {
  id: string;
  leadId: string;
  submissionId: string;
  /** Denormalized from `payload.email`/`payload.phone` purely for admin-tooling readability
   * (e.g. reconciliation reports) -- never read by the processor itself, which uses `payload`. */
  contactEmail?: string;
  contactPhone?: string;
  payload: HubSpotSyncOutboxPayload;
  status: HubSpotSyncOutboxStatus;
  attemptCount: number;
  /** When this row becomes eligible for the next claim -- see domain/hubspot-sync-retry.ts's
   * backoff schedule. Always <= now() for a fresh PENDING row (immediate first attempt). */
  nextAttemptAt: Date;
  lastAttemptAt?: Date;
  /** Closed, code-controlled failure classification -- never HubSpot's raw response body. */
  lastErrorCode?: string;
  /** Set once the upsert succeeds -- see Fase 7C spec item 25. Not treated as authoritative for
   * identity resolution on a later, separate submission (a lead's HubSpot contact can change if
   * their identity was ever manually merged/split in HubSpot itself) -- this is a cache for
   * observability/reconciliation, never a shortcut around HubSpotCRMProvider's own dedupe search. */
  hubspotContactId?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}
