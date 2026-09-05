import type {
  AppointmentRepository, LeadRepository, ConversationRepository, MessageRepository, MessagingProvider,
  AppointmentStatusHistoryRepository, LeadStatusHistoryRepository, AppointmentMessageDeliveryRepository, Logger,
} from "./ports.js";
import type { Appointment, AppointmentStatus } from "../domain/appointment.js";
import { assertTransition } from "../domain/state-machine.js";
import { recordAppointmentStatusTransition, recordLeadStatusTransition } from "./lead-status-audit.js";
import { conversationalFirstName } from "../domain/conversation-name.js";
import { buildNoShowNudgeMessage } from "../domain/message-templates.js";
import { MessagingProviderError } from "../domain/errors.js";
import type { LeadStatus } from "../domain/lead.js";

export type CompletionOutcome =
  | { type: "COMPLETED" | "NO_SHOW"; appointment: Appointment }
  | { type: "NOT_FOUND" }
  | { type: "INCONSISTENT" };

const LEAD_TARGET_FOR_TERMINAL: Record<"COMPLETED" | "NO_SHOW", LeadStatus> = {
  COMPLETED: "MEETING_COMPLETED",
  NO_SHOW: "NO_SHOW",
};

/**
 * Fase 7A -- docs/PHASE4-DESIGN.md §9: no-show/completed is NEVER inferred automatically (no
 * trusted signal exists in this codebase for "did the meeting actually happen" -- see
 * isUpcomingBooked's own doc comment). Both outcomes are driven exclusively by Héctor's own
 * explicit action via the two admin endpoints in app.ts (mark-completed / mark-no-show),
 * protected by a static admin token. NO_SHOW_DETECTION_ENABLED gates nothing in THIS service --
 * it's reserved for a hypothetical future automatic *nudge-to-Héctor* (never an automatic status
 * change), which does not exist yet either (see the Fase 7A report's explicit "not built" list).
 *
 * Same CAS-then-reconcile shape as AppointmentCancellationService.cancel -- accepts BOTH BOOKED
 * and CONFIRMED as the expected starting status (state-machine.ts already allows either ->
 * MEETING_COMPLETED/NO_SHOW), idempotent on a repeat call for an appointment already at the
 * target status, and returns INCONSISTENT (never silently overwrites) for any other starting
 * status.
 */
export class AppointmentCompletionService {
  constructor(
    private readonly appointments: AppointmentRepository,
    private readonly leads: LeadRepository,
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly messaging: MessagingProvider,
    private readonly appointmentStatusHistory: AppointmentStatusHistoryRepository,
    private readonly leadStatusHistory: LeadStatusHistoryRepository,
    private readonly appointmentMessageDeliveries: AppointmentMessageDeliveryRepository,
    private readonly noShowNudgeTemplateName: string,
    private readonly templateLanguageCode: string,
    private readonly logger: Logger,
  ) {}

  async markCompleted(appointmentId: string): Promise<CompletionOutcome> {
    return this.closeOut(appointmentId, "COMPLETED");
  }

  async markNoShow(appointmentId: string): Promise<CompletionOutcome> {
    const outcome = await this.closeOut(appointmentId, "NO_SHOW");
    if (outcome.type === "NO_SHOW") {
      // Fase 7A spec item 9 / docs/PHASE4-DESIGN.md §9: "mensaje opcional al lead (una sola vez,
      // disparado por la propia transición, no por un job separado)". Never blocks or reverts the
      // transition above on a send failure -- same "the real transition already succeeded and
      // must not be reverted just because a best-effort side effect failed" principle as
      // recordLeadStatusTransition/AppointmentCancellationService.ensureCleanup.
      await this.sendNoShowNudge(outcome.appointment);
    }
    return outcome;
  }

  private async closeOut(appointmentId: string, terminal: "COMPLETED" | "NO_SHOW"): Promise<CompletionOutcome> {
    const appointment = await this.appointments.findById(appointmentId);
    if (!appointment) return { type: "NOT_FOUND" };

    if (appointment.status === terminal) return { type: terminal, appointment }; // idempotent retry
    if (appointment.status !== "BOOKED" && appointment.status !== "CONFIRMED") return { type: "INCONSISTENT" };

    const claimed = await this.appointments.claimTransition(appointment.id, appointment.status, terminal);
    if (!claimed) {
      const fresh = await this.appointments.findById(appointment.id);
      if (fresh?.status === terminal) return { type: terminal, appointment: fresh }; // concurrent winner -- idempotent success
      return { type: "INCONSISTENT" };
    }

    await recordAppointmentStatusTransition(this.appointmentStatusHistory, this.logger, {
      appointmentId: claimed.id,
      leadId: claimed.leadId,
      fromStatus: appointment.status as AppointmentStatus,
      toStatus: terminal,
      eventType: terminal === "COMPLETED" ? "APPOINTMENT_MARKED_COMPLETED" : "APPOINTMENT_MARKED_NO_SHOW",
    });

    await this.ensureLeadTransitioned(claimed.leadId, terminal);
    return { type: terminal, appointment: claimed };
  }

  /** Re-fetches the lead's CURRENT status rather than trusting a caller-passed snapshot -- same
   * "narrow the race window to the read-then-write gap immediately below" reasoning as
   * WhatsAppCancellationHandler.ensureLeadCancelled. Idempotent no-op if already at the target
   * lead status. */
  private async ensureLeadTransitioned(leadId: string, terminal: "COMPLETED" | "NO_SHOW"): Promise<void> {
    const target = LEAD_TARGET_FOR_TERMINAL[terminal];
    const lead = await this.leads.findById(leadId);
    if (!lead || lead.status === target) return;
    assertTransition(lead.status, target);
    await this.leads.update(lead.id, { status: target });
    await recordLeadStatusTransition(this.leadStatusHistory, this.logger, {
      leadId,
      fromStatus: lead.status,
      toStatus: target,
      eventType: terminal === "COMPLETED" ? "APPOINTMENT_MARKED_COMPLETED" : "APPOINTMENT_MARKED_NO_SHOW",
    });
  }

  /**
   * Idempotent via the same appointment_message_deliveries idempotency-key convention as
   * AppointmentReminderService -- a duplicate call to markNoShow for an appointment already
   * NO_SHOW (closeOut's own idempotent-retry branch above) never re-sends the nudge, because
   * tryCreate loses the race against the row this method already created on the first call.
   */
  private async sendNoShowNudge(appointment: Appointment): Promise<void> {
    const idempotencyKey = `NO_SHOW_NUDGE:${appointment.id}`;
    const delivery = await this.appointmentMessageDeliveries.tryCreate({
      appointmentId: appointment.id,
      leadId: appointment.leadId,
      deliveryType: "NO_SHOW_NUDGE",
      scheduledFor: new Date(),
      idempotencyKey,
    });
    if (!delivery) return; // already sent (or in flight) by an earlier call -- never a second nudge

    try {
      const lead = await this.leads.findById(appointment.leadId);
      const conversation = lead ? await this.conversations.findActiveByLeadId(lead.id) : null;
      if (!lead || !lead.whatsappUserId || !conversation) {
        throw new Error("LEAD_OR_CONVERSATION_UNAVAILABLE");
      }
      const { body, params } = buildNoShowNudgeMessage(conversationalFirstName(lead));
      const result = await this.messaging.sendTemplate(lead.whatsappUserId, this.noShowNudgeTemplateName, this.templateLanguageCode, params);
      await this.messages.create({
        conversationId: conversation.id,
        leadId: lead.id,
        direction: "OUTBOUND",
        channel: "WHATSAPP",
        body,
        providerMessageId: result.providerMessageId,
        aiGenerated: false,
        metadata: {},
      });
      await this.appointmentMessageDeliveries.update(delivery.id, {
        status: "COMPLETED",
        completedAt: new Date(),
        providerMessageId: result.providerMessageId,
        attemptCount: delivery.attemptCount + 1,
        lastAttemptAt: new Date(),
      });
    } catch (err) {
      this.logger.warn(
        { appointmentId: appointment.id, leadId: appointment.leadId, errorName: err instanceof Error ? err.name : "unknown" },
        "Fase 7A: no-show nudge send failed; the NO_SHOW transition itself already succeeded and is unaffected.",
      );
      await this.appointmentMessageDeliveries.update(delivery.id, {
        status: "FAILED",
        attemptCount: delivery.attemptCount + 1,
        lastAttemptAt: new Date(),
        errorCode: err instanceof MessagingProviderError ? "MESSAGING_PROVIDER_ERROR" : "UNKNOWN",
      });
    }
  }
}
