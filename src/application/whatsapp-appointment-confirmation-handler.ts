import type { AppointmentRepository, AppointmentStatusHistoryRepository } from "./ports.js";
import type { Lead } from "../domain/lead.js";
import { assertTransition } from "../domain/state-machine.js";
import { AppointmentConfirmationInconsistentError } from "../domain/errors.js";
import { recordLeadStatusTransition, recordAppointmentStatusTransition } from "./lead-status-audit.js";
import { sendAndPersistReply, type ConfirmationTurnHandler } from "./whatsapp-inbound-service.js";
import { escalateToHuman, type BookingOutcomeDeps } from "./booking-outcome-dispatch.js";
import { conversationalFirstName } from "../domain/conversation-name.js";
import { buildAppointmentConfirmedReplyMessage, APPOINTMENT_CONFIRMATION_TECHNICAL_ERROR_MESSAGE } from "../domain/message-templates.js";

/** leads/conversations/messaging/messages/leadStatusHistory/logger come from BookingOutcomeDeps
 * (reused, not redeclared) -- same convention as WhatsAppCancellationHandlerDeps. */
export interface WhatsAppAppointmentConfirmationHandlerDeps extends BookingOutcomeDeps {
  appointments: AppointmentRepository;
  appointmentStatusHistory: AppointmentStatusHistoryRepository;
}

/**
 * Fase 7A -- handles the single turn where a BOOKED lead replies affirmatively to the 24h
 * reminder's confirmation request. ONLY ever invoked by whatsapp-inbound-service.ts when BOTH (a)
 * resolvePendingAppointmentConfirmation says the last outbound message was the confirmation
 * request, AND (b) isAppointmentConfirmationReply matched the inbound text -- both checks happen
 * INLINE in the routing chain (same convention as the fiscal-welcome-menu pending-state check),
 * never inside this handler, so a BOOKED lead's every other message (a plain question, a
 * cancellation/reschedule request, an unrecognized reply) is completely unaffected by this
 * handler existing -- it falls through to the exact same reschedule-intent / cancellation-intent /
 * generic-fallback chain that already owned it before Fase 7A (Fase 7A spec item 6: "no duplicar
 * lógica" -- this handler never re-implements cancellation/reschedule interpretation itself).
 *
 * The source of truth for "which appointment" is always AppointmentRepository -- never inferred
 * from message history, same principle as WhatsAppCancellationHandler/WhatsAppRescheduleHandler.
 */
export class WhatsAppAppointmentConfirmationHandler implements ConfirmationTurnHandler {
  constructor(private readonly deps: WhatsAppAppointmentConfirmationHandlerDeps) {}

  async handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date }): Promise<void> {
    const { lead, conversationId, whatsappUserId } = params;

    // Guard mirrors WhatsAppCancellationHandler's own -- this handler is only ever dispatched for
    // a BOOKED lead (see the routing check in whatsapp-inbound-service.ts), but re-asserted here
    // so this class's own contract is self-evident and never silently relies on caller discipline
    // alone.
    if (lead.status !== "BOOKED") return;

    try {
      const active = await this.deps.appointments.listActiveByLeadId(lead.id);
      if (active.length > 1) throw new AppointmentConfirmationInconsistentError(lead.id, "MULTIPLE_APPOINTMENTS");
      if (active.length === 0) throw new AppointmentConfirmationInconsistentError(lead.id, "NO_APPOINTMENT");
      const appointment = active[0];

      const claimed = await this.deps.appointments.claimTransition(appointment.id, "BOOKED", "CONFIRMED");
      if (claimed) {
        await recordAppointmentStatusTransition(this.deps.appointmentStatusHistory, this.deps.logger, {
          appointmentId: claimed.id,
          leadId: lead.id,
          fromStatus: "BOOKED",
          toStatus: "CONFIRMED",
          eventType: "APPOINTMENT_ATTENDANCE_CONFIRMED",
        });
      }
      // Lost the CAS or it was already CONFIRMED (a duplicate "sí" arriving as a second, genuinely
      // separate inbound after the first already completed this transition) -- either way the
      // appointment is durably CONFIRMED by the time we reach here; re-check below rather than
      // trusting `claimed`.

      await this.ensureLeadConfirmed(lead);
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildAppointmentConfirmedReplyMessage(conversationalFirstName(lead)));
    } catch (err) {
      await this.handleError(err, lead, conversationId, whatsappUserId);
    }
  }

  /** Set-once/idempotent, re-fetches the lead's current status rather than trusting the caller's
   * `lead` snapshot -- same reasoning as WhatsAppCancellationHandler.ensureLeadCancelled. */
  private async ensureLeadConfirmed(lead: Lead): Promise<void> {
    const current = (await this.deps.leads.findById(lead.id)) ?? lead;
    if (current.status === "CONFIRMED") return;
    assertTransition(current.status, "CONFIRMED");
    await this.deps.leads.update(current.id, { status: "CONFIRMED" });
    await recordLeadStatusTransition(this.deps.leadStatusHistory, this.deps.logger, {
      leadId: current.id,
      fromStatus: current.status,
      toStatus: "CONFIRMED",
      eventType: "APPOINTMENT_ATTENDANCE_CONFIRMED",
    });
  }

  private async handleError(err: unknown, lead: Lead, conversationId: string, whatsappUserId: string): Promise<void> {
    if (err instanceof AppointmentConfirmationInconsistentError) {
      this.deps.logger.warn(
        { leadId: lead.id, conversationId, errorName: err.name, reason: err.reason },
        "Appointment confirmation data-consistency error -- escalating to human handoff instead of retrying automatically.",
      );
      await escalateToHuman(this.deps, lead, conversationId, whatsappUserId, "CONFIRMATION_APPOINTMENT_INCONSISTENCY");
      return;
    }
    this.deps.logger.warn(
      { leadId: lead.id, conversationId, errorName: err instanceof Error ? err.name : "unknown" },
      "Recoverable technical error while processing an appointment confirmation; no state change.",
    );
    await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, APPOINTMENT_CONFIRMATION_TECHNICAL_ERROR_MESSAGE);
  }
}
