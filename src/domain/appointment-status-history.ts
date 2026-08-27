import type { AppointmentStatus } from "./appointment.js";

/**
 * One completed appointments.status transition. Same contract as LeadStatusHistoryEntry (see
 * lead-status-history.ts), via the companion recordAppointmentStatusTransition helper. No caller
 * exists yet in Phase 4A -- appointments are only ever created directly as BOOKED today (see
 * AppointmentService.completeBooking), never transitioned afterward -- this type/table/repository
 * exist ready for Phase 4B (cancel) / 4C (reschedule) / 4E (no-show/completed).
 */
export interface AppointmentStatusHistoryEntry {
  id: string;
  appointmentId: string;
  leadId: string;
  fromStatus: AppointmentStatus;
  toStatus: AppointmentStatus;
  eventType: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}
