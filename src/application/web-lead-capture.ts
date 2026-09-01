import type { LeadRepository, ProcessedEventRepository, Logger } from "./ports.js";
import type { Lead, Vertical } from "../domain/lead.js";
import { normalizePhoneToE164 } from "../domain/phone.js";
import type { LeadService } from "./services.js";

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

function appendNote(existing: string | undefined, addition: string | undefined): string | undefined {
  if (!addition) return existing;
  return existing ? `${existing}\n\n${addition}` : addition;
}

export class WebLeadCaptureService {
  constructor(
    private readonly leads: LeadRepository,
    private readonly processedEvents: ProcessedEventRepository,
    private readonly leadService: LeadService,
    private readonly logger: Logger,
  ) {}

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
    return { lead, matchedExisting: false, idempotentReplay };
  }
}
