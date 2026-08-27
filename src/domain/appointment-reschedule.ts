/**
 * Tracks ONE reschedule operation end-to-end -- deliberately NOT appointment_cancellations (that
 * table means "the customer cancelled this appointment"; a superseded-by-reschedule appointment
 * was never cancelled by the customer, it was replaced, and conflating the two would corrupt any
 * future "how many customers cancelled" reporting built on appointment_cancellations) and NOT
 * booking_attempts (its idempotency fingerprint/ownership model is entirely about "create A
 * booking" and has no concept of an old appointment being superseded; extending it would blur a
 * stable Phase 3C table's semantics for a Phase 4C concern). See
 * migration 015_appointment_reschedules.sql.
 *
 * One row serves two sequential phases of the SAME reschedule:
 *  - Phase A ("create the new appointment"): guarded by idempotencyKey's uniqueness -- the
 *    tryCreate() winner is the sole owner of calling Calendar and persisting the new appointment.
 *    newAppointmentId is null until this phase completes; its presence is the phase boundary, no
 *    separate enum needed for it.
 *  - Phase B ("clean up the OLD appointment's Calendar event"): status/attemptCount/errorCode,
 *    same shape and meaning as AppointmentCancellation's cleanup tracking, just scoped to this
 *    reschedule's old event instead of a cancelled one.
 */
export type AppointmentRescheduleCleanupStatus = "PENDING" | "COMPLETED";

export interface AppointmentReschedule {
  id: string;
  leadId: string;
  oldAppointmentId: string;
  /** Null until Phase A completes (Calendar event created + new appointment persisted). */
  newAppointmentId?: string;
  /** Deterministic: `whatsapp-reschedule:{leadId}:{oldAppointmentId}:{offeredSlotId}` -- the
   * database's UNIQUE constraint on this column is the actual duplicate-prevention mechanism,
   * same convention as booking_attempts.idempotencyKey / appointment_cancellations.idempotencyKey. */
  idempotencyKey: string;
  /** Snapshotted at reschedule time, not re-read from appointments on every cleanup retry -- same
   * rationale as AppointmentCancellation.calendarEventId. Undefined means the old appointment
   * never had a Calendar event (cleanup is then trivially already done). */
  oldCalendarEventId?: string;
  status: AppointmentRescheduleCleanupStatus;
  attemptCount: number;
  lastAttemptAt?: Date;
  completedAt?: Date;
  /** Closed, code-controlled failure classification -- never a raw provider error message. */
  errorCode?: string;
  createdAt: Date;
  updatedAt: Date;
}
