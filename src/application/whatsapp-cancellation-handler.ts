import type { AppointmentRepository } from "./ports.js";
import type { Lead } from "../domain/lead.js";
import type { Appointment } from "../domain/appointment.js";
import { assertTransition } from "../domain/state-machine.js";
import { AppointmentCancellationInconsistentError } from "../domain/errors.js";
import { isCancellationRequest } from "../domain/cancellation-intent-detection.js";
import { parseCancelConfirmation } from "../domain/cancel-confirmation-parser.js";
import { recordLeadStatusTransition } from "./lead-status-audit.js";
import { sendAndPersistReply, type CancellationTurnHandler } from "./whatsapp-inbound-service.js";
import { escalateToHuman, type BookingOutcomeDeps } from "./booking-outcome-dispatch.js";
import type { AppointmentCancellationService } from "./appointment-cancellation-service.js";
import {
  buildCancelConfirmationPromptMessage, buildCancelConfirmationRepromptMessage,
  CANCELLATION_ABORTED_MESSAGE, CANCELLATION_CONFIRMED_MESSAGE, CANCELLATION_TECHNICAL_ERROR_MESSAGE,
  formatSlotForDisplay,
} from "../domain/message-templates.js";
import { config } from "../config.js";

/** leads/conversations/messaging/messages/leadStatusHistory/logger come from BookingOutcomeDeps
 * (reused, not redeclared) -- this handler shares escalateToHuman/sendAndPersistReply's exact
 * dependency shape by construction. */
export interface WhatsAppCancellationHandlerDeps extends BookingOutcomeDeps {
  appointments: AppointmentRepository;
  cancellationService: AppointmentCancellationService;
}

/**
 * Handles ONE inbound WhatsApp turn for a lead that is BOOKED (interpreting free text as a
 * possible cancellation request) or CANCEL_PENDING (interpreting a confirm/decline/ambiguous
 * reply). Reuses sendAndPersistReply and booking-outcome-dispatch.ts's escalateToHuman -- no
 * send/dedup/handoff logic reimplemented here, same pattern as WhatsAppBookingHandler.
 *
 * The source of truth for "which appointment" is always AppointmentRepository -- never inferred
 * from message history (item 3 of the Phase 4B spec).
 *
 * Wired into whatsapp-inbound-service.ts (routed only for BOOKED/CANCEL_PENDING) and constructed
 * in app.ts only when WHATSAPP_CANCELLATION_ENABLED is true.
 */
export class WhatsAppCancellationHandler implements CancellationTurnHandler {
  constructor(
    private readonly deps: WhatsAppCancellationHandlerDeps,
    private readonly advisorTimezone: string = config.ADVISOR_TIMEZONE,
  ) {}

  async handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date }): Promise<void> {
    const { lead, conversationId, whatsappUserId, inboundText } = params;

    // Guard: this handler only ever acts on BOOKED or CANCEL_PENDING. Anything else is a no-op --
    // no lookup, no message, no state change.
    if (lead.status !== "BOOKED" && lead.status !== "CANCEL_PENDING") return;

    try {
      if (lead.status === "BOOKED") {
        await this.handleIntentTurn(lead, conversationId, whatsappUserId, inboundText);
      } else {
        await this.handleConfirmationTurn(lead, conversationId, whatsappUserId, inboundText);
      }
    } catch (err) {
      await this.handleError(err, lead, conversationId, whatsappUserId);
    }
  }

  /** BOOKED: only a recognized cancellation-intent message does anything at all -- anything else
   * is silently ignored, matching the existing "no automated reply" fallback for a BOOKED lead
   * when cancellation isn't the topic. */
  private async handleIntentTurn(lead: Lead, conversationId: string, whatsappUserId: string, inboundText: string): Promise<void> {
    if (!isCancellationRequest(inboundText)) return;

    const appointment = await this.findTargetAppointment(lead.id);
    if (appointment === "INCONSISTENT") throw new AppointmentCancellationInconsistentError(lead.id, "MULTIPLE_APPOINTMENTS");
    if (!appointment) throw new AppointmentCancellationInconsistentError(lead.id, "NO_APPOINTMENT");

    await this.transitionLead(lead, "CANCEL_PENDING", "CANCELLATION_REQUESTED");
    await this.replyConfirmationPrompt(lead.id, conversationId, whatsappUserId, appointment);
  }

  /** CANCEL_PENDING: interpret the reply. AMBIGUOUS never cancels -- it just re-asks. */
  private async handleConfirmationTurn(lead: Lead, conversationId: string, whatsappUserId: string, inboundText: string): Promise<void> {
    const result = parseCancelConfirmation(inboundText);

    if (result === "AMBIGUOUS") {
      const appointment = await this.findTargetAppointment(lead.id);
      if (appointment === "INCONSISTENT") throw new AppointmentCancellationInconsistentError(lead.id, "MULTIPLE_APPOINTMENTS");
      if (!appointment) throw new AppointmentCancellationInconsistentError(lead.id, "NO_APPOINTMENT");
      const when = formatSlotForDisplay(appointment.startsAt, this.advisorTimezone);
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, buildCancelConfirmationRepromptMessage(when));
      return;
    }

    if (result === "DECLINE") {
      await this.transitionLead(lead, "BOOKED", "CANCELLATION_ABORTED");
      await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, CANCELLATION_ABORTED_MESSAGE);
      return;
    }

    // CONFIRM
    const appointment = await this.findTargetAppointment(lead.id);
    if (appointment === "INCONSISTENT") throw new AppointmentCancellationInconsistentError(lead.id, "MULTIPLE_APPOINTMENTS");
    if (!appointment) throw new AppointmentCancellationInconsistentError(lead.id, "NO_APPOINTMENT");

    const outcome = await this.deps.cancellationService.cancel(appointment, lead.id);
    if (outcome.type === "INCONSISTENT") throw new AppointmentCancellationInconsistentError(lead.id, "UNEXPECTED_STATUS");

    // Idempotent no-op if already CANCELLED (e.g. a duplicate "1" arriving as a second, genuinely
    // separate inbound after the first already completed this transition).
    await this.ensureLeadCancelled(lead);
    await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, CANCELLATION_CONFIRMED_MESSAGE);
  }

  /**
   * The source of truth for "which appointment this cancellation is about" -- never inferred from
   * messages. Exactly one BOOKED appointment: return it. Zero BOOKED appointments: check whether
   * the most recent appointment for this lead is already CANCELLED (an idempotent retry of a
   * cancellation that already completed) and return that; otherwise there was never a real
   * appointment to act on. More than one BOOKED appointment: a genuine data-consistency
   * violation, returned as "INCONSISTENT" rather than silently picking one.
   */
  private async findTargetAppointment(leadId: string): Promise<Appointment | "INCONSISTENT" | null> {
    const active = await this.deps.appointments.listActiveByLeadId(leadId);
    if (active.length > 1) return "INCONSISTENT";
    if (active.length === 1) return active[0];
    const mostRecent = await this.deps.appointments.findMostRecentByLeadId(leadId);
    return mostRecent?.status === "CANCELLED" ? mostRecent : null;
  }

  private async transitionLead(lead: Lead, target: Lead["status"], eventType: string): Promise<Lead> {
    assertTransition(lead.status, target);
    const updated = await this.deps.leads.update(lead.id, { status: target });
    await recordLeadStatusTransition(this.deps.leadStatusHistory, this.deps.logger, {
      leadId: lead.id, fromStatus: lead.status, toStatus: target, eventType,
    });
    return updated;
  }

  /**
   * Set-once/idempotent -- deliberately RE-FETCHES the lead's current status rather than trusting
   * the caller's `lead` parameter, which can be stale (e.g. two turns racing the same
   * CANCEL_PENDING "1" confirmation, each holding the pre-cancellation snapshot from before the
   * other's write landed). Without the re-fetch, a second, genuinely concurrent "1" would find
   * appointments.cancel() correctly idempotent (the CAS there already protects it) but could still
   * try to write leads.status CANCEL_PENDING -> CANCELLED a second time using its own stale
   * fromStatus, producing a duplicate lead_status_history row for the same real event -- exactly
   * what item 9 of the Phase 4B spec forbids. Re-fetching narrows that window to the gap between
   * this read and the write immediately below, the same mitigation already accepted elsewhere in
   * this codebase (e.g. WhatsAppBookingHandler's "appointment guard, once more, immediately before
   * booking").
   */
  private async ensureLeadCancelled(lead: Lead): Promise<Lead> {
    const current = (await this.deps.leads.findById(lead.id)) ?? lead;
    if (current.status === "CANCELLED") return current;
    return this.transitionLead(current, "CANCELLED", "APPOINTMENT_CANCELLED");
  }

  private async replyConfirmationPrompt(leadId: string, conversationId: string, whatsappUserId: string, appointment: Appointment): Promise<void> {
    const when = formatSlotForDisplay(appointment.startsAt, this.advisorTimezone);
    await sendAndPersistReply(this.deps, leadId, conversationId, whatsappUserId, buildCancelConfirmationPromptMessage(when));
  }

  /**
   * AppointmentCancellationInconsistentError -- always escalates to HUMAN_HANDOFF (no appointment
   * found, more than one, or an unexpected status). Never for 404/410 Calendar, a normal retry, or
   * a duplicate webhook -- those are already fully absorbed without ever throwing (see
   * AppointmentCancellationService.ensureCleanup, and the message-dedup check upstream in
   * handleInboundWhatsAppText). Anything else is a recoverable technical error -- message only, no
   * state change.
   */
  private async handleError(err: unknown, lead: Lead, conversationId: string, whatsappUserId: string): Promise<void> {
    if (err instanceof AppointmentCancellationInconsistentError) {
      this.deps.logger.warn(
        { leadId: lead.id, conversationId, errorName: err.name, reason: err.reason },
        "Appointment cancellation data-consistency error -- escalating to human handoff instead of retrying automatically.",
      );
      await escalateToHuman(this.deps, lead, conversationId, whatsappUserId, "CANCELLATION_APPOINTMENT_INCONSISTENCY");
      return;
    }
    this.deps.logger.warn(
      { leadId: lead.id, conversationId, errorName: err instanceof Error ? err.name : "unknown" },
      "Recoverable technical error while processing a cancellation; no state change.",
    );
    await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, CANCELLATION_TECHNICAL_ERROR_MESSAGE);
  }
}
