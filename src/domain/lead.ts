export type Vertical = "PATRIMONIAL" | "GMM" | "UNKNOWN";

export type LeadStatus =
  | "NEW" | "CONTACT_PENDING" | "CONTACTED" | "QUALIFYING"
  | "QUALIFIED_A" | "QUALIFIED_B" | "NURTURE_C" | "BOOKING_PENDING"
  | "BOOKED" | "CONFIRMED" | "RESCHEDULE_REQUESTED" | "NO_SHOW"
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
