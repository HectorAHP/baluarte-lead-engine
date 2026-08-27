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
 * Channel-agnostic reschedule domain logic -- no WhatsApp concepts here, mirrors how
 * AppointmentService/AppointmentCancellationService stay independent of the WhatsApp handler
 * layer.
 *
 * Ordering (item 6 of the Phase 4C spec, load-bearing):
 *   1. idempotency-key ownership (Phase A gate -- see appointment-reschedule.ts)
 *   2. create the new Google Calendar event
 *   3. persist the new appointment BOOKED, rescheduledFrom = old.id, and record its id on the
 *      reschedule-op row (Phase A complete)
 *   4. CAS old appointment BOOKED -> RESCHEDULED
 *   5. record appointment_status_history for the old appointment
 *   6. delete the OLD Calendar event (idempotent, durably tracked -- Phase B, same ensureCleanup
 *      shape as AppointmentCancellationService)
 *
 * The reschedule-op row is created BEFORE the Calendar event and BEFORE the new appointment is
 * persisted -- there is never a point after which a real side effect (a Calendar event, a BOOKED
 * appointment) exists with no persistent, idempotency-keyed record of the operation that created
 * it.
 *
 * Double-booking safety (item 7): nothing in this schema stops two DIFFERENT new appointments
 * (two distinct, concurrent slot selections for the same lead) from both reaching step 3 BOOKED
 * before either attempts step 4's CAS -- appointments_no_overlap is a time-range exclusion, not a
 * per-lead cardinality constraint, and none exists. Only ONE of the two can ever win the step-4
 * CAS; the loser's own new appointment would otherwise be a permanently orphaned second BOOKED
 * row for this lead. The loser detects this (step 4 returns null) and rolls its OWN new
 * appointment back to CANCELLED via cancellationService.cancel() -- reusing Phase 4B's CAS +
 * durable Calendar-cleanup tracking wholesale rather than re-implementing it -- then reports the
 * WINNER's appointment (re-read from AppointmentRepository, never assumed) as the outcome, so the
 * loser's caller converges on the exact same success response as a duplicate-selection retry.
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

    // Ownership is established by tryCreate() alone: winning it outright (non-null) makes THIS
    // call the sole owner of Phase A. Losing it (null -- another caller already holds the row,
    // whether just now or from an earlier attempt) makes this call a non-owner, full stop -- see
    // below for exactly what a non-owner is allowed to do.
    const won = await this.reschedules.tryCreate({
      leadId,
      oldAppointmentId: oldAppointment.id,
      idempotencyKey,
      oldCalendarEventId: oldAppointment.calendarEventId,
    });
    const op = won ?? (await this.reschedules.findByIdempotencyKey(idempotencyKey));
    if (!op) throw new RescheduleInProgressError(idempotencyKey); // lost tryCreate AND a re-fetch found nothing -- never hang, treat as in-progress

    if (op.newAppointmentId) {
      // Phase A already completed (this call's own earlier attempt, a duplicate selection, or a
      // duplicate webhook that slipped past upstream dedup) -- idempotent success, never a second
      // Calendar event, never a second CAS. True regardless of ownership.
      const existingNew = await this.appointments.findById(op.newAppointmentId);
      if (!existingNew) return { type: "INCONSISTENT" }; // data corruption -- never auto-recovered
      const currentOld = await this.appointments.findById(oldAppointment.id);
      return { type: "RESCHEDULED", oldAppointment: currentOld ?? oldAppointment, newAppointment: existingNew };
    }

    if (!won) {
      // Not the owner, AND Phase A isn't done yet -- someone else (the real owner) is actively
      // working on this exact selection right now, or died before finishing it. Never race
      // Calendar twice for the same idempotency key; never silently steal or retry the row.
      // Deliberately no stale-reclaim path here -- see RescheduleInProgressError's doc comment for
      // why that's an acceptable, bounded, self-healing tradeoff for this slice.
      throw new RescheduleInProgressError(idempotencyKey);
    }

    if (oldAppointment.status !== "BOOKED") {
      // Never BOOKED at all (already CANCELLED by a concurrent cancellation, or any other
      // unexpected status) -- a genuine data-consistency violation, not a normal business
      // outcome. Never attempts Calendar or persists anything.
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
      // Phase A failed (Calendar or the appointment insert) -- the op row stays with
      // newAppointmentId still null, so a later retry (a fresh inbound turn with the SAME
      // idempotency key -- same lead, same old appointment, same offered slot, while it's still
      // valid) is free to try again from here. Nothing was left inconsistent: no new appointment
      // exists, old is untouched.
      throw err;
    }

    const opWithNewAppointment = await this.reschedules.update(op.id, { newAppointmentId: newAppointment.id });

    const claimedOld = await this.appointments.claimTransition(oldAppointment.id, "BOOKED", "RESCHEDULED");
    if (!claimedOld) {
      // Lost the race for the OLD appointment -- a different, concurrent reschedule (a different
      // offered slot selected at nearly the same moment) already won it. Our own new appointment
      // is now a spurious, orphaned BOOKED row: roll it back through
      // AppointmentCancellationService (CAS BOOKED -> CANCELLED + durable Calendar cleanup,
      // wholesale reuse of Phase 4B -- see the class doc comment), then report the ACTUAL current
      // appointment so this caller converges on the same success response as the winner's.
      await this.cancellationService.cancel(newAppointment, leadId);
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
