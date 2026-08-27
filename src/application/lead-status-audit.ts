import type { LeadStatusHistoryRepository, AppointmentStatusHistoryRepository, Logger } from "./ports.js";
import type { LeadStatus } from "../domain/lead.js";
import type { AppointmentStatus } from "../domain/appointment.js";

/**
 * Phase 4A audit hooks -- see docs/PHASE4-DESIGN.md §4/§6. Two small, shared functions instead of
 * hook logic duplicated per handler: every real leads.status / appointments.status write goes
 * through one of the existing choke points that already call these (LeadService.transitionTo,
 * SlotOfferingService.ensureBookingPending, booking-outcome-dispatch.ts's markLeadBooked/
 * escalateToHuman for leads; nothing yet for appointments -- see
 * recordAppointmentStatusTransition's own doc comment).
 *
 * Both functions:
 *  - No-op (never write a row) when fromStatus === toStatus -- defense-in-depth: every current
 *    caller already guards this before even calling (a real status change is a precondition of
 *    reaching the call), but the guard lives here too so the contract holds regardless of caller
 *    discipline, present or future.
 *  - Are only ever called AFTER the real status-changing write (leads.update/appointments.update)
 *    has already succeeded -- a failed transition (the real write throws) never reaches these, so
 *    it can never produce a history row. The caller decides that ordering; these functions do not
 *    perform the real write themselves.
 *  - Never throw. A failure to persist the audit row is logged (sanitized: identifiers, statuses,
 *    and the closed eventType string only -- never message bodies or raw error payloads) and
 *    swallowed -- the real transition already succeeded and must not be reverted or reported as
 *    failed just because a denormalized audit write failed. Same principle already established by
 *    AppointmentService.completeBooking's best-effort leads.update(bookedAt/meetingAt) handling.
 */

export interface RecordLeadStatusTransitionParams {
  leadId: string;
  fromStatus: LeadStatus;
  toStatus: LeadStatus;
  /** Closed, code-controlled event vocabulary (e.g. "QUALIFICATION_SCORED",
   * "BOOKING_OFFER_ACCEPTED") -- never a free-text reason, never the inbound message body. */
  eventType: string;
  /** Operational metadata only (e.g. {"scoreClass":"B"}). Never clinical/diagnostic content, never
   * raw message text -- see tests/lead-status-audit.test.ts for the guard this depends on. */
  metadata?: Record<string, unknown>;
}

export async function recordLeadStatusTransition(
  leadStatusHistory: LeadStatusHistoryRepository,
  logger: Logger,
  params: RecordLeadStatusTransitionParams,
): Promise<void> {
  if (params.fromStatus === params.toStatus) return;
  try {
    await leadStatusHistory.create({
      leadId: params.leadId,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      eventType: params.eventType,
      metadata: params.metadata ?? {},
    });
  } catch (err) {
    logger.warn(
      {
        leadId: params.leadId,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
        eventType: params.eventType,
        errorName: err instanceof Error ? err.name : "unknown",
      },
      "Failed to record lead_status_history row; the lead's actual status transition already succeeded and is unaffected.",
    );
  }
}

export interface RecordAppointmentStatusTransitionParams {
  appointmentId: string;
  leadId: string;
  fromStatus: AppointmentStatus;
  toStatus: AppointmentStatus;
  eventType: string;
  metadata?: Record<string, unknown>;
}

/**
 * No caller exists yet in Phase 4A -- appointments are only ever created directly as BOOKED today
 * (AppointmentService.completeBooking), never transitioned afterward, so there is nothing real to
 * hook yet (forcing a synthetic "null -> BOOKED" row on creation was explicitly ruled out, see
 * docs/PHASE4-DESIGN.md §7). Built and unit-tested standalone now so Phase 4B (cancel) / 4C
 * (reschedule) / 4E (no-show/completed) call it from their own single choke points without
 * duplicating this logic.
 */
export async function recordAppointmentStatusTransition(
  appointmentStatusHistory: AppointmentStatusHistoryRepository,
  logger: Logger,
  params: RecordAppointmentStatusTransitionParams,
): Promise<void> {
  if (params.fromStatus === params.toStatus) return;
  try {
    await appointmentStatusHistory.create({
      appointmentId: params.appointmentId,
      leadId: params.leadId,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      eventType: params.eventType,
      metadata: params.metadata ?? {},
    });
  } catch (err) {
    logger.warn(
      {
        appointmentId: params.appointmentId,
        leadId: params.leadId,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
        eventType: params.eventType,
        errorName: err instanceof Error ? err.name : "unknown",
      },
      "Failed to record appointment_status_history row; the appointment's actual status transition already succeeded and is unaffected.",
    );
  }
}
