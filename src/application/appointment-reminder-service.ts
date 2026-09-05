import type {
  AppointmentRepository, LeadRepository, ConversationRepository, MessageRepository,
  MessagingProvider, AppointmentMessageDeliveryRepository, Logger,
} from "./ports.js";
import type { Appointment } from "../domain/appointment.js";
import type { Lead } from "../domain/lead.js";
import type { AppointmentMessageDelivery, DeliveryType } from "../domain/appointment-message-delivery.js";
import { conversationalFirstName } from "../domain/conversation-name.js";
import {
  formatSlotForDisplay, buildAppointmentReminder24hMessage, buildAppointmentReminder2hMessage,
  buildPostMeetingFollowupMessage, type AppointmentTemplatePayload,
} from "../domain/message-templates.js";
import { appointmentConfirmationMetadata } from "../domain/appointment-confirmation-state.js";
import { MessagingProviderError } from "../domain/errors.js";

/**
 * Fase 7A -- a FAILED delivery is retried by a later sweep tick (never left permanently stuck),
 * but only up to this many attempts, so a durably-broken template name / revoked WhatsApp token
 * can never turn into an unbounded retry storm across every future 15-minute tick. Deliberately
 * its own constant, not shared with any other *_STALE_THRESHOLD_MS/max-attempts constant in this
 * codebase -- same "never share a threshold across unrelated concerns" principle already applied
 * to OFFER_CLAIM_STALE_THRESHOLD_MS/REMINDER_PENDING_STALE_THRESHOLD_MS in docs/PHASE4-DESIGN.md.
 */
const MAX_DELIVERY_ATTEMPTS = 5;

export interface AppointmentReminderServiceDeps {
  appointments: AppointmentRepository;
  leads: LeadRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  messaging: MessagingProvider;
  appointmentMessageDeliveries: AppointmentMessageDeliveryRepository;
  logger: Logger;
}

/** Configurable Meta template names (Fase 7A spec item 3: "usar nombres configurables por env, no
 * hardcodear necesariamente nombres de producción") -- see config.ts's WHATSAPP_TEMPLATE_* vars. */
export interface AppointmentReminderTemplateNames {
  reminder24h: string;
  reminder2h: string;
  postMeeting: string;
  languageCode: string;
}

export interface ReminderSweepSummary {
  candidates: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface AppointmentReminderRunSummary {
  reminder24h: ReminderSweepSummary;
  reminder2h: ReminderSweepSummary;
  postMeetingFollowup: ReminderSweepSummary;
}

const EMPTY_SUMMARY: ReminderSweepSummary = { candidates: 0, sent: 0, failed: 0, skipped: 0 };

/**
 * Fase 7A -- stateless, idempotent periodic sweep. Every call to run() is a fresh scan of the DB
 * (Appointment/Lead/AppointmentMessageDelivery) -- never depends on the process having been alive
 * since a previous tick, so a redeploy/restart between two scheduler calls is invisible to
 * correctness (see docs/PHASE4-DESIGN.md §8). Intentionally reuses the SAME wide-window +
 * idempotency-table pattern the original design specified: `listActiveStartingBetween(now, now +
 * windowMs)` returns every appointment starting anywhere in that window, re-scanned on every tick
 * regardless of when the LAST tick ran -- de-duplication is entirely
 * appointment_message_deliveries' job (its idempotency_key UNIQUE constraint), never the window
 * boundaries'. This is deliberately more robust than a narrow "exactly due right now" window,
 * which could skip a row entirely if a single scheduler tick is ever missed or delayed.
 *
 * Both REMINDER_24H and REMINDER_2H select on `listActiveStartingBetween`, which includes
 * CONFIRMED appointments as well as BOOKED (Fase 7A spec item 7: a lead who already confirmed via
 * the 24h reminder must still receive the 2h one). NO_SHOW_NUDGE is deliberately NOT swept here --
 * see AppointmentCompletionService, which sends it synchronously the moment Héctor marks an
 * appointment NO_SHOW (Fase 7A spec item 9: no automatic no-show detection exists, so there is
 * nothing for a periodic sweep to find).
 */
export class AppointmentReminderService {
  constructor(
    private readonly deps: AppointmentReminderServiceDeps,
    private readonly templates: AppointmentReminderTemplateNames,
    private readonly advisorTimezone: string,
  ) {}

  /**
   * `enableReminders` gates BOTH the 24h and 2h sweeps together (APPOINTMENT_REMINDERS_ENABLED --
   * see config.ts); `enablePostMeetingFollowup` gates the post-meeting sweep independently
   * (POST_MEETING_FOLLOWUP_ENABLED). Either flag false returns that sweep's EMPTY_SUMMARY without
   * ever querying the DB for it -- same "flag off means byte-for-byte no behavior" guarantee as
   * every other flag in this project.
   */
  async run(now: Date, options: { enableReminders: boolean; enablePostMeetingFollowup: boolean }): Promise<AppointmentReminderRunSummary> {
    const reminder24h = options.enableReminders
      ? await this.sweepReminder(now, "REMINDER_24H", 24 * 60 * 60 * 1000, this.templates.reminder24h, buildAppointmentReminder24hMessage, true)
      : EMPTY_SUMMARY;
    const reminder2h = options.enableReminders
      ? await this.sweepReminder(now, "REMINDER_2H", 2 * 60 * 60 * 1000, this.templates.reminder2h, buildAppointmentReminder2hMessage, false)
      : EMPTY_SUMMARY;
    const postMeetingFollowup = options.enablePostMeetingFollowup
      ? await this.sweepPostMeetingFollowup(now)
      : EMPTY_SUMMARY;
    return { reminder24h, reminder2h, postMeetingFollowup };
  }

  private async sweepReminder(
    now: Date,
    deliveryType: DeliveryType,
    windowMs: number,
    templateName: string,
    buildMessage: (firstName: string | undefined, when: string) => AppointmentTemplatePayload,
    attachConfirmationMarker: boolean,
  ): Promise<ReminderSweepSummary> {
    const candidates = await this.deps.appointments.listActiveStartingBetween(now, new Date(now.getTime() + windowMs));
    let sent = 0, failed = 0, skipped = 0;
    for (const appointment of candidates) {
      const outcome = await this.attempt(appointment, deliveryType, now, templateName, (firstName) =>
        buildMessage(firstName, formatSlotForDisplay(appointment.startsAt, this.advisorTimezone)),
        attachConfirmationMarker,
      );
      if (outcome === "SENT") sent++; else if (outcome === "FAILED") failed++; else skipped++;
    }
    return { candidates: candidates.length, sent, failed, skipped };
  }

  private async sweepPostMeetingFollowup(now: Date): Promise<ReminderSweepSummary> {
    // Fase 7A spec item 8: "ventana sugerida 30-120 minutos después del fin estimado" -- endsAt in
    // [now - 120min, now - 30min).
    const to = new Date(now.getTime() - 30 * 60 * 1000);
    const from = new Date(now.getTime() - 120 * 60 * 1000);
    const candidates = await this.deps.appointments.listCompletedEndingBetween(from, to);
    let sent = 0, failed = 0, skipped = 0;
    for (const appointment of candidates) {
      const outcome = await this.attempt(appointment, "POST_MEETING_FOLLOWUP", now, this.templates.postMeeting, buildPostMeetingFollowupMessage, false);
      if (outcome === "SENT") sent++; else if (outcome === "FAILED") failed++; else skipped++;
    }
    return { candidates: candidates.length, sent, failed, skipped };
  }

  /**
   * Owns the idempotency-table dance for exactly one (appointment, deliveryType) pair: win the
   * INSERT outright (brand-new), or find the existing row and decide whether it's worth retrying
   * (FAILED, under the attempt cap) or must be left alone (COMPLETED, PROCESSING, or FAILED but
   * exhausted). Returns "SKIPPED" for every case that never attempts a send at all -- distinct
   * from "FAILED", which means a send WAS attempted this tick and failed.
   */
  private async attempt(
    appointment: Appointment,
    deliveryType: DeliveryType,
    now: Date,
    templateName: string,
    buildMessage: (firstName: string | undefined) => AppointmentTemplatePayload,
    attachConfirmationMarker: boolean,
  ): Promise<"SENT" | "FAILED" | "SKIPPED"> {
    const idempotencyKey = `${deliveryType}:${appointment.id}`;
    const delivery =
      (await this.deps.appointmentMessageDeliveries.tryCreate({
        appointmentId: appointment.id,
        leadId: appointment.leadId,
        deliveryType,
        scheduledFor: now,
        idempotencyKey,
      })) ?? (await this.deps.appointmentMessageDeliveries.findByIdempotencyKey(idempotencyKey));

    if (!delivery) return "SKIPPED"; // should never happen (tryCreate/findByIdempotencyKey race), never crash the sweep over it
    if (delivery.status === "COMPLETED" || delivery.status === "PROCESSING") return "SKIPPED";
    if (delivery.status === "FAILED" && delivery.attemptCount >= MAX_DELIVERY_ATTEMPTS) return "SKIPPED";

    const lead = await this.deps.leads.findById(appointment.leadId);
    if (!lead || !lead.whatsappUserId) {
      await this.markFailed(delivery, "LEAD_OR_WHATSAPP_ID_MISSING");
      return "FAILED";
    }
    // Fase 7A / docs/PHASE4-DESIGN.md §8.1: a lead mid-escalation or opted out never gets an
    // automated proactive message, even though their appointment is still technically BOOKED.
    // Deliberately leaves `delivery` untouched (still PENDING, no attempt consumed) rather than
    // marking it FAILED -- HUMAN_HANDOFF in particular can resolve within minutes (see
    // state-machine.ts), and this status is re-checked fresh on every tick within the same
    // window, so there's no reason to spend one of MAX_DELIVERY_ATTEMPTS on a condition that has
    // nothing to do with the messaging provider or the delivery itself.
    if (lead.status === "DO_NOT_CONTACT" || lead.status === "HUMAN_HANDOFF") {
      return "SKIPPED";
    }

    const conversation = await this.deps.conversations.findActiveByLeadId(lead.id);
    if (!conversation) {
      await this.markFailed(delivery, "NO_ACTIVE_CONVERSATION");
      return "FAILED";
    }

    return this.sendAndTrack(delivery, lead, conversation.id, templateName, buildMessage, attachConfirmationMarker);
  }

  private async sendAndTrack(
    delivery: AppointmentMessageDelivery,
    lead: Lead,
    conversationId: string,
    templateName: string,
    buildMessage: (firstName: string | undefined) => AppointmentTemplatePayload,
    attachConfirmationMarker: boolean,
  ): Promise<"SENT" | "FAILED"> {
    const { body, params } = buildMessage(conversationalFirstName(lead));
    try {
      const result = await this.deps.messaging.sendTemplate(lead.whatsappUserId!, templateName, this.templates.languageCode, params);
      await this.deps.messages.create({
        conversationId,
        leadId: lead.id,
        direction: "OUTBOUND",
        channel: "WHATSAPP",
        body,
        providerMessageId: result.providerMessageId,
        aiGenerated: false,
        metadata: attachConfirmationMarker ? appointmentConfirmationMetadata() : {},
      });
      await this.deps.appointmentMessageDeliveries.update(delivery.id, {
        status: "COMPLETED",
        completedAt: new Date(),
        providerMessageId: result.providerMessageId,
        attemptCount: delivery.attemptCount + 1,
        lastAttemptAt: new Date(),
      });
      return "SENT";
    } catch (err) {
      this.deps.logger.warn(
        {
          appointmentId: delivery.appointmentId,
          leadId: lead.id,
          deliveryType: delivery.deliveryType,
          errorName: err instanceof Error ? err.name : "unknown",
        },
        "Fase 7A: proactive appointment message send failed; delivery left FAILED for a later sweep retry.",
      );
      await this.markFailed(delivery, err instanceof MessagingProviderError ? "MESSAGING_PROVIDER_ERROR" : "UNKNOWN");
      return "FAILED";
    }
  }

  private async markFailed(delivery: AppointmentMessageDelivery, errorCode: string): Promise<void> {
    await this.deps.appointmentMessageDeliveries.update(delivery.id, {
      status: "FAILED",
      attemptCount: delivery.attemptCount + 1,
      lastAttemptAt: new Date(),
      errorCode,
    });
  }
}
