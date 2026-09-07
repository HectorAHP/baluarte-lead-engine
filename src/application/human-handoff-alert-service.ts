import type { LeadRepository, MessagingProvider, ProcessedEventRepository, Logger } from "./ports.js";
import type { HandoffAlertTurnService } from "./whatsapp-inbound-service.js";
import { conversationalFirstName } from "../domain/conversation-name.js";
import { zonedTimeParts } from "../domain/timezone.js";
import { buildHumanHandoffAlertMessage, HUMAN_HANDOFF_ALERT_REASON_UNKNOWN_INTENT } from "../domain/message-templates.js";

export interface HumanHandoffAlertDeps {
  messaging: MessagingProvider;
  /** Fase 7J.2's idempotency gate -- reused verbatim from Fase 6A's web-lead-capture dedup, NOT a
   * new table/migration. `tryCreate({provider:"human_handoff_alert", eventId: leadId})` wins
   * outright (INSERT succeeds) or returns null on the `(provider, event_id)` unique-constraint
   * conflict -- same "insert-as-lock" convention as SlotOfferClaimRepository.tryCreate. This is
   * what closes the one residual gap the existing message-id dedup and terminal-HUMAN_HANDOFF
   * suppression don't cover on their own: two genuinely DIFFERENT inbound messages for the same
   * lead, arriving close enough together that both read the lead's pre-handoff status before
   * either write commits. See this class's own doc comment for the scoping trade-off this key
   * accepts. */
  processedEvents: ProcessedEventRepository;
  /** Read-only -- used ONLY to look up the lead's first name for the alert's "Nombre" variable.
   * Never written to from here. */
  leads: LeadRepository;
  logger: Logger;
}

export interface HumanHandoffAlertConfig {
  /** Already normalized E.164 -- see config.ts's humanHandoffAdvisorPhoneE164 and app.ts's own
   * re-validation before ever constructing this class. Never taken from any inbound message. */
  advisorPhoneE164: string;
  templateName: string;
  languageCode: string;
  timezone: string;
}

const PROCESSED_EVENT_PROVIDER = "human_handoff_alert";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "DD/MM/YYYY HH:mm" in `timezone` -- 24h, includes the date (this is an internal operational
 * alert to Héctor, not a lead-facing appointment slot, so formatSlotForDisplay's weekday-only
 * convention doesn't apply here). */
function formatAlertTimestamp(date: Date, timezone: string): string {
  const p = zonedTimeParts(date, timezone);
  return `${pad2(p.day)}/${pad2(p.month)}/${p.year} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * Fase 7J.2 -- sends a WhatsApp template message to Héctor's own number
 * (HUMAN_HANDOFF_ADVISOR_PHONE) when a conversation is escalated to HUMAN_HANDOFF. Constructed in
 * app.ts ONLY when config.HUMAN_HANDOFF_ALERTS_ENABLED is true AND a valid advisor phone is
 * configured -- absent otherwise, so every call site (whatsapp-inbound-service.ts's
 * escalateUnknownIntent, booking-outcome-dispatch.ts's escalateToHuman) degrades to a no-op via
 * optional chaining. Never sends to any number other than the one fixed, admin-configured
 * advisorPhoneE164 -- never the lead's own number, never anything derived from the inbound
 * message (spec item 12).
 *
 * Idempotency (spec item 6): `processedEvents.tryCreate` is keyed on `leadId` ALONE, under the
 * "human_handoff_alert" provider namespace, checked BEFORE any lookup/send is attempted -- this
 * closes the one real residual gap in the surrounding dedup (see HumanHandoffAlertDeps' own doc
 * comment on `processedEvents`). Known, deliberate scoping trade-off: the key is permanent per
 * lead, not per escalation episode, so if a lead is later recovered via
 * HumanHandoffRecoveryService.recover() and STILL LATER escalates again via
 * UNKNOWN_INTENT_HANDOFF, no second alert is sent (the key from the first episode is still
 * claimed). Accepted for this phase per the spec's own "no complex queueing/dedup system this
 * phase, document the limitation" instruction -- see
 * docs/security/FASE7J2-HUMAN-HANDOFF-ALERT.md Sec 6 for the exact trade-off and how a future
 * phase could scope this per-episode instead (e.g. HumanHandoffRecoveryService deleting this
 * marker on recovery).
 *
 * Failure handling (spec item 7): NEVER throws. A failure anywhere in this method (the claim
 * itself, the lead lookup, or the actual send) is caught, logged as human_handoff_alert_failed,
 * and swallowed -- the HUMAN_HANDOFF transition this is called AFTER (see both call sites) has
 * already committed by the time this runs, and nothing in here can or should roll it back. No
 * automatic retry exists this phase (MetaWhatsAppProvider itself has none to reuse -- audited, see
 * the Fase 7J.2 report) -- a failed send is observable only via the log line above.
 */
export class HumanHandoffAlertService implements HandoffAlertTurnService {
  constructor(
    private readonly deps: HumanHandoffAlertDeps,
    private readonly cfg: HumanHandoffAlertConfig,
  ) {}

  async alertAdvisorOfHandoff(params: { leadId: string; conversationId: string; whatsappUserId: string; handoffReason: string; now: Date }): Promise<void> {
    const { leadId, conversationId, whatsappUserId, handoffReason, now } = params;
    const logCtx = { leadIdLast8: leadId.slice(-8), conversationIdLast8: conversationId.slice(-8), handoffReason };
    try {
      const claim = await this.deps.processedEvents.tryCreate({ provider: PROCESSED_EVENT_PROVIDER, eventId: leadId });
      if (!claim) {
        this.deps.logger.warn({ ...logCtx, providerOutcome: "SKIPPED_DUPLICATE" }, "human_handoff_alert_skipped");
        return;
      }

      let leadName = "Lead sin nombre";
      try {
        const lead = await this.deps.leads.findById(leadId);
        const name = lead ? conversationalFirstName(lead) : undefined;
        if (name) leadName = name;
      } catch {
        // Best-effort only -- a name-lookup failure must never block the alert itself, and never
        // includes any inbound text either way.
      }

      const { params: templateParams } = buildHumanHandoffAlertMessage(
        leadName,
        whatsappUserId,
        HUMAN_HANDOFF_ALERT_REASON_UNKNOWN_INTENT,
        formatAlertTimestamp(now, this.cfg.timezone),
      );
      await this.deps.messaging.sendTemplate(this.cfg.advisorPhoneE164, this.cfg.templateName, this.cfg.languageCode, templateParams);
      this.deps.logger.warn({ ...logCtx, providerOutcome: "SENT" }, "human_handoff_alert_sent");
    } catch (err) {
      // Never advisor phone (full), never prospect phone (full), never inbound text -- see this
      // file's own class doc comment and the Fase 7J.2 report's PII section.
      this.deps.logger.warn({ ...logCtx, providerOutcome: "FAILED", errorName: err instanceof Error ? err.name : "Unknown" }, "human_handoff_alert_failed");
    }
  }
}
