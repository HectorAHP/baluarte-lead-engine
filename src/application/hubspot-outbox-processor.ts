import type { HubSpotSyncOutboxRepository, HubSpotCRMProvider, Logger } from "./ports.js";
import type { HubSpotSyncOutboxEntry } from "../domain/hubspot-sync-outbox.js";
import { classifyHubSpotSyncError, computeNextAttemptAt, DEFAULT_MAX_ATTEMPTS } from "../domain/hubspot-sync-retry.js";
import { HubSpotProviderError } from "../domain/errors.js";

export interface HubSpotOutboxProcessorDeps {
  outbox: HubSpotSyncOutboxRepository;
  hubspotCrm: HubSpotCRMProvider;
  logger: Logger;
}

export interface HubSpotOutboxProcessorOptions {
  batchSize: number;
  maxAttempts: number;
}

export interface HubSpotOutboxRunSummary {
  claimed: number;
  succeeded: number;
  retryScheduled: number;
  permanentlyFailed: number;
}

/**
 * Fase 7C -- the async delivery half of the outbox pattern (see domain/hubspot-sync-outbox.ts's
 * class doc comment). Runs on demand, via POST /internal/hubspot-sync/run (app.ts) -- stateless
 * and idempotent: every call is a fresh claim-and-process cycle, never depends on the process
 * having been alive since a previous tick, same "safe to call from any scheduler, any cadence"
 * contract as AppointmentReminderService.
 *
 * NEVER re-derives the HubSpot payload from a Lead/FiscalLeadScore at process time -- `entry.payload`
 * is the frozen snapshot WebLeadCaptureService wrote at capture time (see that class), so every
 * retry sends the exact same properties regardless of what may have changed on the Lead since.
 */
export class HubSpotOutboxProcessorService {
  constructor(
    private readonly deps: HubSpotOutboxProcessorDeps,
    private readonly options: HubSpotOutboxProcessorOptions = { batchSize: 20, maxAttempts: DEFAULT_MAX_ATTEMPTS },
  ) {}

  async run(now: Date): Promise<HubSpotOutboxRunSummary> {
    const batch = await this.deps.outbox.claimBatch(now, this.options.batchSize);
    let succeeded = 0, retryScheduled = 0, permanentlyFailed = 0;
    for (const entry of batch) {
      const outcome = await this.processOne(entry, now);
      if (outcome === "SUCCEEDED") succeeded++;
      else if (outcome === "RETRY_SCHEDULED") retryScheduled++;
      else permanentlyFailed++;
    }
    return { claimed: batch.length, succeeded, retryScheduled, permanentlyFailed };
  }

  private async processOne(entry: HubSpotSyncOutboxEntry, now: Date): Promise<"SUCCEEDED" | "RETRY_SCHEDULED" | "FAILED_PERMANENT"> {
    const nextAttemptCount = entry.attemptCount + 1;
    try {
      // Fase 7B's identity-conflict guard and Fase 6F.3's 409-concurrent-create recovery both
      // live INSIDE hubspotCrm.upsertContact itself -- this worker never re-implements either,
      // it only classifies the OUTCOME (success, with or without a conflict/recovery flag) or
      // the ERROR (retryable vs permanent) of calling it.
      const result = await this.deps.hubspotCrm.upsertContact(entry.payload);
      await this.deps.outbox.update(entry.id, {
        status: "SUCCEEDED",
        attemptCount: nextAttemptCount,
        lastAttemptAt: now,
        completedAt: now,
        hubspotContactId: result.hubspotContactId,
      });
      this.deps.logger.warn(
        {
          hubspotOutboxIdLast8: entry.id.slice(-8),
          leadIdLast8: entry.leadId.slice(-8),
          submissionIdLast8: entry.submissionId.slice(-8),
          attempt: nextAttemptCount,
          outcome: result.identityConflict ? "succeeded_identity_conflict" : result.recoveredFromConflict ? "succeeded_conflict_recovered" : "succeeded",
        },
        "hubspot outbox delivery succeeded",
      );
      return "SUCCEEDED";
    } catch (err) {
      const httpStatus = err instanceof HubSpotProviderError ? err.httpStatus : undefined;
      const errorCode = err instanceof HubSpotProviderError ? "HUBSPOT_PROVIDER_ERROR" : "UNKNOWN";
      const classification = classifyHubSpotSyncError(httpStatus);
      const exhausted = nextAttemptCount >= this.options.maxAttempts;

      if (classification === "PERMANENT" || exhausted) {
        await this.deps.outbox.update(entry.id, {
          status: "FAILED_PERMANENT",
          attemptCount: nextAttemptCount,
          lastAttemptAt: now,
          lastErrorCode: errorCode,
        });
        this.deps.logger.warn(
          {
            hubspotOutboxIdLast8: entry.id.slice(-8),
            leadIdLast8: entry.leadId.slice(-8),
            submissionIdLast8: entry.submissionId.slice(-8),
            attempt: nextAttemptCount,
            statusCode: httpStatus,
            outcome: exhausted && classification === "RETRYABLE" ? "failed_permanent_attempts_exhausted" : "failed_permanent",
          },
          "hubspot outbox delivery permanently failed -- see hubspot_sync_outbox for manual reconciliation",
        );
        return "FAILED_PERMANENT";
      }

      const nextAttemptAt = computeNextAttemptAt(nextAttemptCount, now);
      await this.deps.outbox.update(entry.id, {
        status: "FAILED_RETRYABLE",
        attemptCount: nextAttemptCount,
        lastAttemptAt: now,
        nextAttemptAt,
        lastErrorCode: errorCode,
      });
      this.deps.logger.warn(
        {
          hubspotOutboxIdLast8: entry.id.slice(-8),
          leadIdLast8: entry.leadId.slice(-8),
          submissionIdLast8: entry.submissionId.slice(-8),
          attempt: nextAttemptCount,
          statusCode: httpStatus,
          retryScheduled: true,
          nextAttemptAt: nextAttemptAt.toISOString(),
        },
        "hubspot outbox delivery failed -- retry scheduled",
      );
      return "RETRY_SCHEDULED";
    }
  }
}
