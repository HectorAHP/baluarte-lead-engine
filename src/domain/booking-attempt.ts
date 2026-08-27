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
}
