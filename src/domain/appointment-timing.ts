import type { Appointment } from "./appointment.js";

/**
 * Pre-launch hardening: the single source of truth for "does this appointment still count as an
 * active, upcoming commitment" -- an appointment is upcoming-active ONLY if it is still `BOOKED`
 * AND its end time hasn't passed yet. A `BOOKED` row whose `endsAt` is already in the past (the
 * lead simply never came back to interact after the meeting time, or the meeting happened but
 * nothing ever recorded an outcome) is deliberately NOT upcoming.
 *
 * This function NEVER infers COMPLETED/NO_SHOW from the time comparison alone -- distinguishing
 * "the meeting actually happened" from "the lead just never showed up" requires real evidence
 * (an advisor's own confirmation, a future dedicated flow) that this project does not have and
 * will not fabricate. A stale `BOOKED` row past its end time is reported as "PAST BOOKED /
 * unresolved outcome" -- see WhatsAppPastBookedRecoveryHandler -- never silently reclassified.
 *
 * Every caller across the app layer that previously used `appointments.findActiveByLeadId` /
 * `listActiveByLeadId`'s result to mean "this lead has a real, current appointment to act
 * around" should filter/gate on this helper, not on `status === "BOOKED"` alone -- see the
 * pre-launch hardening report for the full audit of call sites.
 */
export function isUpcomingBooked(appointment: Appointment, now: Date): boolean {
  return appointment.status === "BOOKED" && appointment.endsAt > now;
}
