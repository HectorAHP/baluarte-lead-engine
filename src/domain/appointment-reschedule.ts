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

/**
 * Phase A ownership state, independent of the Phase B `status` field above/below (that one is
 * ONLY ever about old-Calendar cleanup, never about Phase A) -- mirrors BookingAttemptStatus's
 * PENDING/FAILED/COMPLETED exactly, with the same reclaim semantics:
 *  - PENDING: owned, in progress (fresh) or abandoned (stale -- see PHASE_A_STALE_THRESHOLD_MS in
 *    appointment-reschedule-service.ts).
 *  - FAILED: Phase A (Calendar createEvent or the appointment insert) threw -- reclaimable
 *    immediately by a later caller via claimTransition('FAILED','PENDING'), so a transient
 *    Calendar error never locks out a legitimate retry of the SAME still-valid slot selection.
 *  - COMPLETED: newAppointmentId is set. (No separate signal needed beyond newAppointmentId's own
 *    presence, but this mirrors booking_attempts' vocabulary for symmetry/readability.)
 */
export type AppointmentReschedulePhaseAStatus = "PENDING" | "FAILED" | "COMPLETED";

export interface AppointmentReschedule {
  id: string;
  leadId: string;
  oldAppointmentId: string;
  /** Null until Phase A completes (Calendar event created + new appointment persisted). */
  newAppointmentId?: string;
  /**
   * Persisted the MOMENT the remote Calendar event id is known -- i.e. immediately after
   * calendar.createEvent() succeeds, BEFORE the new appointment row is even inserted. This is
   * deliberately a separate write from newAppointmentId: if the process dies in the gap between
   * "Calendar event created" and "appointment persisted", newCalendarEventId is still the one
   * persistent reference to that event, so it is never truly orphaned -- a reconciliation query
   * (`appointment_reschedules WHERE new_calendar_event_id IS NOT NULL AND new_appointment_id IS
   * NULL`) can always find and clean it up. See the Phase 4C hardening report, item 6.
   */
  newCalendarEventId?: string;
  phaseAStatus: AppointmentReschedulePhaseAStatus;
  /** Deterministic: `whatsapp-reschedule:{leadId}:{oldAppointmentId}:{offeredSlotId}` -- the
   * database's UNIQUE constraint on this column is the actual duplicate-prevention mechanism,
   * same convention as booking_attempts.idempotencyKey / appointment_cancellations.idempotencyKey. */
  idempotencyKey: string;
  /** Snapshotted at reschedule time, not re-read from appointments on every cleanup retry -- same
   * rationale as AppointmentCancellation.calendarEventId. Undefined means the old appointment
   * never had a Calendar event (cleanup is then trivially already done). */
  oldCalendarEventId?: string;
  /** Phase B (old-Calendar cleanup) status -- NEVER Phase A's. See phaseAStatus above. */
  status: AppointmentRescheduleCleanupStatus;
  attemptCount: number;
  lastAttemptAt?: Date;
  completedAt?: Date;
  /** Closed, code-controlled failure classification -- never a raw provider error message. Used
   * by BOTH phases (a Phase A Calendar failure and a Phase B cleanup failure can each set this;
   * whichever failed most recently wins, since both are the same closed vocabulary). */
  errorCode?: string;
  createdAt: Date;
  updatedAt: Date;
}
