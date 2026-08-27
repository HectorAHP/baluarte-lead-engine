/**
 * Common delivery-tracking record for every proactive outbound message Phase 4 schedules against
 * an appointment. One generalized shape covers all four kinds -- see migration
 * 013_phase4_audit_and_deliveries.sql. No scheduler/sweep/sender exists yet in Phase 4A; this type
 * and its repository are foundation only.
 */
export type DeliveryType = "REMINDER_24H" | "REMINDER_2H" | "POST_MEETING_FOLLOWUP" | "NO_SHOW_NUDGE";

export type DeliveryStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface AppointmentMessageDelivery {
  id: string;
  appointmentId: string;
  leadId: string;
  deliveryType: DeliveryType;
  status: DeliveryStatus;
  scheduledFor: Date;
  /**
   * Deterministically derived by the (future) scheduler as `{deliveryType}:{appointmentId}` --
   * same idempotency-key convention as booking_attempts/whatsapp-booking. The database's own
   * UNIQUE constraint on this column, not application logic, is what guarantees two equivalent
   * deliveries for the same appointment can never coexist.
   */
  idempotencyKey: string;
  attemptCount: number;
  lastAttemptAt?: Date;
  completedAt?: Date;
  providerMessageId?: string;
  /** Closed, code-controlled failure classification -- never a raw provider error message. */
  errorCode?: string;
  createdAt: Date;
  updatedAt: Date;
}
