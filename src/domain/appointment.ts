export type AppointmentStatus="PENDING"|"BOOKED"|"CONFIRMED"|"RESCHEDULED"|"CANCELLED"|"NO_SHOW"|"COMPLETED";
export interface Appointment{ id:string; leadId:string; status:AppointmentStatus; startsAt:Date; endsAt:Date; timezone:string; calendarEventId?:string; meetingProvider?:"GOOGLE_MEET"|"ZOOM"; meetingUrl?:string;
  /** Phase 4C: set on a NEW appointment created by a reschedule -- points at the OLD appointment it
   * replaced (which itself transitions BOOKED -> RESCHEDULED, never updated in place -- see
   * AppointmentRescheduleService). Undefined for an appointment created by a normal booking.
   * Column already existed since migration 001 (appointments.rescheduled_from), unused until now. */
  rescheduledFrom?:string;
}
