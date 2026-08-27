import type { LeadStatus } from "./lead.js";
import { InvalidLeadTransitionError } from "./errors.js";
const transitions: Record<LeadStatus, readonly LeadStatus[]> = {
  NEW:["CONTACT_PENDING","CONTACTED","DO_NOT_CONTACT","HUMAN_HANDOFF"],
  CONTACT_PENDING:["CONTACTED","DO_NOT_CONTACT","HUMAN_HANDOFF"],
  CONTACTED:["QUALIFYING","DO_NOT_CONTACT","HUMAN_HANDOFF"],
  QUALIFYING:["QUALIFIED_A","QUALIFIED_B","NURTURE_C","DO_NOT_CONTACT","HUMAN_HANDOFF"],
  QUALIFIED_A:["BOOKING_PENDING","BOOKED","DO_NOT_CONTACT","HUMAN_HANDOFF"],
  QUALIFIED_B:["BOOKING_PENDING","NURTURE_C","BOOKED","DO_NOT_CONTACT","HUMAN_HANDOFF"],
  NURTURE_C:["QUALIFYING","DO_NOT_CONTACT","HUMAN_HANDOFF"],
  BOOKING_PENDING:["BOOKED","NURTURE_C","DO_NOT_CONTACT","HUMAN_HANDOFF"],
  // Phase 4A additions: BOOKED/CONFIRMED -> CANCEL_PENDING (cancellation entry point, Phase 4B);
  // RESCHEDULE_REQUESTED -> HUMAN_HANDOFF was missing -- without it, a data-consistency error
  // during a reschedule (mirroring ActiveOfferInconsistentError/BookingAttemptInconsistentError's
  // existing escalation during booking) had nowhere valid to escalate to. See
  // docs/PHASE4-DESIGN.md §3.2 for the full rationale of every edge below.
  // Phase 4B addition: BOOKED/CONFIRMED -> HUMAN_HANDOFF was also missing -- needed for
  // AppointmentCancellationInconsistentError (no BOOKED appointment found / more than one) to
  // escalate from the very first cancellation-intent turn, before the lead ever reaches
  // CANCEL_PENDING.
  BOOKED:["CONFIRMED","RESCHEDULE_REQUESTED","CANCEL_PENDING","NO_SHOW","MEETING_COMPLETED","HUMAN_HANDOFF","DO_NOT_CONTACT"],
  CONFIRMED:["RESCHEDULE_REQUESTED","CANCEL_PENDING","NO_SHOW","MEETING_COMPLETED","HUMAN_HANDOFF","DO_NOT_CONTACT"],
  RESCHEDULE_REQUESTED:["BOOKED","HUMAN_HANDOFF","DO_NOT_CONTACT"],
  // Phase 4A new states. CANCEL_PENDING always resolves to either CANCELLED (lead confirms) or
  // back to BOOKED (lead declines, or an ambiguous/timed-out reply -- never auto-cancels on an
  // ambiguous answer). CANCELLED can return to BOOKING_PENDING later (a cancelled lead may come
  // back), same principle already established for NO_SHOW below. No handler drives either state
  // yet -- that's Phase 4B.
  CANCEL_PENDING:["CANCELLED","BOOKED","HUMAN_HANDOFF","DO_NOT_CONTACT"],
  CANCELLED:["BOOKING_PENDING","HUMAN_HANDOFF","DO_NOT_CONTACT"],
  NO_SHOW:["BOOKING_PENDING","BOOKED","CLOSED_LOST","DO_NOT_CONTACT"],
  MEETING_COMPLETED:["QUOTE_PENDING","QUOTE_SENT","CLOSED_WON","CLOSED_LOST"],
  QUOTE_PENDING:["QUOTE_SENT","CLOSED_WON","CLOSED_LOST"],
  QUOTE_SENT:["CLOSED_WON","CLOSED_LOST"],
  CLOSED_WON:[], CLOSED_LOST:[], DO_NOT_CONTACT:[],
  HUMAN_HANDOFF:["CONTACTED","QUALIFYING","BOOKING_PENDING","DO_NOT_CONTACT"]
};
export const canTransition=(from:LeadStatus,to:LeadStatus)=>transitions[from].includes(to);
export function assertTransition(from:LeadStatus,to:LeadStatus){if(!canTransition(from,to)) throw new InvalidLeadTransitionError(from,to);}
