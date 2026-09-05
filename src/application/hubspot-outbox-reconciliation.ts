import type { FiscalLeadScoreRepository, HubSpotSyncOutboxRepository, Logger } from "./ports.js";

/**
 * Fase 7C spec §18/§23 -- "confirmar que Supabase contiene suficiente información para
 * reconstruir el snapshot de HubSpot; si hoy falta algún dato, identificarlo antes de desacoplar."
 *
 * FINDING (documented here, not just in the report, so this constraint can never be silently
 * forgotten by a future change): `fiscal_lead_scores` (migration 018) stores ONLY the SCORING
 * output -- score, scoreClass, version, reasons, monthlyIncomeBand, annualContributionBand, hasPpr,
 * filesAnnualReturn. It does NOT store the raw calculator inputs (exact monthlyIncome,
 * annualContribution, the 4 deductions, age, city, taxRegime) or the calculation engine's
 * intermediate values (pprDeductionLimit, effectivePprContribution, otherDeductionsConsidered,
 * estimatedTaxBenefitMin/Max) -- see domain/hubspot-fiscal-properties.ts's REQUIRED_FISCAL_PROPERTIES
 * (hubspot-fiscal-snapshot-completeness.ts), 15 of which need exactly those missing fields. The
 * ONLY other place any of that appears is `leads.notes`, as unstructured free text
 * (formatFiscalCalculatorNote) -- not reliably machine-parseable back into typed fields.
 *
 * Consequence -- this reconciliation tool draws a hard line between two candidate categories with
 * genuinely different guarantees, and NEVER blurs them:
 *
 *  - FAILED_PERMANENT_RETRIABLE: an hubspot_sync_outbox row already exists (Fase 7C+ submission)
 *    with its FULL, original, frozen `payload` still intact -- retrying it is 100% faithful to the
 *    original submission. Safe to reset to PENDING for the next worker run.
 *
 *  - MISSING_OUTBOX_PARTIAL_DATA_ONLY: no outbox row exists at all (a pre-Fase-7C submission that
 *    used the old inline-only path and either never ran or failed silently, or a submission whose
 *    outbox-write itself failed). Only the scoring-level fields above could ever be reconstructed
 *    for these -- NEVER auto-executed, NEVER fabricates the missing figures. Flagged for manual
 *    review only.
 *
 * `leadId`/`submissionId` below are full, unredacted UUIDs -- fine for internal service-to-
 * repository plumbing (every repository in this codebase is keyed this way); redaction to
 * `*Last8` happens ONLY at the display/logging boundary (see formatCandidateForDisplay), same
 * convention as every other service in this project.
 */
export type ReconciliationReason = "FAILED_PERMANENT_RETRIABLE" | "MISSING_OUTBOX_PARTIAL_DATA_ONLY";

export interface ReconciliationCandidate {
  leadId: string;
  submissionId: string;
  reason: ReconciliationReason;
  /** What --execute would do for this candidate -- see the class doc comment. */
  actionPlanned: string;
}

export interface ReconciliationCandidateDisplay {
  leadIdLast8: string;
  submissionIdLast8: string;
  reason: ReconciliationReason;
  actionPlanned: string;
}

/** The ONLY form a candidate may ever be printed/logged in -- never leadId/submissionId in full,
 * never any PII (email/phone/name/financial figures never even reach this type). */
export function formatCandidateForDisplay(candidate: ReconciliationCandidate): ReconciliationCandidateDisplay {
  return {
    leadIdLast8: candidate.leadId.slice(-8),
    submissionIdLast8: candidate.submissionId.slice(-8),
    reason: candidate.reason,
    actionPlanned: candidate.actionPlanned,
  };
}

export interface ReconciliationReport {
  scannedFiscalScores: number;
  candidateCount: number;
  candidates: ReconciliationCandidate[];
}

export interface ReconciliationExecuteResult {
  attempted: number;
  reset: number;
}

export class HubSpotOutboxReconciliationService {
  constructor(
    private readonly fiscalLeadScores: FiscalLeadScoreRepository,
    private readonly outbox: HubSpotSyncOutboxRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Fase 7C spec §19 -- ALWAYS dry-run: never mutates anything. Scans every fiscal_lead_scores row
   * since `since` (bounded -- see FiscalLeadScoreRepository.listAll's own doc comment) and cross-
   * references hubspot_sync_outbox for each (leadId, submissionId) pair.
   */
  async dryRun(since: Date, limit: number): Promise<ReconciliationReport> {
    const scores = await this.fiscalLeadScores.listAll(since, limit);
    const candidates: ReconciliationCandidate[] = [];

    for (const score of scores) {
      const entry = await this.outbox.findByLeadAndSubmission(score.leadId, score.submissionId);
      if (!entry) {
        candidates.push({
          leadId: score.leadId,
          submissionId: score.submissionId,
          reason: "MISSING_OUTBOX_PARTIAL_DATA_ONLY",
          actionPlanned: "flag_for_manual_review -- only scoring-level fields could ever be reconstructed, never auto-executed",
        });
      } else if (entry.status === "FAILED_PERMANENT") {
        candidates.push({
          leadId: score.leadId,
          submissionId: score.submissionId,
          reason: "FAILED_PERMANENT_RETRIABLE",
          actionPlanned: "reset_to_pending -- full original payload preserved, safe to retry",
        });
      }
      // SUCCEEDED / PENDING / PROCESSING / FAILED_RETRYABLE -- not a candidate. A row already
      // succeeding, or still legitimately in-flight/retrying on its own schedule, needs no
      // reconciliation action.
    }

    this.logger.warn(
      { scannedFiscalScores: scores.length, candidateCount: candidates.length },
      "hubspot outbox reconciliation dry-run complete",
    );
    return { scannedFiscalScores: scores.length, candidateCount: candidates.length, candidates };
  }

  /**
   * Fase 7C spec §19 -- ONLY ever resets FAILED_PERMANENT_RETRIABLE candidates (full payload
   * preserved) back to PENDING with nextAttemptAt = now, so the next
   * HubSpotOutboxProcessorService.run() picks them up naturally through its own normal retry path
   * -- this method never calls HubSpot itself. MISSING_OUTBOX_PARTIAL_DATA_ONLY candidates are
   * NEVER touched here (see the class doc comment) -- they require a human decision, not this
   * tool. Never called from any HTTP route in this codebase -- see
   * scripts/reconcile-hubspot-outbox.ts, the only sanctioned caller, which requires an explicit
   * --execute flag and prints the dry-run first regardless.
   */
  async execute(candidates: ReconciliationCandidate[], now: Date): Promise<ReconciliationExecuteResult> {
    let attempted = 0, reset = 0;
    for (const candidate of candidates) {
      if (candidate.reason !== "FAILED_PERMANENT_RETRIABLE") continue;
      attempted++;
      // Re-fetch fresh by the exact (leadId, submissionId) pair -- never trusts a stale
      // in-memory snapshot from the dry-run report, in case status changed since then (e.g. a
      // concurrent worker run already resolved it).
      const entry = await this.outbox.findByLeadAndSubmission(candidate.leadId, candidate.submissionId);
      if (!entry || entry.status !== "FAILED_PERMANENT") continue;
      await this.outbox.update(entry.id, { status: "PENDING", nextAttemptAt: now });
      reset++;
    }
    this.logger.warn({ attempted, reset }, "hubspot outbox reconciliation execute complete");
    return { attempted, reset };
  }
}
