export type BookingAttemptStatus = "PENDING" | "COMPLETED" | "FAILED";

export interface BookingAttempt {
  id: string;
  leadId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: BookingAttemptStatus;
  appointmentId?: string;
  providerEventId?: string;
  meetingUrl?: string;
  createdAt: Date;
  /** Last state-changing write to this row (create, update, or a winning claimTransition).
   * Explicitly written by BookingAttemptRepository on every mutation -- never by a DB trigger --
   * so it stays visible and testable from application code. Used for stale-PENDING detection;
   * created_at alone is unsuitable since it never changes across retries. */
  updatedAt: Date;
}
