import type { LeadRepository, ConversationRepository, MessageRepository, MessagingProvider, Logger } from "./ports.js";
import type { LeadService } from "./services.js";
import type { Lead } from "../domain/lead.js";
import { persistInboundMessage } from "./message-ingestion.js";
import { runProcessingBoundary } from "./processing-boundary.js";
import { normalizePhoneToE164 } from "../domain/phone.js";
import { isOptOutMessage } from "../domain/opt-out-detection.js";
import { isRescheduleRequest } from "../domain/reschedule-intent-detection.js";
import { isCancellationRequest } from "../domain/cancellation-intent-detection.js";
import { buildWelcomeMessage, HEALTH_HANDOFF_MESSAGE, OPT_OUT_CONFIRMATION_MESSAGE, BOOKED_GENERIC_INBOUND_MESSAGE } from "../domain/message-templates.js";
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

/**
 * Phase 3C booking orchestrator, injected only when config.WHATSAPP_BOOKING_ENABLED is true (see
 * app.ts). Kept as a narrow interface here (not an import of the concrete class) for the same
 * decoupling reason as QualificationTurnHandler above -- WhatsAppBookingHandler implements this.
 */
export interface BookingTurnHandler {
  handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date }): Promise<void>;
}

/**
 * Phase 4B cancellation orchestrator, injected only when config.WHATSAPP_CANCELLATION_ENABLED is
 * true (see app.ts). Same decoupling reason as BookingTurnHandler above --
 * WhatsAppCancellationHandler implements this.
 */
export interface CancellationTurnHandler {
  handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date }): Promise<void>;
}

/**
 * Phase 4C reschedule orchestrator, injected only when config.WHATSAPP_RESCHEDULE_ENABLED is
 * true (see app.ts). Same decoupling reason as CancellationTurnHandler above --
 * WhatsAppRescheduleHandler implements this.
 */
export interface RescheduleTurnHandler {
  handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date }): Promise<void>;
}

/**
 * Pre-launch hardening: reactivates a CANCELLED lead into a brand-new booking. Injected only when
 * config.WHATSAPP_BOOKING_ENABLED is true (see app.ts) -- the reactivation flow is fundamentally
 * dependent on the booking flow being fully operational, so it reuses that flag rather than
 * inventing a new one. WhatsAppReactivationHandler implements this.
 */
export interface ReactivationTurnHandler {
  handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date }): Promise<void>;
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
  /** Present only when the Phase 3C feature flag (WHATSAPP_BOOKING_ENABLED) is on. Absent (the
   * default), the BOOKING_PENDING routing branch below is never taken -- behavior is unchanged
   * from Phase 3B. */
  bookingHandler?: BookingTurnHandler;
  /** Present only when the Phase 4B feature flag (WHATSAPP_CANCELLATION_ENABLED) is on. Absent
   * (the default), the BOOKED/CANCEL_PENDING routing branch below is never taken -- a BOOKED lead
   * falls through to the same "no automated reply" fallback as Phase 3C, unchanged. */
  cancellationHandler?: CancellationTurnHandler;
  /** Present only when the Phase 4C feature flag (WHATSAPP_RESCHEDULE_ENABLED) is on. Absent (the
   * default), the reschedule-intent check and the RESCHEDULE_REQUESTED routing branch below are
   * never taken -- a BOOKED lead's free text is checked only against isCancellationRequest, and a
   * RESCHEDULE_REQUESTED lead can only be reached via that flag anyway, exactly Phase 4B behavior,
   * unchanged. */
  rescheduleHandler?: RescheduleTurnHandler;
  /** Present only when the pre-launch reactivation feature is on (reuses WHATSAPP_BOOKING_ENABLED
   * -- see app.ts). Absent (the default), the CANCELLED routing branch below is never taken and a
   * CANCELLED lead falls through to the same "no automated reply" fallback as before, unchanged. */
  reactivationHandler?: ReactivationTurnHandler;
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
      // Phase 3C: a lead in BOOKING_PENDING is picking a slot, declining, or otherwise replying
      // to the booking flow -- routed here, after every earlier guard (opt-out, medical-sensitive
      // handoff, welcome/new-lead, QUALIFYING, CONTACTED recovery) has already had first chance
      // to claim this inbound; none of those conditions can ever be true for a BOOKING_PENDING
      // lead anyway, so this ordering is not load-bearing for correctness, only for readability.
      // bookingHandler is present only when WHATSAPP_BOOKING_ENABLED is true (see app.ts) --
      // absent, this branch is never taken and behavior is unchanged from Phase 3B. A lead
      // already BOOKED never matches this condition, so it falls through to the no-reply
      // fallback below, same as today -- no rebooking, no re-offering.
      if (deps.bookingHandler && lead.status === "BOOKING_PENDING") {
        await deps.bookingHandler.handleTurn({ lead, conversationId, whatsappUserId: input.whatsappUserId, inboundText: input.text, now: new Date() });
        return;
      }
      // Phase 4C: a RESCHEDULE_REQUESTED lead is picking a new slot (or asking to cancel instead
      // -- see WhatsAppRescheduleHandler, item 13). Only ever reachable via the BOOKED-turn branch
      // just below, so rescheduleHandler being present here is a precondition, not a coincidence.
      if (deps.rescheduleHandler && lead.status === "RESCHEDULE_REQUESTED") {
        await deps.rescheduleHandler.handleTurn({ lead, conversationId, whatsappUserId: input.whatsappUserId, inboundText: input.text, now: new Date() });
        return;
      }
      // Phase 4C: a BOOKED lead's free text is checked for reschedule-intent BEFORE
      // cancellation-intent -- one explicit, deterministic precedence decision here (mirroring
      // how isOptOutMessage/sensitiveDetected are already decided directly in this file, not
      // inside a handler), rather than leaving two independent keyword detectors free to race
      // undefined on the same turn. rescheduleHandler is present only when
      // WHATSAPP_RESCHEDULE_ENABLED is true (see app.ts) -- absent, isRescheduleRequest is never
      // even evaluated and a BOOKED lead's text is checked only against isCancellationRequest
      // below, byte-for-byte Phase 4B behavior.
      if (deps.rescheduleHandler && lead.status === "BOOKED" && isRescheduleRequest(input.text)) {
        await deps.rescheduleHandler.handleTurn({ lead, conversationId, whatsappUserId: input.whatsappUserId, inboundText: input.text, now: new Date() });
        return;
      }
      // Pre-launch hardening: a BOOKED lead's free text that matched neither reschedule-intent
      // (checked above) nor cancellation-intent must still get a safe, deterministic reply --
      // never silence -- while NEVER changing status/score/meetingAt/appointment, never calling
      // Calendar, never creating offered_slots, never recording a qualification answer (this
      // branch does exactly one thing: send a message). This is the sole owner of "BOOKED +
      // generic inbound" -- previously a genuine gap: WhatsAppCancellationHandler only ever acts
      // on an explicit cancellation-intent match and silently no-ops otherwise (by design, for
      // ITS OWN concern), and nothing downstream ever got a chance to reply once its routing
      // condition matched and unconditionally returned. Gated on BOTH rescheduleHandler AND
      // cancellationHandler being present -- the copy references both actions ("reagendar" /
      // "cancelar"), so it is only ever sent when both are genuinely available; with either (or
      // both) flags off, this branch is never taken and behavior is byte-for-byte the prior
      // silent fallback, unchanged -- same "flag off -> unchanged behavior" guarantee as every
      // other flag in this project. Placed BEFORE the cancellationHandler dispatch below so
      // genuinely non-actionable text never even reaches that handler's internal no-op.
      if (deps.rescheduleHandler && deps.cancellationHandler && lead.status === "BOOKED" && !isCancellationRequest(input.text)) {
        await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, BOOKED_GENERIC_INBOUND_MESSAGE);
        return;
      }
      // Phase 4B: a lead in BOOKED (interpreting a cancellation-intent message -- generic text
      // never reaches here anymore, see the fallback immediately above) or CANCEL_PENDING
      // (interpreting a confirm/decline/ambiguous reply). cancellationHandler is present only
      // when WHATSAPP_CANCELLATION_ENABLED is true (see app.ts) -- absent, this branch is never
      // taken and a BOOKED lead falls through to the same "no automated reply" fallback Phase 3C
      // already has today, unchanged.
      if (deps.cancellationHandler && (lead.status === "BOOKED" || lead.status === "CANCEL_PENDING")) {
        await deps.cancellationHandler.handleTurn({ lead, conversationId, whatsappUserId: input.whatsappUserId, inboundText: input.text, now: new Date() });
        return;
      }
      // Pre-launch hardening: a CANCELLED lead's free text -- classified internally by
      // WhatsAppReactivationHandler into cancellation-intent (safe no-op reply), reschedule-intent
      // (reframed as a new booking, since there's no active appointment to move), explicit
      // new-booking intent (starts a fresh booking round), or generic (reactivation fallback
      // only). reactivationHandler is present only when WHATSAPP_BOOKING_ENABLED is true (see
      // app.ts) -- absent, this branch is never taken and a CANCELLED lead falls through to the
      // same "no automated reply" fallback as before, unchanged.
      if (deps.reactivationHandler && lead.status === "CANCELLED") {
        await deps.reactivationHandler.handleTurn({ lead, conversationId, whatsappUserId: input.whatsappUserId, inboundText: input.text, now: new Date() });
        return;
      }
      // No qualifier/booking/cancellation/reschedule/reactivation handler configured (flags off),
      // or an existing lead outside an active round (e.g. already QUALIFIED_A/B/NURTURE_C, or a
      // CONTACTED lead that still carries a product from a prior round): no automated reply, same
      // as Phase 2.
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
