import type { LeadRepository, ProcessedEventRepository, Logger, FiscalLeadScoreRepository } from "./ports.js";
import type { Lead, Vertical } from "../domain/lead.js";
import { normalizePhoneToE164 } from "../domain/phone.js";
import type { LeadService } from "./services.js";
import { scoreFiscalCalculatorLead } from "../domain/fiscal-lead-scoring.js";
import type { FiscalScoreInput } from "../domain/fiscal-lead-score.js";

/** Source value that gates fiscal_v1 scoring -- see FASE 6A. Any other `source` never runs
 * fiscal scoring, regardless of whether a `fiscalCalculator` payload happens to be present. */
const FISCAL_CALCULATOR_SOURCE = "WEB_FISCAL_CALCULATOR";

/**
 * Web lead capture (impuestos.html fiscal calculator, and any future public web form).
 *
 * Deliberately NOT folded into LeadService.createLead(): that method is a pure "always insert a
 * new row" primitive, used as-is by whatsapp-inbound-service.ts (which does its OWN
 * findByDedupKey check before calling it -- see that file, line ~172). This class runs the exact
 * same dedup-before-create shape for the public HTTP surface, so POST /api/leads stops silently
 * duplicating a lead every time the same person re-submits a web form (the gap this class closes
 * -- createLead() itself was, and remains, un-deduped by design for its one existing caller).
 *
 * Idempotency: `processed_events` (migration 001) already had the right (provider, event_id)
 * unique constraint for this and no application code ever used it. Reused here rather than a new
 * table -- see ProcessedEventRepository's doc comment in ports.ts.
 *
 * HISTORICAL LIMITATION (reported, not solved here): there is no generic "lead interaction/event
 * log" table in this schema -- lead_status_history is state-transition-only, and
 * qualification_answers is scoped to the WhatsApp PATRIMONIAL/GMM qualifier's own fixed field
 * whitelist (see qualification-fields.ts), neither fits a free-form calculator submission. A lead
 * that runs the fiscal calculator more than once therefore does NOT get one row per run; each
 * run appends a text block to the SAME leads.notes column (oldest first, never overwritten -- see
 * appendNote below). If per-run structured history/analytics ever becomes a real requirement (e.g.
 * "leads originated by calculator with income > X"), that needs a new migration (a
 * `lead_interactions` table or similar) -- deliberately not built here without a concrete need for
 * it, per this task's own "no inventes arquitectura excesiva" instruction.
 */

export const WEB_LEAD_EVENT_PROVIDER = "web_lead_capture";

export interface WebLeadCaptureInput {
  submissionId: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  city?: string;
  source: string;
  sourceDetail?: string;
  campaignName?: string;
  productVertical?: Vertical;
  productInterest?: string;
  note?: string;
  consentContact: boolean;
  privacyAcceptedAt: Date;
  /**
   * Fase 6A: only consulted when source === "WEB_FISCAL_CALCULATOR". Passed through as-is from
   * the calculator's structured payload -- scoring runs directly against these fields, never by
   * parsing/regex-extracting from `note`/leads.notes (that text is free-form and not a scoring
   * input by design; see the class doc comment's HISTORICAL LIMITATION).
   */
  fiscalCalculator?: FiscalScoreInput;
}

export interface WebLeadCaptureResult {
  lead: Lead;
  /** true when this submission matched an existing lead (by phone/email) and was merged into it
   * instead of creating a new row. */
  matchedExisting: boolean;
  /** true when this exact submissionId was already processed by an earlier request -- the lead
   * returned is whatever findByDedupKey resolves to right now, NOT re-mutated by this call. */
  idempotentReplay: boolean;
}

/**
 * Production hardening: a lead can run the fiscal calculator (or any future web form) an
 * unbounded number of times, and every run appends to this single leads.notes column (see the
 * class doc comment's HISTORICAL LIMITATION for why there's no per-run table yet). Left
 * unchecked, that's unbounded growth from a public, unauthenticated endpoint. This caps the
 * TOTAL stored length and, once exceeded, drops the OLDEST content first (never the newest --
 * the most recent submission is always what a human needs when they open this lead) with an
 * explicit marker so the truncation is visible, never silent. 8000 chars is roughly 2-3 full
 * calculator submissions' worth of formatted note text -- generous for the realistic case (a
 * handful of resubmissions) while bounding the pathological one (hundreds of scripted
 * resubmissions).
 */
const MAX_NOTES_LENGTH = 8000;
const TRUNCATION_MARKER = "[...historial anterior recortado...]\n\n";

function appendNote(existing: string | undefined, addition: string | undefined): string | undefined {
  if (!addition) return existing;
  const merged = existing ? `${existing}\n\n${addition}` : addition;
  if (merged.length <= MAX_NOTES_LENGTH) return merged;
  const keepFrom = merged.length - (MAX_NOTES_LENGTH - TRUNCATION_MARKER.length);
  return TRUNCATION_MARKER + merged.slice(keepFrom);
}

export class WebLeadCaptureService {
  constructor(
    private readonly leads: LeadRepository,
    private readonly processedEvents: ProcessedEventRepository,
    private readonly leadService: LeadService,
    private readonly logger: Logger,
    // Fase 6A -- optional so every existing test-app/production wiring that predates fiscal
    // scoring keeps compiling; app.ts always supplies a real one (InMemory or Supabase). When
    // absent, fiscal scoring is silently skipped (never throws) -- deliberately fail-open, since
    // scoring is additive and must never block a lead capture from succeeding.
    private readonly fiscalLeadScores?: FiscalLeadScoreRepository,
  ) {}

  /**
   * Fase 6A: scores + persists a fiscal_v1 row for `lead`'s current submission, when eligible.
   * Idempotent via FiscalLeadScoreRepository.tryCreate's (lead_id, submission_id) uniqueness --
   * a resend of the same submissionId returns null (no-op) rather than a duplicate row. Never
   * throws: a scoring failure must never fail the surrounding lead-capture request.
   *
   * Deliberately does NOT touch lead.score / lead.scoreClass / lead.status / assignedAdvisor /
   * conversations / appointments / lifecycle timestamps -- see migration
   * 018_fiscal_lead_scores.sql's header comment for why those stay untouched.
   */
  private async scoreFiscalCalculatorSubmission(lead: Lead, input: WebLeadCaptureInput): Promise<void> {
    if (input.source !== FISCAL_CALCULATOR_SOURCE) return;
    if (!input.fiscalCalculator) return;
    if (!this.fiscalLeadScores) return;
    try {
      const result = scoreFiscalCalculatorLead(input.fiscalCalculator);
      const persisted = await this.fiscalLeadScores.tryCreate({
        leadId: lead.id,
        submissionId: input.submissionId,
        score: result.score,
        scoreClass: result.scoreClass,
        version: result.version,
        reasons: result.reasons,
        monthlyIncomeBand: result.monthlyIncomeBand,
        annualContributionBand: result.annualContributionBand,
        hasPpr: input.fiscalCalculator.hasPpr,
        filesAnnualReturn: input.fiscalCalculator.filesAnnualReturn,
      });
      if (persisted) {
        // ALLOWED to log: opaque leadId fragment, scoreClass, score, version. FORBIDDEN: name,
        // phone, email, exact income/contribution, deductions, fiscal result -- none of those are
        // referenced here.
        this.logger.warn(
          { leadIdLast8: lead.id.slice(-8), score: result.score, scoreClass: result.scoreClass, version: result.version },
          "lead fiscal score calculated",
        );
      }
    } catch (err) {
      this.logger.warn(
        { leadIdLast8: lead.id.slice(-8), errorName: err instanceof Error ? err.name : "unknown" },
        "lead fiscal score calculation failed",
      );
    }
  }

  async capture(input: WebLeadCaptureInput): Promise<WebLeadCaptureResult> {
    const claim = await this.processedEvents.tryCreate({ provider: WEB_LEAD_EVENT_PROVIDER, eventId: input.submissionId });
    const idempotentReplay = claim === null;

    const phoneE164 = normalizePhoneToE164(input.phone) ?? undefined;

    if (idempotentReplay) {
      // Not a technical error -- a resubmitted/retried request with the same submissionId. Never
      // logs phone/email/financial figures, only an opaque id fragment, per this task's logging
      // constraints.
      this.logger.warn({ submissionIdLast8: input.submissionId.slice(-8) }, "web lead ingestion idempotent duplicate");
      const existing = await this.leads.findByDedupKey({ phoneE164, email: input.email });
      if (existing) return { lead: existing, matchedExisting: true, idempotentReplay: true };
      // First attempt's processed_events row won the race but its lead write never landed (crash
      // mid-request, or this really is the very first attempt racing a retry sent before any
      // response came back). Fall through and capture normally -- safe because leads themselves
      // are ALSO deduped by phone/email below, independent of the processed_events guard.
    }

    const existing = await this.leads.findByDedupKey({ phoneE164, email: input.email });

    if (existing) {
      const patch: Partial<Lead> = {};
      // Conservative merge: fills gaps, appends, never overwrites anything already set, never
      // touches status/score/assignedAdvisor/conversation/appointment fields. First-touch
      // attribution (source/productVertical/productInterest/campaignName) is preserved on
      // purpose -- see the class doc comment.
      if (!existing.email && input.email) patch.email = input.email;
      if (!existing.city && input.city) patch.city = input.city;
      if (!existing.firstName && input.firstName) patch.firstName = input.firstName;
      if (!existing.lastName && input.lastName) patch.lastName = input.lastName;
      if (!existing.phoneRaw && input.phone) { patch.phoneRaw = input.phone; patch.phoneE164 = phoneE164; }
      if (!existing.privacyAcceptedAt) patch.privacyAcceptedAt = input.privacyAcceptedAt;
      if (input.consentContact && !existing.consentContact) patch.consentContact = true; // consent can only be gained here, never revoked by a resubmission that simply left the box unchecked
      const mergedNotes = appendNote(existing.notes, input.note);
      if (mergedNotes !== existing.notes) patch.notes = mergedNotes;

      const lead = Object.keys(patch).length > 0 ? await this.leads.update(existing.id, patch) : existing;
      await this.scoreFiscalCalculatorSubmission(lead, input);
      return { lead, matchedExisting: true, idempotentReplay };
    }

    const lead = await this.leadService.createLead({
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      email: input.email,
      city: input.city,
      source: input.source,
      sourceDetail: input.sourceDetail,
      campaignName: input.campaignName,
      productVertical: input.productVertical,
      productInterest: input.productInterest,
      consentContact: input.consentContact,
      notes: input.note,
      privacyAcceptedAt: input.privacyAcceptedAt,
    });
    await this.scoreFiscalCalculatorSubmission(lead, input);
    return { lead, matchedExisting: false, idempotentReplay };
  }
}
