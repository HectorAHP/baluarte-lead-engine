/**
 * Tracks whether Google Calendar cleanup for one appointment cancellation has completed --
 * deliberately NOT booking_attempts (models creating a booking, wrong semantics for deleting one)
 * and NOT appointment_message_deliveries (models proactive outbound messages, wrong semantics for
 * a Calendar-API side effect). See migration 014_appointment_cancellations.sql.
 */
export type AppointmentCancellationCleanupStatus = "PENDING" | "COMPLETED";

export interface AppointmentCancellation {
  id: string;
  appointmentId: string;
  leadId: string;
  /** Deterministic: `whatsapp-cancel:{leadId}:{appointmentId}` -- the database's UNIQUE
   * constraint on this column, not application logic, is the actual duplicate-prevention
   * mechanism (same convention as booking_attempts.idempotencyKey / offer/reminder keys). */
  idempotencyKey: string;
  /** Snapshotted at cancellation time, not re-read from appointments on every cleanup retry --
   * keeps a reconciliation attempt self-contained even if appointments.calendarEventId is ever
   * cleared/changed by a future phase. Undefined means the appointment never had a Calendar event
   * (cleanup is then trivially already done). */
  calendarEventId?: string;
  status: AppointmentCancellationCleanupStatus;
  attemptCount: number;
  lastAttemptAt?: Date;
  completedAt?: Date;
  /** Closed, code-controlled failure classification -- never a raw provider error message. */
  errorCode?: string;
  createdAt: Date;
  updatedAt: Date;
}
