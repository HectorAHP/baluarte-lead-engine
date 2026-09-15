import type { EmailQuality } from "./email-quality.js";
import type { PhoneQuality } from "./phone-quality.js";

export type Vertical = "PATRIMONIAL" | "GMM" | "UNKNOWN";

/**
 * Fase 2.2 (Baluarte Content Intelligence -- "Launch Blocker Closure") -- first-party,
 * web-capture attribution, persisted alongside the lead instead of living ONLY in the HubSpot
 * sync payload (see HubSpotFiscalAttributionInput in hubspot-fiscal-properties.ts, which this
 * type is deliberately structurally identical to -- not imported from there, to keep
 * domain/lead.ts free of a dependency on a HubSpot-specific module; TypeScript's structural
 * typing means a caller's `attribution` object satisfies both without any cast).
 *
 * Deliberately the SAME shape impuestos.html already sends today (see app.ts's
 * `attributionSchema`) -- campaign_id/adset_id/ad_id are NOT fields here because the frontend
 * never captures them (confirmed by reading captureUTM() in the live site during the Fase 2.1
 * audit) -- adding them here would just be three more columns that are always null. If a future
 * caller starts sending Meta's native campaign_id/adset_id/ad_id, they belong on the existing
 * Lead.campaignId/adsetId/adId fields (already present since migration 001), not duplicated here.
 */
export interface WebAttribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  /** For this campaign (bc_calc_diag_2026_09 and successors), utm_content IS the creative id --
   * e.g. "BC-A-FEED-V01". No separate `creativeId` field: one value, one source of truth, see
   * the Fase 2.2 report for why a dedicated column was rejected (utm_content already carries it
   * losslessly, and Meta's own ad-level targeting already keys off utm_content in this account's
   * naming convention). */
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  landing_page?: string;
  referrer?: string;
}

export type LeadStatus =
  | "NEW" | "CONTACT_PENDING" | "CONTACTED" | "QUALIFYING"
  | "QUALIFIED_A" | "QUALIFIED_B" | "NURTURE_C" | "BOOKING_PENDING"
  | "BOOKED" | "CONFIRMED" | "RESCHEDULE_REQUESTED"
  // Phase 4A: the only two genuinely new LeadStatus values (see docs/PHASE4-DESIGN.md §3.1/§E for
  // why they're necessary -- CLOSED_LOST is a commercial-outcome closure, not a scheduling
  // cancellation, and DO_NOT_CONTACT is opt-out with the wrong side effects; neither is an
  // equivalent substitute). No handler sets these yet -- that's Phase 4B.
  | "CANCEL_PENDING" | "CANCELLED"
  | "NO_SHOW"
  | "MEETING_COMPLETED" | "QUOTE_PENDING" | "QUOTE_SENT"
  | "CLOSED_WON" | "CLOSED_LOST" | "DO_NOT_CONTACT" | "HUMAN_HANDOFF";

export interface Lead {
  id: string; createdAt: Date; updatedAt: Date; firstName?: string; lastName?: string;
  phoneRaw?: string; phoneE164?: string; email?: string; city?: string; state?: string; country: string;
  source?: string; sourceDetail?: string; campaignId?: string; campaignName?: string; adsetId?: string; adsetName?: string;
  adId?: string; adName?: string; productVertical: Vertical; productInterest?: string;
  status: LeadStatus; score: number; scoreClass?: "A" | "B" | "C";
  assignedAdvisor: string; notes?: string;
  metaLeadId?: string; whatsappUserId?: string; consentContact: boolean;
  /**
   * When this lead accepted the Aviso de Privacidad (LFPDPPP) for a given web submission.
   * Deliberately separate from consentContact -- privacy acceptance is a precondition for the
   * submission to be valid at all (see web-lead-capture.ts), while consentContact is the
   * independent, optional marketing-contact opt-in. Set once, on first acceptance, and never
   * overwritten by a later submission (see captureWebLead's "first privacy acceptance wins"
   * rule) -- mirrors how UTM first-touch attribution is preserved elsewhere in this flow.
   */
  privacyAcceptedAt?: Date;
  firstContactAt?: Date; firstResponseAt?: Date;
  /**
   * Set only when the lead becomes a *commercially* qualified lead -- i.e. reaches
   * QUALIFIED_A or QUALIFIED_B. It does NOT mean "finished the qualification questionnaire":
   * a lead that answers every qualification question and lands on NURTURE_C never gets this
   * set, because NURTURE_C is not a qualified outcome. There is no separate
   * qualification_completed_at field (deliberately, for now) -- if "answered every question"
   * ever needs to be tracked independently of the scoring outcome, that's a new field, not a
   * redefinition of this one.
   */
  qualifiedAt?: Date;
  bookingStartedAt?: Date; bookedAt?: Date; meetingAt?: Date; closedAt?: Date;
  /**
   * Fase 7B -- lead integrity / anti-fake-lead fields (migration 019_lead_integrity.sql). ALL
   * optional/nullable, additive, and computed ONLY when LEAD_INTEGRITY_ENABLED is true (see
   * config.ts) -- absent on every lead created before this phase, and absent on every new one
   * while the flag stays false. Deliberately never read by fiscal_v1, scoring.ts,
   * state-machine.ts, or any WhatsApp handler's routing decision -- see
   * lead-integrity-score.ts's own doc comment for the full "kept separate from" list.
   */
  emailQuality?: EmailQuality;
  phoneQuality?: PhoneQuality;
  /** Set once, the first time an inbound WhatsApp message is actually received from this lead's
   * own phoneE164 -- see whatsapp-inbound-service.ts. Never set by anything else; a phone that is
   * merely syntactically VALID is never VERIFIED by that fact alone. */
  phoneVerifiedAt?: Date;
  /** Reserved for a future confirmation-link email flow (Fase 7B spec item 33) -- no code writes
   * this yet; see the Fase 7B report for why that flow isn't built in this phase (no email
   * provider configured). */
  emailVerifiedAt?: Date;
  /** True when a NEW submission's phone/email pair contradicted an EXISTING lead's identity (one
   * matched, the other didn't) rather than being silently merged into it -- see
   * WebLeadCaptureService.resolveExistingLead and RealHubSpotCRMProvider's own identity-conflict
   * detection. Never exposed to the lead/end user (Fase 7B spec item 34). */
  identityConflict?: boolean;
  /** True when the web submission that created/updated this lead completed in an implausibly
   * short time after the form was rendered (see domain/form-timing.ts) -- a signal only, never a
   * block by itself. */
  suspectedAutomation?: boolean;
  /** 0-100, see domain/lead-integrity-score.ts. Recomputed on every web-capture submission while
   * the feature flag is on; never on a WhatsApp-only lead (no equivalent submission event exists
   * for one). */
  leadIntegrityScore?: number;
  /** Always "lead_integrity_v1" for now (LEAD_INTEGRITY_VERSION) -- stored alongside the score so
   * a future scoring-rule change never silently reinterprets an old score under new rules, same
   * versioning discipline as fiscal_v1's own `version` field. */
  leadIntegrityVersion?: string;
  /**
   * Fase 2.2 -- first-party web attribution (migration 022_leads_attribution.sql). Set ONLY on
   * first capture and NEVER overwritten by a later submission from the same lead (see
   * WebLeadCaptureService's "first-touch attribution preserved on purpose" rule, applied here
   * exactly like campaignName/source/productVertical/productInterest already are). Absent on
   * every lead created before this migration, and absent on any lead whose capture request sent
   * no `attribution` object (e.g. a manual lead, or a WhatsApp-originated lead) -- optional
   * everywhere, never required.
   */
  attribution?: WebAttribution;
}

/** Priority order for deduplicating an inbound lead against existing records: exact
 * provider identifiers first (unambiguous), phone/email last (candidate-person matches,
 * not an absolute identity guarantee -- households/inboxes can be shared). */
export interface LeadDedupKey {
  metaLeadId?: string;
  whatsappUserId?: string;
  phoneE164?: string;
  email?: string;
}
