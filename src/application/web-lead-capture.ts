import type { LeadRepository, ProcessedEventRepository, Logger, FiscalLeadScoreRepository, EmailDomainChecker } from "./ports.js";
import type { Lead, Vertical } from "../domain/lead.js";
import { normalizePhoneToE164 } from "../domain/phone.js";
import type { LeadService } from "./services.js";
import { scoreFiscalCalculatorLead } from "../domain/fiscal-lead-scoring.js";
import type { FiscalScoreInput } from "../domain/fiscal-lead-score.js";
import type { HubSpotFiscalSyncService } from "./hubspot-fiscal-sync-service.js";
import type { HubSpotFiscalAttributionInput, HubSpotFiscalPropertiesInput } from "../domain/hubspot-fiscal-properties.js";
import { classifyEmailQuality, normalizeEmail, DEFAULT_DISPOSABLE_EMAIL_DOMAINS } from "../domain/email-quality.js";
import { classifyPhoneQuality } from "../domain/phone-quality.js";
import { isSuspiciouslyFastSubmission } from "../domain/form-timing.js";
import { computeLeadIntegrityScore, type LeadIntegritySignals } from "../domain/lead-integrity-score.js";

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
  /**
   * Fase 6F: the FULL fiscal calculator payload (deductions, calculation, hasGmm, age, taxRegime
   * -- everything `fiscalCalculator` above deliberately omits, since that field is scoped ONLY to
   * fiscal_v1's own scoring inputs). Used exclusively to build the HubSpot contact snapshot, never
   * to influence scoring. Same "only meaningful when source === WEB_FISCAL_CALCULATOR" gating as
   * `fiscalCalculator` above.
   */
  fiscalCalculatorSnapshot?: HubSpotFiscalPropertiesInput["fiscalCalculator"];
  /** Fase 6F: passed through from the calculator's own optional field, if ever sent -- see
   * PPR_CALCULATOR_DEFAULT_VERSION's doc comment for the fallback used when absent. */
  calculationVersion?: string;
  /** Fase 6F: the SAME attribution object app.ts already parses (utm_source, utm_medium,
   * utm_campaign, utm_content, utm_term, fbclid, landing_page, referrer) -- reused here, not
   * re-derived, so HubSpot's bc_fiscal_utm_* properties always match exactly what was captured
   * for this submission. */
  attribution?: HubSpotFiscalAttributionInput;
  /**
   * Fase 6F.1: the AUTHORITATIVE moment this submission was captured by Lead Engine -- the SAME
   * `submittedAt` app.ts's POST /api/leads handler already generates once per request and reuses
   * for `privacyAcceptedAt`/the leads.notes fiscal block. Modeled as its own field (not aliased to
   * privacyAcceptedAt) because the two represent different concepts even though they share the
   * same value today -- see the Fase 6F.1 report, item 2. Used ONLY for HubSpot's
   * bc_fiscal_calculated_at; falls back to `new Date()` if a future caller omits it (defensive,
   * since app.ts always supplies it for calculator submissions today).
   */
  submittedAt?: Date;
  /** Fase 7B -- when the frontend form was first rendered/started, if known. Compared against
   * `submittedAt` (see domain/form-timing.ts) to compute `suspectedAutomation` -- only when
   * LEAD_INTEGRITY_ENABLED is true (see WebLeadCaptureServiceOptions). Absent is never itself
   * suspicious -- a caller/form that doesn't send this simply gets no timing signal, same as
   * today. */
  formStartedAt?: Date;
}

/**
 * Fase 7B -- all optional; every one defaults to "off" / absent, which reproduces this class's
 * exact pre-Fase-7B behavior byte-for-byte (no lead-integrity computation, no new fields ever
 * written) -- same "flag off means unchanged behavior" guarantee as every other flag in this
 * project. See config.ts for where these are actually sourced from in app.ts.
 */
export interface WebLeadCaptureServiceOptions {
  /** Gates ALL lead-integrity computation below (email/phone quality, suspectedAutomation,
   * identityConflict persistence, leadIntegrityScore) -- see LEAD_INTEGRITY_ENABLED's doc comment
   * in config.ts for the full list of things a low score must NEVER be used to do. */
  leadIntegrityEnabled?: boolean;
  /** Optional DNS-backed domain checker (see infrastructure/dns-email-domain-checker.ts) -- only
   * ever consulted when BOTH leadIntegrityEnabled and emailDnsValidationEnabled are true. Absent
   * (even with both flags on) simply skips the DNS step -- emailQuality then never reaches VALID,
   * only UNVERIFIED/INVALID/DISPOSABLE (see email-quality.ts's own doc comment on why that's a
   * safe, honest default, never a broken one).
   */
  emailDomainChecker?: EmailDomainChecker;
  emailDnsValidationEnabled?: boolean;
  disposableEmailCheckEnabled?: boolean;
  /** Merged with DEFAULT_DISPOSABLE_EMAIL_DOMAINS -- see config.ts's
   * EMAIL_DISPOSABLE_DOMAINS_EXTRA. */
  extraDisposableDomains?: ReadonlySet<string>;
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
    // Fase 6F -- optional, same rationale as fiscalLeadScores above. Undefined whenever
    // HUBSPOT_PRIVATE_APP_TOKEN isn't configured (every environment today) -- HubSpot sync is then
    // silently skipped, never throws, never blocks lead capture.
    private readonly hubspotSync?: HubSpotFiscalSyncService,
    // Fase 7B -- see WebLeadCaptureServiceOptions' own doc comment. Defaults to {} (every flag
    // undefined/falsy), which is byte-for-byte today's pre-Fase-7B behavior.
    private readonly integrityOptions: WebLeadCaptureServiceOptions = {},
  ) {}

  /**
   * Fase 7B spec §36/§39 -- the SAME safe hierarchy now used by RealHubSpotCRMProvider, applied to
   * the Lead Engine's own dedupe (independent of, and upstream from, HubSpot's): email match wins
   * outright; a phone-only match is used ONLY if it doesn't contradict a genuinely different email
   * already present on that record. A phone match against a lead with no email on file, or the
   * SAME email, is a safe, ordinary match (this is also how a WhatsApp-first lead with no email
   * yet correctly gets enriched by a later web submission). Never merges two contradictory
   * identities -- see the class doc comment's "Fase 7B" note and the Fase 7B report §37/38.
   */
  private async resolveExistingLead(phoneE164: string | undefined, email: string | undefined): Promise<{ lead: Lead | null; identityConflict: boolean }> {
    if (email) {
      const byEmail = await this.leads.findByEmail(email);
      if (byEmail) return { lead: byEmail, identityConflict: false };
      if (phoneE164) {
        const byPhone = await this.leads.findByPhoneE164(phoneE164);
        if (byPhone) {
          if (byPhone.email && byPhone.email.toLowerCase() !== email.toLowerCase()) {
            return { lead: null, identityConflict: true };
          }
          return { lead: byPhone, identityConflict: false };
        }
      }
      return { lead: null, identityConflict: false };
    }
    if (phoneE164) {
      const byPhone = await this.leads.findByPhoneE164(phoneE164);
      if (byPhone) return { lead: byPhone, identityConflict: false };
    }
    return { lead: null, identityConflict: false };
  }

  /**
   * Fase 7B -- pure computation, no I/O beyond the optional DNS check. NEVER touches
   * status/score/scoreClass/assignedAdvisor/conversation/appointment/consentContact -- see
   * domain/lead-integrity-score.ts's own "kept separate from" list. Returns {} (nothing to patch)
   * when leadIntegrityEnabled is false, so a caller can always spread the result into a patch/
   * insert object unconditionally.
   */
  private async computeIntegritySignals(input: { phoneRaw?: string; phoneE164?: string; email?: string; identityConflict: boolean; formStartedAt?: Date; submittedAt: Date }): Promise<Partial<Lead>> {
    if (!this.integrityOptions.leadIntegrityEnabled) return {};

    const emailQuality = input.email
      ? classifyEmailQuality(input.email, {
          checkDisposable: this.integrityOptions.disposableEmailCheckEnabled,
          disposableDomains: this.integrityOptions.extraDisposableDomains
            ? new Set([...DEFAULT_DISPOSABLE_EMAIL_DOMAINS, ...this.integrityOptions.extraDisposableDomains])
            : undefined,
          domainConfirmedByDns:
            this.integrityOptions.emailDnsValidationEnabled && this.integrityOptions.emailDomainChecker
              ? (await this.integrityOptions.emailDomainChecker.domainHasMailExchanger(normalizeEmail(input.email).split("@")[1])) === true
              : false,
        })
      : undefined;
    // Fase 7B: classified whenever a raw phone STRING was submitted, not only when normalization
    // succeeded -- classifyPhoneQuality(undefined) already returns "INVALID", which is exactly the
    // right technical signal for "the caller tried to give us a phone and it didn't work out",
    // never silently omitted just because normalizePhoneToE164 returned null.
    const phoneQuality = input.phoneRaw ? classifyPhoneQuality(input.phoneE164) : undefined;
    const suspectedAutomation = input.formStartedAt ? isSuspiciouslyFastSubmission(input.formStartedAt, input.submittedAt) : undefined;

    const signals: LeadIntegritySignals = {
      emailQuality,
      phoneQuality,
      suspectedAutomation,
      identityConflict: input.identityConflict,
    };
    const { score, version } = computeLeadIntegrityScore(signals);

    const patch: Partial<Lead> = { leadIntegrityScore: score, leadIntegrityVersion: version };
    if (emailQuality !== undefined) patch.emailQuality = emailQuality;
    if (phoneQuality !== undefined) patch.phoneQuality = phoneQuality;
    if (suspectedAutomation !== undefined) patch.suspectedAutomation = suspectedAutomation;
    if (input.identityConflict) patch.identityConflict = true;
    return patch;
  }

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

        // Fase 6F: sync to HubSpot only on a genuine NEW fiscal_v1 row (never on an idempotent
        // replay of an already-scored submissionId -- `persisted` is exactly that signal). Runs
        // strictly AFTER the lead and its fiscal_v1 score are already durably persisted above --
        // see HubSpotFiscalSyncService's class doc comment for the full "persist lead -> persist
        // score -> sync HubSpot" ordering rationale. Never throws (fail-open by construction).
        if (this.hubspotSync && input.fiscalCalculatorSnapshot) {
          await this.hubspotSync.syncFiscalCalculatorLead({
            lead,
            submissionId: input.submissionId,
            fiscalCalculator: input.fiscalCalculatorSnapshot,
            calculationVersion: input.calculationVersion,
            fiscalScore: { score: result.score, scoreClass: result.scoreClass, version: result.version },
            attribution: input.attribution,
            consentContact: input.consentContact,
            privacyAcceptedAt: input.privacyAcceptedAt,
            // Fase 6F.1: the authoritative submission-capture timestamp, never the sync moment --
            // see WebLeadCaptureInput.submittedAt's doc comment.
            calculatedAt: input.submittedAt ?? new Date(),
          });
        }
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
    const normalizedEmail = input.email ? normalizeEmail(input.email) : undefined;

    if (idempotentReplay) {
      // Not a technical error -- a resubmitted/retried request with the same submissionId. Never
      // logs phone/email/financial figures, only an opaque id fragment, per this task's logging
      // constraints.
      this.logger.warn({ submissionIdLast8: input.submissionId.slice(-8) }, "web lead ingestion idempotent duplicate");
      const { lead: existing } = await this.resolveExistingLead(phoneE164, normalizedEmail);
      if (existing) return { lead: existing, matchedExisting: true, idempotentReplay: true };
      // First attempt's processed_events row won the race but its lead write never landed (crash
      // mid-request, or this really is the very first attempt racing a retry sent before any
      // response came back), OR the resolved identity is contradictory (see resolveExistingLead)
      // and there is genuinely no safe existing lead to return. Either way, fall through and
      // capture normally -- safe because leads themselves are ALSO deduped below, independent of
      // the processed_events guard.
    }

    const submittedAt = input.submittedAt ?? new Date();
    const { lead: existing, identityConflict } = await this.resolveExistingLead(phoneE164, normalizedEmail);

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

      Object.assign(patch, await this.computeIntegritySignals({ phoneRaw: input.phone, phoneE164, email: normalizedEmail, identityConflict: false, formStartedAt: input.formStartedAt, submittedAt }));

      const lead = Object.keys(patch).length > 0 ? await this.leads.update(existing.id, patch) : existing;
      await this.scoreFiscalCalculatorSubmission(lead, input);
      return { lead, matchedExisting: true, idempotentReplay };
    }

    // identityConflict === true here means: a genuinely new email, whose phone nonetheless
    // matches a DIFFERENT existing lead's own, different email (see resolveExistingLead's doc
    // comment). Never merged into that other lead -- this submission becomes its OWN new lead,
    // tagged identityConflict so it's visible for manual review, never silently contaminating the
    // other record's data (Fase 7B spec §26/§37).
    const integritySignals = await this.computeIntegritySignals({ phoneRaw: input.phone, phoneE164, email: normalizedEmail, identityConflict, formStartedAt: input.formStartedAt, submittedAt });
    if (identityConflict) {
      this.logger.warn({ submissionIdLast8: input.submissionId.slice(-8) }, "web lead capture: phone matched a different lead's email -- creating a separate lead instead of merging");
    }

    const created = await this.leadService.createLead({
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
    // createLead()'s own input type is a fixed, narrow shape shared by every caller in this
    // codebase (whatsapp-inbound-service.ts included) -- deliberately NOT widened for Fase 7B's
    // handful of fields, which apply only to a web submission. A second, targeted update is a
    // smaller, safer change than growing that shared contract.
    const lead = Object.keys(integritySignals).length > 0 ? await this.leads.update(created.id, integritySignals) : created;
    await this.scoreFiscalCalculatorSubmission(lead, input);
    return { lead, matchedExisting: false, idempotentReplay };
  }
}
