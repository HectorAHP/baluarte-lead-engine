import type { CalendarProvider, AppointmentRepository, AppointmentCancellationRepository, AppointmentStatusHistoryRepository, Logger } from "./ports.js";
import type { Appointment } from "../domain/appointment.js";
import { CalendarProviderError } from "../domain/errors.js";
import { recordAppointmentStatusTransition } from "./lead-status-audit.js";

export type CancellationOutcome =
  | { type: "CANCELLED"; appointment: Appointment }
  | { type: "INCONSISTENT" };

/**
 * Channel-agnostic cancellation domain logic -- no WhatsApp concepts here, mirrors how
 * AppointmentService/SlotOfferingService stay independent of the WhatsApp handler layer.
 *
 * Ordering (item 4 of the Phase 4B spec, load-bearing): the appointments.status compare-and-set
 * (BOOKED -> CANCELLED) ALWAYS completes and is durably persisted BEFORE any Google Calendar call
 * is attempted. This is the opposite order from booking (which calls Calendar first, DB second)
 * -- deliberately: we never want to delete the remote event and then fail before recording the
 * cancellation locally, which would leave the DB claiming an appointment is still BOOKED against
 * an event that no longer exists. With DB-first ordering, that specific failure mode is
 * impossible by construction -- the only asymmetric failure that CAN happen is "DB cancelled,
 * Calendar cleanup still pending", which is exactly what ensureCleanup below tracks durably (never
 * just logged) and never blocks or reverts on.
 */
export class AppointmentCancellationService {
  constructor(
    private readonly calendar: CalendarProvider,
    private readonly appointments: AppointmentRepository,
    private readonly cancellations: AppointmentCancellationRepository,
    private readonly appointmentStatusHistory: AppointmentStatusHistoryRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * `appointment` must be a snapshot the caller just fetched (never inferred from messages -- see
   * WhatsAppCancellationHandler, which always sources it from AppointmentRepository). Idempotent:
   * calling this again for an appointment that's already CANCELLED (this call's own doing, or a
   * concurrent winner's) never re-runs the CAS, never writes a second history row, and simply
   * (re)attempts Calendar cleanup if it's still pending.
   */
  async cancel(appointment: Appointment, leadId: string): Promise<CancellationOutcome> {
    if (appointment.status === "CANCELLED") {
      await this.ensureCleanup(appointment, leadId);
      return { type: "CANCELLED", appointment };
    }
    if (appointment.status !== "BOOKED") {
      // Neither BOOKED nor CANCELLED -- unexpected in Phase 4B (no reschedule path exists yet
      // that could produce e.g. RESCHEDULED). A genuine data-consistency violation, not a normal
      // business outcome -- the caller escalates to HUMAN_HANDOFF.
      return { type: "INCONSISTENT" };
    }

    const claimed = await this.appointments.claimTransition(appointment.id, "BOOKED", "CANCELLED");
    if (!claimed) {
      // Lost the CAS -- someone else changed this appointment's status between our read and this
      // write. Re-fetch to find out what actually happened: if it's now CANCELLED, that's a
      // legitimate concurrent winner (or a duplicate of this very request) -- idempotent success,
      // never a second CAS attempt, never a second history row.
      const fresh = await this.appointments.findById(appointment.id);
      if (fresh?.status === "CANCELLED") {
        await this.ensureCleanup(fresh, leadId);
        return { type: "CANCELLED", appointment: fresh };
      }
      return { type: "INCONSISTENT" };
    }

    // We won the CAS -- sole owner of every side effect below. Exactly one history row for this
    // real transition.
    await recordAppointmentStatusTransition(this.appointmentStatusHistory, this.logger, {
      appointmentId: claimed.id,
      leadId,
      fromStatus: "BOOKED",
      toStatus: "CANCELLED",
      eventType: "APPOINTMENT_CANCELLED",
    });

    await this.ensureCleanup(claimed, leadId);
    return { type: "CANCELLED", appointment: claimed };
  }

  /**
   * Durable Calendar-cleanup tracking (item 10 of the spec): a plain log line is not enough to
   * know "there is a remote Google event that still needs deleting" after a process restart --
   * this persists that fact in appointment_cancellations, keyed by a deterministic idempotency
   * key, so it can be reconciled later even if nothing else about this request survives.
   *
   * NEVER throws: a failure anywhere in here (the bookkeeping writes OR the Calendar call itself)
   * is logged (sanitized) and swallowed. The appointment is already correctly CANCELLED by the
   * time this runs -- cleanup is a purely operational concern that must never block or affect the
   * lead-facing confirmation.
   */
  private async ensureCleanup(appointment: Appointment, leadId: string): Promise<void> {
    try {
      const idempotencyKey = `whatsapp-cancel:${leadId}:${appointment.id}`;
      const op =
        (await this.cancellations.tryCreate({
          appointmentId: appointment.id,
          leadId,
          idempotencyKey,
          calendarEventId: appointment.calendarEventId,
        })) ?? (await this.cancellations.findByIdempotencyKey(idempotencyKey));

      if (!op || op.status === "COMPLETED") return;

      if (!op.calendarEventId) {
        // Nothing to delete -- cleanup is trivially already done.
        await this.cancellations.update(op.id, { status: "COMPLETED", completedAt: new Date() });
        return;
      }

      try {
        await this.calendar.deleteEvent(op.calendarEventId); // idempotent on 404/410 -- see GoogleCalendarProvider
        await this.cancellations.update(op.id, {
          status: "COMPLETED",
          completedAt: new Date(),
          attemptCount: op.attemptCount + 1,
          lastAttemptAt: new Date(),
        });
      } catch (err) {
        // Transient/5xx/timeout -- appointment stays CANCELLED (already durably true), cleanup
        // stays PENDING for a later reconciliation attempt. Never reverted, never retried
        // synchronously here (no retry-loop infrastructure in this slice).
        await this.cancellations.update(op.id, {
          attemptCount: op.attemptCount + 1,
          lastAttemptAt: new Date(),
          errorCode: err instanceof CalendarProviderError ? "CALENDAR_PROVIDER_ERROR" : "UNKNOWN",
        });
        this.logger.warn(
          { appointmentId: appointment.id, leadId, errorName: err instanceof Error ? err.name : "unknown" },
          "Calendar cleanup failed after appointment was cancelled locally; appointment remains correctly CANCELLED, cleanup left pending for reconciliation.",
        );
      }
    } catch (err) {
      this.logger.warn(
        { appointmentId: appointment.id, leadId, errorName: err instanceof Error ? err.name : "unknown" },
        "Failed to track Calendar-cleanup bookkeeping after an appointment cancellation; the appointment itself remains correctly CANCELLED.",
      );
    }
  }
}
