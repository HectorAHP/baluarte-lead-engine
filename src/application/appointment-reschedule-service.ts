import type { CalendarProvider, AppointmentRepository, AppointmentRescheduleRepository, AppointmentStatusHistoryRepository, Logger } from "./ports.js";
import type { Appointment } from "../domain/appointment.js";
import type { AppointmentReschedule } from "../domain/appointment-reschedule.js";
import { CalendarProviderError, RescheduleInProgressError } from "../domain/errors.js";
import { recordAppointmentStatusTransition } from "./lead-status-audit.js";
import type { AppointmentCancellationService } from "./appointment-cancellation-service.js";

export type RescheduleOutcome =
  | { type: "RESCHEDULED"; oldAppointment: Appointment; newAppointment: Appointment }
  | { type: "INCONSISTENT" };

export interface RescheduleParams {
  leadId: string;
  /** Must be a snapshot the caller just fetched (never inferred from messages -- see
   * WhatsAppRescheduleHandler, which always sources it from AppointmentRepository, same
   * discipline as WhatsAppCancellationHandler). */
  oldAppointment: Appointment;
  /** Identifies the selected offered_slots row -- part of the idempotency key, and the source of
   * the new appointment's time range. */
  offeredSlotId: string;
  start: Date;
  end: Date;
  title: string;
  description: string;
  attendeeEmail?: string;
  timezone: string;
}

/**
 * How long an appointment_reschedules row can sit in phaseAStatus='PENDING' before it's treated
 * as abandoned (the owning process died before reaching COMPLETED/FAILED) rather than genuinely
 * in progress. Same value and same rationale as AppointmentService.PENDING_STALE_THRESHOLD_MS --
 * Phase A here is structurally the same shape of critical section (a Calendar WRITE + an
 * appointment INSERT) as booking's completeBooking.
 */
export const PHASE_A_STALE_THRESHOLD_MS = 2 * 60 * 1000;

/**
 * Channel-agnostic reschedule domain logic -- no WhatsApp concepts here, mirrors how
 * AppointmentService/AppointmentCancellationService stay independent of the WhatsApp handler
 * layer.
 *
 * Ordering (item 6 of the Phase 4C spec, load-bearing):
 *   1. idempotency-key ownership (Phase A gate -- see appointment-reschedule.ts)
 *   2. create the new Google Calendar event
 *   3. persist the new event's id on the reschedule-op row IMMEDIATELY -- before the appointment
 *      insert -- so a crash between "Calendar event created" and "appointment persisted" still
 *      leaves a durable reference to the event (see PHASE 4C HARDENING item 6: this was
 *      previously missing and is the reason this ordering is now explicit and tested).
 *   4. persist the new appointment BOOKED, rescheduledFrom = old.id, and record its id on the
 *      reschedule-op row (Phase A complete)
 *   5. CAS old appointment BOOKED -> RESCHEDULED
 *   6. record appointment_status_history for the old appointment
 *   7. delete the OLD Calendar event (idempotent, durably tracked -- Phase B, same ensureCleanup
 *      shape as AppointmentCancellationService)
 *
 * Ownership / retry semantics (item 12 of the Phase 4C hardening report): Phase A ownership is a
 * real PENDING/FAILED/COMPLETED state machine on appointment_reschedules.phaseAStatus, mirroring
 * booking_attempts exactly -- winning tryCreate() makes this call the outright owner; losing it
 * means re-fetching the existing row and inspecting phaseAStatus: COMPLETED (newAppointmentId
 * set) is an idempotent success; a FRESH PENDING row means a genuinely live owner (ask the caller
 * to wait); a STALE PENDING or a FAILED row is reclaimable via the exact two-step
 * (PENDING->FAILED->PENDING) / one-step (FAILED->PENDING) compare-and-set
 * AppointmentService.claimExistingAttempt already established for booking_attempts. This means a
 * transient Calendar failure (createEvent throws) never permanently locks a still-valid slot
 * selection out of being retried -- the reclaiming caller becomes the new owner and tries again.
 *
 * Double-booking safety (item 7): nothing in this schema stops two DIFFERENT new appointments
 * (two distinct, concurrent slot selections for the same lead) from both reaching step 4 BOOKED
 * before either attempts step 5's CAS -- appointments_no_overlap is a time-range exclusion, not a
 * per-lead cardinality constraint, and none exists. Only ONE of the two can ever win the step-5
 * CAS; the loser's own new appointment would otherwise be a permanently orphaned second BOOKED
 * row for this lead. The loser detects this (step 5 returns null) and rolls its OWN new
 * appointment back to CANCELLED via cancellationService.cancel() -- reusing Phase 4B's CAS +
 * durable Calendar-cleanup tracking wholesale rather than re-implementing it, but with a distinct
 * eventType ("APPOINTMENT_RESCHEDULE_ROLLBACK", never "APPOINTMENT_CANCELLED") so the audit trail
 * never mislabels a spurious internal rollback as a customer-initiated cancellation (see item 9
 * of the Phase 4C hardening report). cancel() itself never touches leads or sends any message --
 * it depends on neither, so this rollback can never produce a stray CANCEL_PENDING transition or
 * a cancellation WhatsApp message as a side effect. Then the loser reports the WINNER's
 * appointment (re-read from AppointmentRepository, never assumed) as the outcome, so the loser's
 * caller converges on the exact same success response as a duplicate-selection retry.
 */
export class AppointmentRescheduleService {
  constructor(
    private readonly calendar: CalendarProvider,
    private readonly appointments: AppointmentRepository,
    private readonly reschedules: AppointmentRescheduleRepository,
    private readonly appointmentStatusHistory: AppointmentStatusHistoryRepository,
    private readonly cancellationService: AppointmentCancellationService,
    private readonly logger: Logger,
  ) {}

  async reschedule(params: RescheduleParams): Promise<RescheduleOutcome> {
    const { leadId, oldAppointment, offeredSlotId } = params;
    const idempotencyKey = `whatsapp-reschedule:${leadId}:${oldAppointment.id}:${offeredSlotId}`;

    const won = await this.reschedules.tryCreate({
      leadId,
      oldAppointmentId: oldAppointment.id,
      idempotencyKey,
      oldCalendarEventId: oldAppointment.calendarEventId,
    });

    let op: AppointmentReschedule;
    if (won) {
      op = won;
    } else {
      const existing = await this.reschedules.findByIdempotencyKey(idempotencyKey);
      if (!existing) throw new RescheduleInProgressError(idempotencyKey); // lost tryCreate AND a re-fetch found nothing -- never hang, treat as in-progress

      if (existing.newAppointmentId) {
        // Phase A already completed (this call's own earlier attempt, a duplicate selection, or
        // a duplicate webhook that slipped past upstream dedup) -- idempotent success, never a
        // second Calendar event, never a second CAS.
        const existingNew = await this.appointments.findById(existing.newAppointmentId);
        if (!existingNew) return { type: "INCONSISTENT" }; // data corruption -- never auto-recovered
        const currentOld = await this.appointments.findById(oldAppointment.id);
        return { type: "RESCHEDULED", oldAppointment: currentOld ?? oldAppointment, newAppointment: existingNew };
      }

      const claimed = await this.claimPhaseAOwnership(existing, idempotencyKey);
      if (!claimed) throw new RescheduleInProgressError(idempotencyKey); // genuinely fresh/live owner, or lost the reclaim race -- never steal
      op = claimed;
    }

    if (oldAppointment.status !== "BOOKED") {
      // Never BOOKED at all (already CANCELLED by a concurrent cancellation, or any other
      // unexpected status) -- a genuine data-consistency violation, not a normal business
      // outcome. Never attempts Calendar or persists anything. The op row is left owned
      // (phaseAStatus PENDING) with newAppointmentId still null -- a later retry (if the caller
      // ever re-validates and re-calls) would hit this same check again; nothing unsafe about
      // leaving it as-is.
      return { type: "INCONSISTENT" };
    }

    let newAppointment: Appointment;
    try {
      const event = await this.calendar.createEvent({
        title: params.title,
        description: params.description,
        start: params.start,
        end: params.end,
        attendeeEmail: params.attendeeEmail,
      });
      // Persist the remote event id THE MOMENT it's known -- before the appointment insert --
      // so a crash in the gap between these two calls still leaves a durable reference to the
      // event (reconciliation query: appointment_reschedules WHERE new_calendar_event_id IS NOT
      // NULL AND new_appointment_id IS NULL). Deliberately NOT swallowed: if this write itself
      // fails, we must not silently proceed to create a real appointment while the one durable
      // reference to the just-created Calendar event is unrecorded -- fall through to the catch
      // block below instead, which marks Phase A FAILED (best-effort) and rethrows.
      const opWithEventId = await this.reschedules.update(op.id, { newCalendarEventId: event.eventId });
      op = opWithEventId;
      newAppointment = await this.appointments.create({
        leadId,
        status: "BOOKED",
        startsAt: params.start,
        endsAt: params.end,
        timezone: params.timezone,
        calendarEventId: event.eventId,
        meetingProvider: "GOOGLE_MEET",
        meetingUrl: event.meetingUrl,
        rescheduledFrom: oldAppointment.id,
      });
    } catch (err) {
      // Phase A failed (Calendar, the bookkeeping write, or the appointment insert). Mark the op
      // row FAILED (best-effort -- a failure to write this just means the row stays PENDING, and
      // a later caller only reclaims it once it goes stale, same bounded degradation as before)
      // so a later retry with the SAME idempotency key (same lead, same old appointment, same
      // offered slot, while it's still valid) can reclaim ownership and try again immediately,
      // rather than waiting out the slot's full TTL.
      await this.reschedules.update(op.id, { phaseAStatus: "FAILED" }).catch((markErr) => {
        this.logger.warn(
          { leadId, oldAppointmentId: oldAppointment.id, errorName: markErr instanceof Error ? markErr.name : "unknown" },
          "Failed to mark a reschedule Phase A attempt FAILED after it errored; the row stays PENDING and will only be reclaimable once stale.",
        );
      });
      throw err;
    }

    const opWithNewAppointment = await this.reschedules.update(op.id, { newAppointmentId: newAppointment.id, phaseAStatus: "COMPLETED" });

    const claimedOld = await this.appointments.claimTransition(oldAppointment.id, "BOOKED", "RESCHEDULED");
    if (!claimedOld) {
      // Lost the race for the OLD appointment -- a different, concurrent reschedule (a different
      // offered slot selected at nearly the same moment) already won it. Our own new appointment
      // is now a spurious, orphaned BOOKED row: roll it back through
      // AppointmentCancellationService (CAS BOOKED -> CANCELLED + durable Calendar cleanup,
      // wholesale reuse of Phase 4B -- see the class doc comment). eventType is distinct
      // ("APPOINTMENT_RESCHEDULE_ROLLBACK") so this technical rollback is never confused with a
      // real customer cancellation in the audit trail; cancel() itself touches only the
      // appointment (never leads, never sends a message), so this can never produce a stray
      // CANCEL_PENDING transition or a cancellation WhatsApp message.
      await this.cancellationService.cancel(newAppointment, leadId, "APPOINTMENT_RESCHEDULE_ROLLBACK");
      const winnerOld = await this.appointments.findById(oldAppointment.id);
      const winnerNew = winnerOld ? await this.appointments.findActiveByLeadId(leadId) : null;
      if (!winnerOld || !winnerNew) return { type: "INCONSISTENT" };
      return { type: "RESCHEDULED", oldAppointment: winnerOld, newAppointment: winnerNew };
    }

    await recordAppointmentStatusTransition(this.appointmentStatusHistory, this.logger, {
      appointmentId: claimedOld.id,
      leadId,
      fromStatus: "BOOKED",
      toStatus: "RESCHEDULED",
      eventType: "APPOINTMENT_RESCHEDULED",
    });

    await this.ensureOldCleanup(opWithNewAppointment, claimedOld, leadId);
    return { type: "RESCHEDULED", oldAppointment: claimedOld, newAppointment };
  }

  /**
   * Reclaims Phase A ownership of an EXISTING (not self-created) row -- mirrors
   * AppointmentService.claimExistingAttempt's PENDING/FAILED handling exactly:
   *  - phaseAStatus COMPLETED with no newAppointmentId is data corruption (should never happen --
   *    newAppointmentId and phaseAStatus=COMPLETED are always written together, in the same
   *    update() call) -- treated as "not claimable", the caller returns INCONSISTENT via the
   *    RescheduleInProgressError->handler path... actually surfaced directly as null here so the
   *    caller throws RescheduleInProgressError, which is the safer of the two generic fallbacks
   *    for an unreachable state.
   *  - PENDING and fresh: a real owner is actively working on it right now -- never steal.
   *  - PENDING and stale: the owner likely crashed -- two-step CAS reclaim
   *    (PENDING -> FAILED -> PENDING), so two concurrent stale-reclaimers can't both win.
   *  - FAILED: the previous owner's Phase A attempt errored and was marked FAILED -- reclaimable
   *    in one CAS step (FAILED -> PENDING).
   */
  private async claimPhaseAOwnership(existing: AppointmentReschedule, idempotencyKey: string): Promise<AppointmentReschedule | null> {
    void idempotencyKey; // kept in the signature for future diagnostic logging symmetry with AppointmentService
    if (existing.phaseAStatus === "COMPLETED") return null;

    if (existing.phaseAStatus === "PENDING") {
      const staleCutoff = new Date(Date.now() - PHASE_A_STALE_THRESHOLD_MS);
      if (existing.updatedAt > staleCutoff) return null; // genuinely fresh -- someone else owns it right now
      const forcedFailed = await this.reschedules.claimTransition(existing.id, "PENDING", "FAILED", { updatedBefore: staleCutoff });
      if (!forcedFailed) return null; // lost step 1
      const claimed = await this.reschedules.claimTransition(forcedFailed.id, "FAILED", "PENDING");
      return claimed; // null if lost step 2
    }

    // FAILED
    return this.reschedules.claimTransition(existing.id, "FAILED", "PENDING");
  }

  /**
   * Durable Calendar-cleanup tracking for the OLD appointment's event -- same shape and same
   * never-throws contract as AppointmentCancellationService.ensureCleanup, scoped to this
   * reschedule-op row's Phase B fields instead of a appointment_cancellations row. `op` is the
   * caller's own already-fresh row (just updated with newAppointmentId) -- never re-fetched
   * redundantly here.
   */
  private async ensureOldCleanup(op: AppointmentReschedule, oldAppointment: Appointment, leadId: string): Promise<void> {
    try {
      if (op.status === "COMPLETED") return;

      if (!op.oldCalendarEventId) {
        await this.reschedules.update(op.id, { status: "COMPLETED", completedAt: new Date() });
        return;
      }

      try {
        await this.calendar.deleteEvent(op.oldCalendarEventId); // idempotent on 404/410 -- see GoogleCalendarProvider
        await this.reschedules.update(op.id, {
          status: "COMPLETED",
          completedAt: new Date(),
          attemptCount: op.attemptCount + 1,
          lastAttemptAt: new Date(),
        });
      } catch (err) {
        await this.reschedules.update(op.id, {
          attemptCount: op.attemptCount + 1,
          lastAttemptAt: new Date(),
          errorCode: err instanceof CalendarProviderError ? "CALENDAR_PROVIDER_ERROR" : "UNKNOWN",
        });
        this.logger.warn(
          { appointmentId: oldAppointment.id, leadId, errorName: err instanceof Error ? err.name : "unknown" },
          "Old-Calendar cleanup failed after a reschedule; the old appointment remains correctly RESCHEDULED, cleanup left pending for reconciliation.",
        );
      }
    } catch (err) {
      this.logger.warn(
        { appointmentId: oldAppointment.id, leadId, errorName: err instanceof Error ? err.name : "unknown" },
        "Failed to track old-Calendar-cleanup bookkeeping after a reschedule; the old appointment itself remains correctly RESCHEDULED.",
      );
    }
  }
}
