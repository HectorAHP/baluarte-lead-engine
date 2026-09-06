import type { LeadRepository, AppointmentRepository, LeadStatusHistoryRepository, Logger } from "./ports.js";
import type { Lead, LeadStatus } from "../domain/lead.js";
import { assertTransition } from "../domain/state-machine.js";
import { isUpcomingBooked } from "../domain/appointment-timing.js";
import { targetStatusForScore } from "./services.js";
import { recordLeadStatusTransition } from "./lead-status-audit.js";

/**
 * Fase 7E -- closed, code-controlled event vocabulary for a manual handoff recovery. Never reused
 * for anything else, never overlaps BOOKING_CONFIRMED/BOOKING_OFFER_STARTED/
 * BOOKING_INCONSISTENCY_HANDOFF -- a recovery must always be distinguishable, in
 * lead_status_history, from the escalation it reverses and from every genuine booking-flow event.
 */
export const HANDOFF_MANUALLY_RECOVERED_EVENT_TYPE = "HANDOFF_MANUALLY_RECOVERED";

export interface HumanHandoffRecoveryDeps {
  leads: LeadRepository;
  appointments: AppointmentRepository;
  leadStatusHistory: LeadStatusHistoryRepository;
  logger: Logger;
}

export type ResolvedAppointmentState = "FUTURE" | "PAST" | "NONE";

export type HumanHandoffRecoveryResult =
  | { outcome: "RECOVERED"; lead: Lead; previousStatus: LeadStatus; toStatus: LeadStatus; resolvedAppointmentState: ResolvedAppointmentState }
  | { outcome: "ALREADY_RECOVERED"; lead: Lead }
  | { outcome: "NOT_ELIGIBLE"; lead: Lead; currentStatus: LeadStatus }
  | { outcome: "AMBIGUOUS"; lead: Lead; activeAppointmentCount: number }
  | { outcome: "NOT_FOUND" };

/**
 * Fase 7E -- ADMINISTRATIVE, EXPLICIT recovery for a lead stuck in HUMAN_HANDOFF, invoked ONLY by
 * POST /api/leads/:id/recover-handoff (app.ts), itself gated by ADMIN_API_TOKEN, same posture as
 * mark-completed/mark-no-show. Never automatic, never a cron/sweep -- a human must decide, per
 * lead, that the original escalation reason no longer applies before calling this at all.
 *
 * The single design rule everything below serves: the caller (the admin, via the HTTP request)
 * NEVER chooses the destination status, the event type, or which appointment to act on -- this
 * service computes the ONLY safe destination from the lead's own real, already-persisted data
 * (its current appointments, its own scoreClass), so the endpoint can never become a generic
 * "set any lead to any status" API by accident. See recover()'s own doc comment for the exact
 * decision policy.
 *
 * NEVER touches: appointments (no create/update/cancel), Google Calendar, WhatsApp (no message
 * sent here -- the next real inbound message from the lead is what re-engages the normal
 * conversational flow, naturally, once wasAlreadySuppressed in whatsapp-inbound-service.ts stops
 * seeing HUMAN_HANDOFF), conversations (the suppression check is keyed exclusively on lead.status,
 * never conversation.status -- see whatsapp-inbound-service.ts), fiscal_lead_scores, HubSpot, or
 * any reminder/no-show mechanism.
 */
export class HumanHandoffRecoveryService {
  constructor(private readonly deps: HumanHandoffRecoveryDeps) {}

  /**
   * Decision policy, evaluated in this exact order:
   *
   * 1. Lead not found -> NOT_FOUND (the route maps this to 404).
   * 2. lead.status !== "HUMAN_HANDOFF":
   *    - If the most recent lead_status_history row for this lead is exactly the
   *      HANDOFF_MANUALLY_RECOVERED transition INTO the lead's current status, this is a repeated
   *      call after an already-successful recovery -> ALREADY_RECOVERED (idempotent no-op, no new
   *      write of any kind -- never a second history row).
   *    - Otherwise the lead simply isn't (or is no longer, for some unrelated reason) in
   *      HUMAN_HANDOFF -> NOT_ELIGIBLE. This is ALSO the path for DO_NOT_CONTACT (the route maps
   *      DO_NOT_CONTACT specifically to 403, any other NOT_ELIGIBLE currentStatus to 409) --
   *      DO_NOT_CONTACT is never given its own bypass here; it simply can never reach the
   *      recovery logic below because it is never HUMAN_HANDOFF.
   * 3. `appointments.listActiveByLeadId` (the SAME "0/1/>1" primitive
   *    WhatsAppCancellationHandler/WhatsAppRescheduleHandler already use for this exact
   *    ambiguity check -- never a new, parallel appointment-resolution rule):
   *    - >1 active (BOOKED) appointments -> AMBIGUOUS. Never guessed, never recovered.
   *    - exactly 1, and isUpcomingBooked(appointment, now) -> destination BOOKED (Caso A). Never
   *      CONFIRMED -- that would fabricate a confirmation reply the lead never sent.
   *    - exactly 1, but stale/past (isUpcomingBooked false) -> destination BOOKING_PENDING
   *      (Caso B) -- re-enters the SAME WhatsAppPastBookedRecoveryHandler flow that already
   *      handles any other BOOKED-with-past-appointment lead, next time they write in.
   *    - 0 active appointments -> destination targetStatusForScore(lead.scoreClass) when
   *      lead.scoreClass is set (QUALIFIED_A/QUALIFIED_B/NURTURE_C -- the lead's own real,
   *      already-persisted qualification tier, never re-derived or guessed), or CONTACTED when
   *      the lead was never scored at all (Caso C). Never QUALIFYING -- that would discard a real
   *      score already on file.
   * 4. `assertTransition(lead.status, destination)` -- re-validated against the state machine even
   *    though every edge above is already audited into it (Fase 7E additions to
   *    domain/state-machine.ts) -- defense-in-depth, never bypassed.
   * 5. Persist `leads.update(id, {status: destination})`, then record exactly ONE
   *    lead_status_history row via the shared recordLeadStatusTransition choke point (same one
   *    every other status-changing call in this codebase uses), eventType
   *    HANDOFF_MANUALLY_RECOVERED, metadata {recoveryReasonCode, previousStatus,
   *    resolvedAppointmentState} -- operational only, never PII.
   */
  async recover(leadId: string, now: Date): Promise<HumanHandoffRecoveryResult> {
    const lead = await this.deps.leads.findById(leadId);
    if (!lead) return { outcome: "NOT_FOUND" };

    if (lead.status !== "HUMAN_HANDOFF") {
      const history = await this.deps.leadStatusHistory.listByLeadId(lead.id);
      const mostRecent = history[history.length - 1];
      if (mostRecent?.eventType === HANDOFF_MANUALLY_RECOVERED_EVENT_TYPE && mostRecent.toStatus === lead.status) {
        return { outcome: "ALREADY_RECOVERED", lead };
      }
      return { outcome: "NOT_ELIGIBLE", lead, currentStatus: lead.status };
    }

    const activeAppointments = await this.deps.appointments.listActiveByLeadId(lead.id);
    if (activeAppointments.length > 1) {
      return { outcome: "AMBIGUOUS", lead, activeAppointmentCount: activeAppointments.length };
    }

    let toStatus: LeadStatus;
    let resolvedAppointmentState: ResolvedAppointmentState;
    if (activeAppointments.length === 1 && isUpcomingBooked(activeAppointments[0], now)) {
      toStatus = "BOOKED";
      resolvedAppointmentState = "FUTURE";
    } else if (activeAppointments.length === 1) {
      toStatus = "BOOKING_PENDING";
      resolvedAppointmentState = "PAST";
    } else {
      toStatus = lead.scoreClass ? targetStatusForScore(lead.scoreClass) : "CONTACTED";
      resolvedAppointmentState = "NONE";
    }

    assertTransition(lead.status, toStatus);

    const previousStatus = lead.status;
    const updated = await this.deps.leads.update(lead.id, { status: toStatus });
    await recordLeadStatusTransition(this.deps.leadStatusHistory, this.deps.logger, {
      leadId: lead.id,
      fromStatus: previousStatus,
      toStatus,
      eventType: HANDOFF_MANUALLY_RECOVERED_EVENT_TYPE,
      // Operational metadata only -- no name/phone/email/message text. recoveryReasonCode is a
      // closed constant (this is the ONLY reason code this service currently has -- a future
      // second recovery policy would introduce its own distinct code, never overload this one).
      metadata: { recoveryReasonCode: "ADMIN_VERIFIED_HANDOFF_RESOLVED", previousStatus, resolvedAppointmentState },
    });

    return { outcome: "RECOVERED", lead: updated, previousStatus, toStatus, resolvedAppointmentState };
  }
}
