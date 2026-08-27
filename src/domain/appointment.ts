export type AppointmentStatus="PENDING"|"BOOKED"|"CONFIRMED"|"RESCHEDULED"|"CANCELLED"|"NO_SHOW"|"COMPLETED";
export interface Appointment{ id:string; leadId:string; status:AppointmentStatus; startsAt:Date; endsAt:Date; timezone:string; calendarEventId?:string; meetingProvider?:"GOOGLE_MEET"|"ZOOM"; meetingUrl?:string;}
