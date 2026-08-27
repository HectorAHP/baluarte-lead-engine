import type { LeadRepository, ConversationRepository, MessageRepository, MessagingProvider, Logger } from "./ports.js";
import type { LeadService } from "./services.js";
import type { Lead } from "../domain/lead.js";
import { persistInboundMessage } from "./message-ingestion.js";
import { runProcessingBoundary } from "./processing-boundary.js";
import { normalizePhoneToE164 } from "../domain/phone.js";
import { isOptOutMessage } from "../domain/opt-out-detection.js";
import { buildWelcomeMessage, HEALTH_HANDOFF_MESSAGE, OPT_OUT_CONFIRMATION_MESSAGE } from "../domain/message-templates.js";
import { MessagingProviderError } from "../domain/errors.js";

/**
 * Phase 3B qualifier orchestrator, injected only when config.QUALIFICATION_ENGINE_ENABLED is
 * true (see app.ts). Kept as a narrow interface here (not an import of the concrete class) so
 * this transport/orchestration file stays decoupled from qualification business logic --
 * WhatsAppQualificationHandler implements this.
 */
export interface QualificationTurnHandler {
  beginQualification(leadId: string): Promise<void>;
  handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string }): Promise<void>;
}

export interface InboundWhatsAppText {
  whatsappUserId: string;
  phoneRaw: string;
  displayName?: string;
  providerMessageId: string;
  text: string;
}

export interface WhatsAppInboundDeps {
  leads: LeadRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  leadService: LeadService;
  messaging: MessagingProvider;
  logger: Logger;
  /** Present only when the Phase 3B feature flag is on. Absent (the default), behavior here is
   * byte-for-byte identical to Phase 2 -- welcome message only, no qualification routing. */
  qualificationHandler?: QualificationTurnHandler;
}

export type WhatsAppInboundOutcome = "DUPLICATE" | "PROCESSED";

export interface WhatsAppInboundResult {
  outcome: WhatsAppInboundOutcome;
  leadId?: string;
  conversationId?: string;
}

/**
 * The full transport+persistence pipeline for one inbound WhatsApp text message (Phase 2 --
 * no conversational qualifier yet). Ingestion (dedup, lead/conversation resolution, message
 * persistence) always completes before this returns. The reply-decision-and-send step runs
 * through runProcessingBoundary, so a send failure there is logged but never surfaces as an
 * error from this function -- the webhook handler can always acknowledge Meta once this
 * resolves, regardless of whether the automated reply actually went out.
 */
export async function handleInboundWhatsAppText(
  deps: WhatsAppInboundDeps,
  input: InboundWhatsAppText,
): Promise<WhatsAppInboundResult> {
  const existingMessage = await deps.messages.findByProviderMessageId("WHATSAPP", input.providerMessageId);
  if (existingMessage) {
    return { outcome: "DUPLICATE", leadId: existingMessage.leadId, conversationId: existingMessage.conversationId };
  }

  const phoneE164 = normalizePhoneToE164(input.phoneRaw) ?? undefined;
  let lead = await deps.leads.findByDedupKey({ whatsappUserId: input.whatsappUserId, phoneE164 });
  if (!lead) {
    lead = await deps.leadService.createLead({
      firstName: input.displayName,
      phone: input.phoneRaw,
      source: "WHATSAPP",
      whatsappUserId: input.whatsappUserId,
    });
  }

  // Captured before recordInboundContact mutates status/timestamps, since the decision logic
  // below needs to know what was true *before* this message.
  const wasAlreadySuppressed = lead.status === "DO_NOT_CONTACT" || lead.status === "HUMAN_HANDOFF";
  const wasNew = lead.status === "NEW";

  lead = await deps.leadService.recordInboundContact(lead.id);

  let conversation = await deps.conversations.findActiveByLeadId(lead.id);
  if (!conversation) {
    conversation = await deps.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  }

  const { sensitiveDetected } = await persistInboundMessage(
    { messages: deps.messages },
    {
      conversationId: conversation.id,
      leadId: lead.id,
      body: input.text,
      providerMessageId: input.providerMessageId,
      sender: input.whatsappUserId,
    },
  );

  const leadId = lead.id;
  const conversationId = conversation.id;

  if (wasAlreadySuppressed) {
    // Lead was already DO_NOT_CONTACT or HUMAN_HANDOFF before this message: ingest silently,
    // no automated reply of any kind (not even a repeated handoff/opt-out acknowledgment).
    return { outcome: "PROCESSED", leadId, conversationId };
  }

  await runProcessingBoundary(
    async () => {
      if (isOptOutMessage(input.text)) {
        await deps.leadService.requestDoNotContact(leadId);
        await deps.conversations.update(conversationId, { status: "CLOSED" });
        await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, OPT_OUT_CONFIRMATION_MESSAGE);
        return;
      }
      if (sensitiveDetected) {
        await deps.leadService.requestHumanHandoff(leadId);
        await deps.conversations.update(conversationId, { status: "HUMAN_HANDOFF" });
        await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, HEALTH_HANDOFF_MESSAGE);
        return;
      }
      if (wasNew) {
        await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, buildWelcomeMessage(input.displayName));
        if (deps.qualificationHandler) {
          await deps.qualificationHandler.beginQualification(leadId);
        }
        return;
      }
      if (deps.qualificationHandler && lead.status === "QUALIFYING") {
        await deps.qualificationHandler.handleTurn({ lead, conversationId, whatsappUserId: input.whatsappUserId, inboundText: input.text });
        return;
      }
      // Recovery path: a lead created (or last contacted) while the feature flag was off went
      // through the Phase 2 welcome and is stuck in CONTACTED forever, since beginQualification()
      // is otherwise only ever called from the wasNew branch above -- a one-time event that
      // already happened for this lead before the flag existed/was enabled. !lead.productInterest
      // guards against re-engaging a lead who still carries a product from a prior round (e.g.
      // manually moved HUMAN_HANDOFF -> CONTACTED): that lead keeps getting no automated reply,
      // same as today. This never re-sends the welcome and never reprocesses history -- it starts
      // qualification and feeds it this exact inbound message, the same way a normal AWAITING_INTENT
      // turn would be handled.
      if (deps.qualificationHandler && lead.status === "CONTACTED" && !lead.productInterest) {
        await deps.qualificationHandler.beginQualification(leadId);
        const recoveredLead: Lead = { ...lead, status: "QUALIFYING" };
        await deps.qualificationHandler.handleTurn({ lead: recoveredLead, conversationId, whatsappUserId: input.whatsappUserId, inboundText: input.text });
        return;
      }
      // No qualifier configured (flag off), or an existing lead outside an active
      // qualification round (e.g. already QUALIFIED_A/B/NURTURE_C, or a CONTACTED lead that
      // still carries a product from a prior round): no automated reply, same as Phase 2.
    },
    deps.logger,
    { leadId, conversationId },
  );

  return { outcome: "PROCESSED", leadId, conversationId };
}

/**
 * The single place that sends a WhatsApp reply and persists it as an OUTBOUND message, with
 * sanitized failure diagnostics. Exported so WhatsAppQualificationHandler (Phase 3B) reuses it
 * instead of re-implementing send+persist+diagnostics -- transport stays centralized here even
 * though the business logic deciding *what* to send now lives outside this file.
 */
export async function sendAndPersistReply(
  deps: Pick<WhatsAppInboundDeps, "messaging" | "messages" | "logger">,
  leadId: string,
  conversationId: string,
  to: string,
  body: string,
): Promise<void> {
  let providerMessageId: string | undefined;
  try {
    const result = await deps.messaging.sendText(to, body);
    providerMessageId = result.providerMessageId;
  } catch (err) {
    // Sanitized diagnostics only: never the raw error message (may echo Meta's error.message),
    // never the full recipient -- just enough shape to correlate a bad `to` format in prod logs.
    const recipientDiagnostics = {
      recipientLast4: to.length >= 4 ? to.slice(-4) : to,
      recipientLength: to.length,
      recipientHasPlus: to.includes("+"),
    };
    if (err instanceof MessagingProviderError) {
      deps.logger.warn(
        {
          leadId,
          conversationId,
          httpStatus: err.httpStatus,
          metaErrorCode: err.metaErrorCode,
          metaErrorType: err.metaErrorType,
          sanitizedDiagnosis: err.sanitizedDiagnosis,
          phoneNumberIdLast4: err.phoneNumberIdLast4,
          ...recipientDiagnostics,
        },
        "Failed to send WhatsApp reply; the inbound message that triggered it remains persisted.",
      );
    } else {
      deps.logger.warn(
        { leadId, conversationId, reason: "unknown", ...recipientDiagnostics },
        "Failed to send WhatsApp reply; the inbound message that triggered it remains persisted.",
      );
    }
    return;
  }
  await deps.messages.create({
    conversationId,
    leadId,
    direction: "OUTBOUND",
    channel: "WHATSAPP",
    body,
    providerMessageId,
    aiGenerated: false,
    metadata: {},
  });
}
