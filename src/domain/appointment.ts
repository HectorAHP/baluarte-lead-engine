/**
 * EXPIRED (Fase 7H): a BOOKED appointment whose endsAt has already passed and that was never
 * resolved (never cancelled, never marked COMPLETED/NO_SHOW by AppointmentCompletionService)
 * before a NEW appointment got booked for the same lead. Means ONLY "this appointment's time
 * window is over and it was superseded by a fresh booking" -- carries ZERO information about
 * whether the lead attended it or not (never confuse with COMPLETED/NO_SHOW, both of which ARE
 * attendance determinations). The sole writer is AppointmentService's private
 * expirePriorStaleBookedAppointments, called immediately before every new appointment is created,
 * strictly gated on endsAt < now -- a future/current BOOKED appointment is never touched. Distinct
 * from RESCHEDULED, which AppointmentRescheduleService sets only when a NEW appointment explicitly
 * replaces this one via the reschedule flow (with a rescheduledFrom link) -- EXPIRED is for the
 * case where an old appointment was simply abandoned (e.g. a HUMAN_HANDOFF recovery followed by an
 * independent fresh booking, never a reschedule) and would otherwise sit forever as a second
 * "active" BOOKED row, which is exactly what made WhatsAppCancellationHandler/
 * WhatsAppRescheduleHandler's findTargetAppointment see ">1 active" and escalate every future
 * cancel/reschedule attempt to HUMAN_HANDOFF for that lead.
 */
export type AppointmentStatus="PENDING"|"BOOKED"|"CONFIRMED"|"RESCHEDULED"|"CANCELLED"|"NO_SHOW"|"COMPLETED"|"EXPIRED";
export interface Appointment{ id:string; leadId:string; status:AppointmentStatus; startsAt:Date; endsAt:Date; timezone:string; calendarEventId?:string; meetingProvider?:"GOOGLE_MEET"|"ZOOM"; meetingUrl?:string;
  /** Phase 4C: set on a NEW appointment created by a reschedule -- points at the OLD appointment it
   * replaced (which itself transitions BOOKED -> RESCHEDULED, never updated in place -- see
   * AppointmentRescheduleService). Undefined for an appointment created by a normal booking.
   * Column already existed since migration 001 (appointments.rescheduled_from), unused until now. */
  rescheduledFrom?:string;
}
