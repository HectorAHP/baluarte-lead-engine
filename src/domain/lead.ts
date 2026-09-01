export type Vertical = "PATRIMONIAL" | "GMM" | "UNKNOWN";

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
