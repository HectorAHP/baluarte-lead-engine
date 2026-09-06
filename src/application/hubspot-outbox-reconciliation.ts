import type { FiscalLeadScoreRepository, HubSpotSyncOutboxRepository, Logger, LeadRepository } from "./ports.js";
import { findFiscalCalculatorNoteBlockForSubmission } from "../domain/fiscal-calculator-note-parser.js";

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

/**
 * Fase 7C.1 §14 -- "buscar en TODAS las tablas relevantes... antes de concluir" and classify into
 * this 4-way taxonomy, informed by a full re-audit that found `leads.notes` (via
 * fiscal-calculator-note-parser.ts, the inverse of formatFiscalCalculatorNote) actually carries
 * most of a calculator submission's raw inputs -- richer than the Fase 7C report credited it for,
 * though never a lossless source (see that parser's own doc comment for the two permanent limits:
 * money rounded to whole pesos, and the 4 individual deduction inputs are NEVER individually
 * recoverable, only their sum).
 *
 * - FULLY_RECONSTRUCTABLE: an hubspot_sync_outbox row already exists with its FULL, original,
 *   frozen `payload` intact (the FAILED_PERMANENT_RETRIABLE case) -- exact data, not an
 *   approximation. Safe to retry as-is.
 * - PARTIALLY_RECONSTRUCTABLE: no outbox row exists, but `leads.notes` contains a parseable
 *   calculator block for this exact submissionId -- most figures recoverable, rounded, and the 4
 *   individual deductions are gone forever (only their sum survives). NEVER auto-executed.
 * - NOT_RECONSTRUCTABLE: no outbox row AND no parseable notes block (never submitted with a
 *   snapshot, or truncated away by MAX_NOTES_LENGTH) -- only the scoring-level fields
 *   (fiscal_lead_scores) survive. Nothing else in this schema holds the raw inputs.
 * - IDENTITY_CONFLICT: the lead itself is tagged `identityConflict` (Fase 7B) -- its own identity
 *   is ambiguous (a phone matched a different email's lead). Reconstructing ANY data for this
 *   lead is deferred until a human resolves the identity question first -- checked BEFORE notes
 *   parsing, so an identity-conflicted lead is never silently reconstructed from notes either.
 *
 * Never uses HubSpot itself as a source of truth to reconstruct anything -- only Supabase tables
 * this project already owns (fiscal_lead_scores, leads.notes, leads.identityConflict).
 */
export type ReconciliationDataQuality = "FULLY_RECONSTRUCTABLE" | "PARTIALLY_RECONSTRUCTABLE" | "NOT_RECONSTRUCTABLE" | "IDENTITY_CONFLICT";

export interface ReconciliationCandidate {
  leadId: string;
  submissionId: string;
  reason: ReconciliationReason;
  dataQuality: ReconciliationDataQuality;
  /** What --execute would do for this candidate -- see the class doc comment. */
  actionPlanned: string;
}

export interface ReconciliationCandidateDisplay {
  leadIdLast8: string;
  submissionIdLast8: string;
  reason: ReconciliationReason;
  dataQuality: ReconciliationDataQuality;
  actionPlanned: string;
}

/** The ONLY form a candidate may ever be printed/logged in -- never leadId/submissionId in full,
 * never any PII (email/phone/name/financial figures never even reach this type). */
export function formatCandidateForDisplay(candidate: ReconciliationCandidate): ReconciliationCandidateDisplay {
  return {
    leadIdLast8: candidate.leadId.slice(-8),
    submissionIdLast8: candidate.submissionId.slice(-8),
    reason: candidate.reason,
    dataQuality: candidate.dataQuality,
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
    // Fase 7C.1 §14 -- needed to read leads.notes and leads.identityConflict for the
    // dataQuality classification above. Required (not optional): a reconciliation report that
    // silently skipped this check would be exactly the kind of unverified claim this phase exists
    // to correct.
    private readonly leads: LeadRepository,
  ) {}

  /**
   * Fase 7C.1 §14 -- for a MISSING_OUTBOX_PARTIAL_DATA_ONLY candidate, determines exactly how much
   * (if anything) could ever be reconstructed -- see ReconciliationDataQuality's own doc comment
   * for the full taxonomy and ordering rationale (identity conflict is checked BEFORE notes
   * parsing, deliberately).
   */
  private async classifyDataQuality(leadId: string, submissionId: string): Promise<ReconciliationDataQuality> {
    const lead = await this.leads.findById(leadId);
    if (!lead) return "NOT_RECONSTRUCTABLE"; // defensive -- should not happen (a fiscal score always references a real lead)
    if (lead.identityConflict) return "IDENTITY_CONFLICT";
    const parsed = findFiscalCalculatorNoteBlockForSubmission(lead.notes, submissionId);
    return parsed ? "PARTIALLY_RECONSTRUCTABLE" : "NOT_RECONSTRUCTABLE";
  }

  private actionPlannedFor(dataQuality: ReconciliationDataQuality): string {
    switch (dataQuality) {
      case "IDENTITY_CONFLICT":
        return "flag_for_manual_review -- this lead's own identity is ambiguous (Fase 7B identityConflict); resolve that FIRST, never reconstruct data for it in the meantime";
      case "PARTIALLY_RECONSTRUCTABLE":
        return "flag_for_manual_review -- leads.notes contains a parseable calculator block for this submission; figures are approximate (rounded, individual deductions unrecoverable, only their sum), never auto-executed";
      case "NOT_RECONSTRUCTABLE":
        return "flag_for_manual_review -- only scoring-level fields (fiscal_lead_scores) survive; no raw calculator inputs recoverable from any table";
      case "FULLY_RECONSTRUCTABLE":
        return "reset_to_pending -- full original payload preserved, safe to retry";
    }
  }

  /**
   * Fase 7C spec §19 -- ALWAYS dry-run: never mutates anything. Scans every fiscal_lead_scores row
   * since `since` (bounded -- see FiscalLeadScoreRepository.listAll's own doc comment) and cross-
   * references hubspot_sync_outbox for each (leadId, submissionId) pair. Fase 7C.1 §14: for every
   * MISSING_OUTBOX candidate, ALSO reads the lead's notes/identityConflict to classify dataQuality
   * -- never concludes "nothing recoverable" without having actually looked.
   */
  async dryRun(since: Date, limit: number): Promise<ReconciliationReport> {
    const scores = await this.fiscalLeadScores.listAll(since, limit);
    const candidates: ReconciliationCandidate[] = [];

    for (const score of scores) {
      const entry = await this.outbox.findByLeadAndSubmission(score.leadId, score.submissionId);
      if (!entry) {
        const dataQuality = await this.classifyDataQuality(score.leadId, score.submissionId);
        candidates.push({
          leadId: score.leadId,
          submissionId: score.submissionId,
          reason: "MISSING_OUTBOX_PARTIAL_DATA_ONLY",
          dataQuality,
          actionPlanned: this.actionPlannedFor(dataQuality),
        });
      } else if (entry.status === "FAILED_PERMANENT") {
        candidates.push({
          leadId: score.leadId,
          submissionId: score.submissionId,
          reason: "FAILED_PERMANENT_RETRIABLE",
          dataQuality: "FULLY_RECONSTRUCTABLE",
          actionPlanned: this.actionPlannedFor("FULLY_RECONSTRUCTABLE"),
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
