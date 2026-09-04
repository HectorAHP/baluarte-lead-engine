import type { LeadRepository, ConversationRepository, MessageRepository, MessagingProvider, Logger, AppointmentRepository, FiscalLeadScoreRepository } from "./ports.js";
import type { LeadService } from "./services.js";
import type { Lead } from "../domain/lead.js";
import { persistInboundMessage } from "./message-ingestion.js";
import { runProcessingBoundary } from "./processing-boundary.js";
import { normalizePhoneToE164 } from "../domain/phone.js";
import { isOptOutMessage } from "../domain/opt-out-detection.js";
import { isRescheduleRequest } from "../domain/reschedule-intent-detection.js";
import { isCancellationRequest } from "../domain/cancellation-intent-detection.js";
import { isUpcomingBooked } from "../domain/appointment-timing.js";
import { looksLikeFiscalCalculatorOrigin } from "../domain/fiscal-calculator-origin-detection.js";
import { isFirstWhatsAppInboundForConversation } from "../domain/whatsapp-first-inbound.js";
import { detectQualifiedLeadIntent } from "../domain/qualified-lead-intent-detection.js";
import { resolvePendingQualifiedMenu, qualifiedMainMenuMetadata, qualifiedOptionsMenuMetadata } from "../domain/qualified-lead-menu-state.js";
import { fiscalWelcomeMenuMetadata, resolvePendingFiscalWelcomeMenu, detectFiscalWelcomeDigit } from "../domain/fiscal-welcome-menu-state.js";
import { topicFollowupMetadata } from "../domain/qualified-lead-topic-followup.js";
import { conversationalFirstName } from "../domain/conversation-name.js";
import {
  buildWelcomeMessage, buildFiscalContextWelcomeMessage, HEALTH_HANDOFF_MESSAGE, OPT_OUT_CONFIRMATION_MESSAGE,
  BOOKED_GENERIC_INBOUND_MESSAGE, QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE, buildQualifiedLeadAskQuestionMessage,
  buildQualifiedLeadTopicAnswer, buildQualifiedLeadOptionsMessage, QUALIFIED_LEAD_BOOKING_FALLBACK_MESSAGE,
  QUALIFIED_LEAD_IDENTITY_ANSWER_MESSAGE, FISCAL_WELCOME_OTHER_TOPIC_MESSAGE,
} from "../domain/message-templates.js";
import { MessagingProviderError } from "../domain/errors.js";
import { getFiscalLeadContextForLead, type FiscalLeadContext } from "./fiscal-lead-context.js";

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
 * Returns whether the handler actually acted on (and replied to) the turn -- see
 * WhatsAppBookingHandler.handleTurn's doc comment; used by the QUALIFIED_A/QUALIFIED_B/NURTURE_C
 * routing branch below to know whether it still owes the lead a reply of its own.
 */
export interface BookingTurnHandler {
  handleTurn(params: {
    lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date;
    /**
     * Fase 6D -- set by the QUALIFIED_A/B/NURTURE_C routing branch below when the qualified-lead
     * conversation router (detectQualifiedLeadIntent, Fase 6C) has ALREADY determined this turn
     * means BOOKING -- via the menu's option "3" digit, or wording its own broader keyword list
     * recognizes. WhatsAppBookingHandler's own isNewBookingRequest check is narrower (specific
     * phrases like "quiero agendar una cita" only -- it has no visibility into the menu-digit
     * context, which is exclusively this router's concern), so without this override a bare "3"
     * would never reach the real booking flow even with WHATSAPP_BOOKING_ENABLED=true. Never set
     * for a BOOKING_PENDING turn (that branch is unconditional already, unaffected by this).
     */
    bookingIntentOverride?: boolean;
  }): Promise<boolean>;
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

/**
 * Pre-launch hardening: recovers a BOOKED lead whose appointment is stale/past (status still
 * BOOKED, but endsAt already elapsed -- see isUpcomingBooked). Injected only when
 * config.WHATSAPP_BOOKING_ENABLED is true (see app.ts), same reasoning as ReactivationTurnHandler
 * above. WhatsAppPastBookedRecoveryHandler implements this.
 */
export interface PastBookedRecoveryTurnHandler {
  handleTurn(params: {
    lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string; now: Date;
    /** Fase 6E.2: mirrors `!!fiscalContext` for this turn -- see
     * WhatsAppPastBookedRecoveryHandler's doc comment. Optional for backward compatibility. */
    hasFiscalContext?: boolean;
  }): Promise<void>;
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
  /** Present only when the pre-launch past-booked-recovery feature is on (reuses
   * WHATSAPP_BOOKING_ENABLED -- see app.ts). Absent (the default), the "is this lead's appointment
   * actually upcoming" check below is skipped entirely (no extra read), and a BOOKED lead's text
   * is routed exactly as it was before this hardening pass -- byte-for-byte unchanged, including
   * for a stale/past appointment. */
  pastBookedRecoveryHandler?: PastBookedRecoveryTurnHandler;
  /** Present only alongside pastBookedRecoveryHandler -- used ONLY to read the lead's current
   * appointment for the isUpcomingBooked check above, never written to from this file. */
  appointments?: AppointmentRepository;
  /**
   * Fase 6B -- fiscal calculator context bridge. Present in production (app.ts always
   * constructs and injects the same FiscalLeadScoreRepository the web capture flow uses --
   * FASE 6A). Absent (e.g. a test that doesn't need it), the fiscal-context lookup below is
   * skipped entirely and behavior is byte-for-byte unchanged -- same "optional dependency is the
   * de facto flag" convention as every other handler in this file. Read-only from here: never
   * used to write leads/lead_scores/fiscal_lead_scores.
   */
  fiscalLeadScores?: FiscalLeadScoreRepository;
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
  // Pre-launch production diagnostic (temporary, redacted -- see app.ts's webhook route for the
  // matching "whatsapp webhook received"/"parsed inbound message" logs at the transport layer).
  // deps.logger only exposes .warn (see the Logger port), so these use that level even though
  // they aren't warnings -- kept deliberately visible for this diagnostic pass rather than
  // silent, never the raw message body or full phone number.
  deps.logger.warn(
    { messageIdLast8: input.providerMessageId.slice(-8), fromLast4: input.whatsappUserId.slice(-4) },
    "whatsapp webhook: handleInboundWhatsAppText entered",
  );

  // Pre-launch production diagnostic (temporary, redacted): sequential checkpoints around every
  // await in this function, so a hang/slow-timeout/swallowed-error is pinpointable to the exact
  // operation instead of only "somewhere between entered and attempting-outbound". Every
  // "...checkpoint N: ..." pair brackets one real await; durationMs on the closing log is that
  // await's own wall-clock time. Never logs the message body, full phone number, tokens, or
  // secrets -- only truncated internal ids and booleans/durations.
  const msgIdLast8 = input.providerMessageId.slice(-8);

  deps.logger.warn({ messageIdLast8: msgIdLast8 }, "whatsapp inbound checkpoint 02: checking duplicate");
  let stepStart = Date.now();
  const existingMessage = await deps.messages.findByProviderMessageId("WHATSAPP", input.providerMessageId);
  deps.logger.warn({ messageIdLast8: msgIdLast8, durationMs: Date.now() - stepStart, isDuplicate: !!existingMessage }, "whatsapp inbound checkpoint 03: duplicate check complete");
  if (existingMessage) {
    deps.logger.warn({ messageIdLast8: msgIdLast8, duplicateDetected: true }, "whatsapp webhook ignored: duplicate");
    return { outcome: "DUPLICATE", leadId: existingMessage.leadId, conversationId: existingMessage.conversationId };
  }

  deps.logger.warn({ messageIdLast8: msgIdLast8 }, "whatsapp inbound checkpoint 04: resolving lead");
  stepStart = Date.now();
  const phoneE164 = normalizePhoneToE164(input.phoneRaw) ?? undefined;
  let lead = await deps.leads.findByDedupKey({ whatsappUserId: input.whatsappUserId, phoneE164 });
  const isNewLeadRecord = !lead;
  if (!lead) {
    lead = await deps.leadService.createLead({
      firstName: input.displayName,
      phone: input.phoneRaw,
      source: "WHATSAPP",
      whatsappUserId: input.whatsappUserId,
    });
  }
  deps.logger.warn(
    { messageIdLast8: msgIdLast8, leadIdLast8: lead.id.slice(-8), durationMs: Date.now() - stepStart, isNewLeadRecord, leadStatusBefore: lead.status },
    "whatsapp inbound checkpoint 05: lead resolved",
  );

  // Captured before recordInboundContact mutates status/timestamps, since the decision logic
  // below needs to know what was true *before* this message.
  const wasAlreadySuppressed = lead.status === "DO_NOT_CONTACT" || lead.status === "HUMAN_HANDOFF";
  const wasNew = lead.status === "NEW";

  deps.logger.warn({ messageIdLast8: msgIdLast8, leadIdLast8: lead.id.slice(-8) }, "whatsapp inbound checkpoint 06: recording inbound contact");
  stepStart = Date.now();
  lead = await deps.leadService.recordInboundContact(lead.id);
  deps.logger.warn({ messageIdLast8: msgIdLast8, leadIdLast8: lead.id.slice(-8), durationMs: Date.now() - stepStart }, "whatsapp inbound checkpoint 07: inbound contact recorded");

  // Fase 6B -- fiscal calculator context bridge. Recovers the most recent FiscalLeadContext for
  // this EXACT lead: the same Lead object the dedup logic above already resolved (whatsappUserId
  // first, then phoneE164 -- see LeadRepository.findByDedupKey's priority order), never a
  // second, independent phone lookup that could ever resolve to a different lead than the one
  // this pipeline is actually processing (see this task's identity principle -- phone only, no
  // name/email/fbclid/campaign/fuzzy matching, and never a false match). Fail-open: a lookup
  // failure -- or the dependency simply not being wired (e.g. a test that doesn't need it) --
  // never blocks ingestion or the reply; fiscalContext just stays null, identical to a lead that
  // never used the calculator. Read-only: getFiscalLeadContextForLead never writes to
  // leads/lead_scores/fiscal_lead_scores, so this can never mutate status/score/scoreClass/
  // qualifiedAt/bookingStartedAt/bookedAt/assignedAdvisor -- those stay owned exclusively by the
  // existing pipeline (qualification engine, booking handler, etc.), completely independent of
  // fiscal HOT/WARM/NURTURE.
  let fiscalContext: FiscalLeadContext | null = null;
  if (deps.fiscalLeadScores) {
    try {
      fiscalContext = await getFiscalLeadContextForLead({ fiscalLeadScores: deps.fiscalLeadScores }, lead);
    } catch (err) {
      // Safe warning only -- never phone/email/name/exact amounts, matching this task's logging
      // constraints.
      deps.logger.warn(
        { leadIdLast8: lead.id.slice(-8), errorName: err instanceof Error ? err.name : "unknown" },
        "fiscal context lookup failed for whatsapp inbound -- continuing without it",
      );
    }
    deps.logger.warn(
      {
        leadIdLast8: lead.id.slice(-8),
        contextFound: !!fiscalContext,
        ...(fiscalContext ? { scoreClass: fiscalContext.scoreClass, scoreVersion: fiscalContext.scoreVersion } : {}),
      },
      "fiscal context resolved for whatsapp inbound",
    );
  }

  deps.logger.warn({ messageIdLast8: msgIdLast8, leadIdLast8: lead.id.slice(-8) }, "whatsapp inbound checkpoint 08: resolving conversation");
  stepStart = Date.now();
  let conversation = await deps.conversations.findActiveByLeadId(lead.id);
  const isNewConversation = !conversation;
  if (!conversation) {
    conversation = await deps.conversations.create({ leadId: lead.id, channel: "WHATSAPP", status: "ACTIVE" });
  }
  deps.logger.warn(
    { messageIdLast8: msgIdLast8, conversationIdLast8: conversation.id.slice(-8), durationMs: Date.now() - stepStart, isNewConversation },
    "whatsapp inbound checkpoint 09: conversation resolved",
  );

  // Fase 6B.1 -- "primer inbound relevante de WhatsApp" for this lead/conversation, computed
  // from the conversation's ACTUAL message history (fetched now, before persistInboundMessage
  // below adds the current one -- so it never counts itself). Deliberately NOT lead.status
  // ("NEW") -- see domain/whatsapp-first-inbound.ts's doc comment for why. Only computed when a
  // fiscal context exists: it is the sole consumer of this signal (the fiscal-welcome branch
  // below), so a lead with no fiscal context never pays for the extra read.
  let isFirstWhatsAppInbound = false;
  if (fiscalContext) {
    const priorConversationMessages = isNewConversation ? [] : await deps.messages.listByConversationId(conversation.id);
    isFirstWhatsAppInbound = isFirstWhatsAppInboundForConversation(priorConversationMessages);
  }

  deps.logger.warn({ messageIdLast8: msgIdLast8, conversationIdLast8: conversation.id.slice(-8) }, "whatsapp inbound checkpoint 10: persisting inbound message");
  stepStart = Date.now();
  const { sensitiveDetected } = await persistInboundMessage(
    { messages: deps.messages },
    {
      conversationId: conversation.id,
      leadId: lead.id,
      body: input.text,
      providerMessageId: input.providerMessageId,
      sender: input.whatsappUserId,
      // Fase 6B, item 9: no duplication of score/bands here (recoverable from
      // fiscal_lead_scores via the lead) -- only a lightweight marker so a human/future handler
      // browsing conversations can see this message came from a fiscal-context-linked lead.
      extraMetadata: fiscalContext ? { origin: "FISCAL_CALCULATOR", fiscalContextAvailable: true } : undefined,
    },
  );
  deps.logger.warn(
    { messageIdLast8: msgIdLast8, durationMs: Date.now() - stepStart, sensitiveDetected },
    "whatsapp inbound checkpoint 11: inbound message persisted",
  );

  const leadId = lead.id;
  const conversationId = conversation.id;

  if (wasAlreadySuppressed) {
    // Lead was already DO_NOT_CONTACT or HUMAN_HANDOFF before this message: ingest silently,
    // no automated reply of any kind (not even a repeated handoff/opt-out acknowledgment).
    deps.logger.warn(
      { stage: "suppressed-lead-check", reason: "lead already DO_NOT_CONTACT or HUMAN_HANDOFF before this message", messageIdLast8: msgIdLast8, leadIdLast8: leadId.slice(-8), conversationIdLast8: conversationId.slice(-8) },
      "whatsapp inbound terminated",
    );
    return { outcome: "PROCESSED", leadId, conversationId };
  }

  /** Pre-launch production diagnostic (temporary): logs exactly which routing branch this turn
   * matched (or "no-match" if it fell through every one) immediately before that branch acts --
   * so a silent "no automated reply" outcome is always distinguishable, in the logs, from a hang
   * or a swallowed error. */
  const logBranch = (branch: string, willReply: boolean) =>
    deps.logger.warn(
      { messageIdLast8: msgIdLast8, leadIdLast8: leadId.slice(-8), conversationIdLast8: conversationId.slice(-8), branch, willReply },
      "whatsapp inbound checkpoint 13: branch matched",
    );

  deps.logger.warn({ messageIdLast8: msgIdLast8, leadIdLast8: leadId.slice(-8), conversationIdLast8: conversationId.slice(-8) }, "whatsapp inbound checkpoint 12: entering processing boundary");
  const processingBoundaryStart = Date.now();
  await runProcessingBoundary(
    async () => {
      if (isOptOutMessage(input.text)) {
        logBranch("opt-out", true);
        await deps.leadService.requestDoNotContact(leadId);
        await deps.conversations.update(conversationId, { status: "CLOSED" });
        await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, OPT_OUT_CONFIRMATION_MESSAGE);
        return;
      }
      if (sensitiveDetected) {
        logBranch("sensitive-health-content", true);
        await deps.leadService.requestHumanHandoff(leadId);
        await deps.conversations.update(conversationId, { status: "HUMAN_HANDOFF" });
        await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, HEALTH_HANDOFF_MESSAGE);
        return;
      }
      if (wasNew) {
        logBranch("wasNew-welcome", true);
        // Fase 6B, item 6: the ONLY conversational effect of fiscalContext in this phase --
        // acknowledges fiscal-calculator origin in general terms, no score/bands/amounts, and
        // only on the lead's very first inbound message, and only when that message itself
        // suggests fiscal-calculator origin (the prefilled CTA text or a close variant). Any
        // other combination (no fiscalContext, or a first message that doesn't mention it) sends
        // the exact same buildWelcomeMessage as before this phase -- unchanged.
        const isFiscalWelcome = !!(fiscalContext && looksLikeFiscalCalculatorOrigin(input.text));
        const welcomeBody = isFiscalWelcome
          ? buildFiscalContextWelcomeMessage(conversationalFirstName(lead))
          : buildWelcomeMessage(conversationalFirstName(lead));
        // Fase 6E.4: marks the FISCAL variant with fiscalWelcomeMenuMetadata() so a follow-up
        // digit/keyword reply always resolves correctly, regardless of lead.status -- see the
        // Fase 6E.4 report's root-cause trace. Deliberately scoped to the fiscal variant only
        // (plain buildWelcomeMessage is untouched, out of scope for this phase).
        await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, welcomeBody, isFiscalWelcome ? fiscalWelcomeMenuMetadata() : undefined);
        if (deps.qualificationHandler) {
          await deps.qualificationHandler.beginQualification(leadId);
        }
        return;
      }
      // Fase 6B.1 -- the actual E2E case this bridge exists for: a lead already captured via the
      // web fiscal calculator (source=WEB_FISCAL_CALCULATOR), whose status may have already moved
      // away from "NEW" for a reason entirely unrelated to WhatsApp (see
      // domain/whatsapp-first-inbound.ts's doc comment) -- so wasNew is false here, and the
      // branch above never fires for them. This is their genuinely first WhatsApp message ever
      // (isFirstWhatsAppInbound, computed from real conversation history above), it carries a
      // fiscal context, and the text itself suggests fiscal-calculator origin: still deserves the
      // one-time fiscal acknowledgment, sent here and ONLY here for this lead shape. Deliberately
      // does NOT call beginQualification (unlike the wasNew branch) -- this lead's status is not
      // "NEW"/freshly-contacted, so the existing status-based routing below (unchanged) still
      // owns whatever happens on this and every subsequent turn; this branch's only effect is
      // sending exactly one extra acknowledgment message, nothing else.
      if (!wasNew && fiscalContext && isFirstWhatsAppInbound && looksLikeFiscalCalculatorOrigin(input.text)) {
        logBranch("existing-lead-first-whatsapp-fiscal-welcome", true);
        await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, buildFiscalContextWelcomeMessage(conversationalFirstName(lead)), fiscalWelcomeMenuMetadata());
        return;
      }
      // Fase 6E.4: resolves a reply to the fiscal welcome's own 1-4 menu -- checked BEFORE every
      // status-based branch below, so it can never depend on which one (if any) would otherwise
      // apply. ROOT CAUSE this closes: a fiscal-calculator lead's status at the moment of their
      // follow-up reply can be NEW, CONTACTED (e.g. an advisor already called them via POST
      // /api/leads/:id/contact, unrelated to WhatsApp), QUALIFYING, QUALIFIED_A/B, or NURTURE_C --
      // and for the CONTACTED-with-productInterest-already-set shape specifically (impuestos.html's
      // own payload always sets productInterest="Beneficio fiscal PPR"), NO branch in this pipeline
      // ever claimed the reply before this fix (confirmed reproduced -- see the Fase 6E.4 report,
      // item 1). Only ever reached on a turn AFTER the fiscal welcome was actually sent (never on
      // the trigger message itself, which is handled by the two branches immediately above).
      if (fiscalContext && !isFirstWhatsAppInbound) {
        const priorMessagesForFiscalMenu = await deps.messages.listByConversationId(conversationId);
        const fiscalMenuPending = resolvePendingFiscalWelcomeMenu(priorMessagesForFiscalMenu);
        // Fase 6E.5, item 9: safe, PII-free observability for exactly this resolution step -- so a
        // future "silent branch" report can be diagnosed from logs alone, without needing to
        // reconstruct message history by hand. `pendingMenu` is the ONLY value ever logged here
        // (an opaque marker name, never message content); `pendingMenuResolved` is added below,
        // only once a digit/keyword lookup actually runs, to distinguish "no menu was pending" from
        // "a menu was pending but this reply didn't match anything recognizable".
        deps.logger.warn(
          { messageIdLast8: msgIdLast8, leadIdLast8: leadId.slice(-8), pendingMenu: fiscalMenuPending ? "FISCAL_WELCOME_MENU" : null },
          "whatsapp inbound checkpoint 12d: fiscal welcome menu pending-state resolved",
        );
        if (fiscalMenuPending) {
          const digitSelection = detectFiscalWelcomeDigit(input.text);
          if (digitSelection?.kind === "TOPIC") {
            logBranch(`fiscal-welcome-menu-${digitSelection.topic.toLowerCase()}`, true);
            // Fase 6E.3 reuse: PPR/GMM answers end by marking topicFollowupMetadata() so a
            // following "1"/"2"/"sí"/"ok" resolves naturally against THAT question -- same
            // mechanism, same reasoning, as WhatsAppPastBookedRecoveryHandler. SAVINGS has no
            // wired follow-up (its own question is open-ended, not a two-branch choice -- see
            // qualified-lead-topic-followup.ts's doc comment), so it carries no metadata: the
            // FISCAL_WELCOME_MENU state is simply consumed (item 8).
            const followupMetadata = digitSelection.topic === "PPR" || digitSelection.topic === "GMM" ? topicFollowupMetadata(digitSelection.topic) : undefined;
            await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, buildQualifiedLeadTopicAnswer(digitSelection.topic), followupMetadata);
            return;
          }
          if (digitSelection?.kind === "OTHER") {
            logBranch("fiscal-welcome-menu-other", true);
            await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, FISCAL_WELCOME_OTHER_TOPIC_MESSAGE);
            return;
          }
          // Fase 6E.4, item 9: free text ("quiero saber del PPR", "gastos médicos", "ahorro")
          // resolves semantically even while this menu is pending -- reuses the qualified
          // router's own deterministic keyword detection, never AI.
          const freeTextIntent = detectQualifiedLeadIntent(input.text, null);
          if (freeTextIntent.kind === "QUESTION") {
            logBranch(`fiscal-welcome-menu-freetext-${freeTextIntent.topic.toLowerCase()}`, true);
            const followupMetadata = freeTextIntent.topic === "PPR" || freeTextIntent.topic === "GMM" ? topicFollowupMetadata(freeTextIntent.topic) : undefined;
            await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, buildQualifiedLeadTopicAnswer(freeTextIntent.topic), followupMetadata);
            return;
          }
          // Genuinely unrecognized (neither a 1-4 digit nor a known topic keyword) -- never
          // guessed at, never silently dropped either: falls through to whatever status-based
          // branch below would otherwise apply (e.g. the qualification engine, if QUALIFYING).
          deps.logger.warn(
            { messageIdLast8: msgIdLast8, leadIdLast8: leadId.slice(-8), pendingMenu: "FISCAL_WELCOME_MENU", pendingMenuResolved: false },
            "whatsapp inbound checkpoint 12e: fiscal welcome menu was pending but this reply did not resolve against it",
          );
        }
      }
      if (deps.qualificationHandler && lead.status === "QUALIFYING") {
        logBranch("qualifying-turn", true);
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
        logBranch("contacted-recovery", true);
        await deps.qualificationHandler.beginQualification(leadId);
        const recoveredLead: Lead = { ...lead, status: "QUALIFYING" };
        await deps.qualificationHandler.handleTurn({ lead: recoveredLead, conversationId, whatsappUserId: input.whatsappUserId, inboundText: input.text });
        return;
      }
      // Pre-launch hardening: a QUALIFIED_A/QUALIFIED_B/NURTURE_C lead's free text is checked by
      // WhatsAppBookingHandler itself for explicit new-booking intent (isNewBookingRequest) --
      // most commonly reached right after abandoning a prior BOOKING_PENDING round (see
      // WhatsAppBookingHandler.abandonBookingPending), but also reachable for a lead who simply
      // never started booking yet. Dispatches unconditionally on status alone, mirroring the
      // CANCELLED -> reactivationHandler precedent below (the intent check lives inside the
      // handler, not duplicated here).
      //
      // Root-cause fix (confirmed against real production logs): WhatsAppBookingHandler.handleTurn
      // now reports back whether it actually acted (and therefore already replied) on the turn --
      // see that method's doc comment. When it did NOT (a genuinely non-booking message, e.g.
      // "Hola, quiero información"), this is the sole owner of a SEPARATE, generic conversational
      // fallback -- never silence for a qualified lead's valid free text, same "never leave a
      // real inbound message unanswered" principle already applied to BOOKED_GENERIC_INBOUND_MESSAGE
      // and PAST_BOOKED_GENERIC_INBOUND_MESSAGE. Exactly one reply either way: the handler's own
      // (booking intent) or this fallback (no booking intent) -- never both, since this branch
      // only sends its own message when the handler's return value says it did nothing.
      // WhatsAppBookingHandler itself is deliberately NOT changed into a generic handler -- it
      // still only ever knows about booking; the fallback decision and copy live here.
      //
      // Bug fix (production, fiscal-context follow-up): the condition below used to be
      // `deps.bookingHandler && (status===...)`, nesting the ENTIRE branch -- including the
      // generic fallback above -- inside "booking is enabled". With WHATSAPP_BOOKING_ENABLED=false
      // (bookingHandler absent), a QUALIFIED_A/B/NURTURE_C lead's free text fell through every
      // remaining branch straight to "no-match": inbound persisted, zero outbound, silently. The
      // f35a9f8 fallback was correct in design but unreachable whenever booking is off -- exactly
      // the state this project is deployed with. Status alone now decides whether this lead OWES
      // a reply; bookingHandler's presence only decides HOW that reply is produced (delegate vs.
      // the fallback directly) -- booking itself is NOT activated by this fix.
      if (lead.status === "QUALIFIED_A" || lead.status === "QUALIFIED_B" || lead.status === "NURTURE_C") {
        // Fase 6C router: determined BEFORE calling bookingHandler (not just as its fallback) --
        // Fase 6D needs to know here whether THIS turn already means BOOKING (e.g. a bare "3"
        // against the main menu), so that intent can be handed to bookingHandler as
        // bookingIntentOverride below. bookingHandler's own isNewBookingRequest check has no
        // visibility into the menu-digit context (exclusively this router's concern), so without
        // this the real booking flow could only ever be reached by an explicit phrase like
        // "quiero agendar una cita", never by the menu's own option "3".
        const priorMessages = await deps.messages.listByConversationId(conversationId);
        const pendingMenu = resolvePendingQualifiedMenu(priorMessages);
        // Fase 6E.1: re-derived here, NOT persisted in metadata -- the OPTIONS submenu's item
        // order depends only on fiscalContext (see qualified-lead-options-menu.ts's doc comment),
        // and fiscalContext is already resolved above for this same lead/turn, so recomputing it
        // here is guaranteed to match exactly what the lead was shown, without adding any
        // financial/score data to the outbound message's metadata.
        const intent = detectQualifiedLeadIntent(input.text, pendingMenu, !!fiscalContext);

        const handledByBooking = deps.bookingHandler
          ? await deps.bookingHandler.handleTurn({
              lead, conversationId, whatsappUserId: input.whatsappUserId, inboundText: input.text, now: new Date(),
              bookingIntentOverride: intent.kind === "BOOKING",
            })
          : false;
        if (handledByBooking) {
          // Fase 6D: with WHATSAPP_BOOKING_ENABLED=true, this is the REAL Google Calendar booking
          // flow (WhatsAppBookingHandler -> SlotOfferingService -> GoogleCalendarProvider) --
          // never QUALIFIED_LEAD_BOOKING_FALLBACK_MESSAGE. With the flag false (bookingHandler
          // absent), handledByBooking is always false and this branch is never taken -- unchanged.
          logBranch("qualified-or-nurture-booking", true);
        } else {
          // Fase 6C -- the generic fallback above answered EVERY non-booking message with the
          // exact same menu, forever (production bug: "1"/"2"/"3"/a real question all re-showed
          // it). This router makes the menu's own options actually go somewhere. Deterministic
          // only -- no AI_PROVIDER call. Reached for BOOKING intent ONLY when bookingHandler is
          // absent (flag off) or otherwise didn't act -- QUALIFIED_LEAD_BOOKING_FALLBACK_MESSAGE
          // never invents availability or creates anything.
          switch (intent.kind) {
            case "QUESTION":
              logBranch(`qualified-or-nurture-question-${intent.topic.toLowerCase()}`, true);
              // Fase 6E: ends on a topic-specific contextual question, never the main menu again
              // (item 6 -- "no regresar automáticamente al menú principal") -- so this reply does
              // NOT mark qualifiedMainMenuMetadata(); a bare "1"/"2"/"3" on the NEXT turn is
              // genuinely ambiguous here and safely falls back to the main menu via UNKNOWN below.
              await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, buildQualifiedLeadTopicAnswer(intent.topic));
              break;
            case "EXPLORE_OPTIONS":
              logBranch("qualified-or-nurture-explore-options", true);
              // fiscalContext is the ONLY thing allowed to influence this reply, and only the
              // ORDER of options -- never HOT/WARM/NURTURE, never score, never bands, never
              // mentioned in the message itself.
              // Fase 6E.1: marks this reply as the OPTIONS pending menu (qualifiedOptionsMenuMetadata()
              // -- an opaque state identifier only, same shape as qualifiedMainMenuMetadata()) so a
              // bare digit reply on the NEXT turn resolves against THIS submenu instead of falling
              // through to UNKNOWN and re-showing the main menu (the Fase 6E.1 production bug).
              await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, buildQualifiedLeadOptionsMessage(!!fiscalContext), qualifiedOptionsMenuMetadata());
              break;
            case "BOOKING":
              logBranch("qualified-or-nurture-booking-fallback", true);
              await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, QUALIFIED_LEAD_BOOKING_FALLBACK_MESSAGE);
              break;
            case "MENU_QUESTION":
              logBranch("qualified-or-nurture-menu-question", true);
              // hasFiscalContext narrows the prompt to "tu estrategia de retiro" -- topic only,
              // never score/HOT/bands.
              await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, buildQualifiedLeadAskQuestionMessage(!!fiscalContext));
              break;
            case "IDENTITY":
              logBranch("qualified-or-nurture-identity", true);
              await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, QUALIFIED_LEAD_IDENTITY_ANSWER_MESSAGE);
              break;
            case "UNKNOWN":
              logBranch("qualified-or-nurture-generic-fallback", true);
              await sendAndPersistReply(deps, leadId, conversationId, input.whatsappUserId, QUALIFIED_LEAD_GENERIC_INBOUND_MESSAGE, qualifiedMainMenuMetadata());
              break;
          }
        }
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
        logBranch("booking-pending", true);
        await deps.bookingHandler.handleTurn({ lead, conversationId, whatsappUserId: input.whatsappUserId, inboundText: input.text, now: new Date() });
        return;
      }
      // Phase 4C: a RESCHEDULE_REQUESTED lead is picking a new slot (or asking to cancel instead
      // -- see WhatsAppRescheduleHandler, item 13). Only ever reachable via the BOOKED-turn branch
      // just below, so rescheduleHandler being present here is a precondition, not a coincidence.
      if (deps.rescheduleHandler && lead.status === "RESCHEDULE_REQUESTED") {
        logBranch("reschedule-requested-turn", true);
        await deps.rescheduleHandler.handleTurn({ lead, conversationId, whatsappUserId: input.whatsappUserId, inboundText: input.text, now: new Date() });
        return;
      }
      // Pre-launch hardening: a BOOKED lead whose appointment is stale/past (status still
      // BOOKED, but endsAt already elapsed) is routed to a dedicated recovery handler INSTEAD OF
      // the reschedule-intent / cancellation / generic-BOOKED-fallback branches below -- all of
      // which previously treated ANY status==="BOOKED" row as a genuine, current commitment
      // (isUpcomingBooked's doc comment has the full "why"). Checked BEFORE the reschedule-intent
      // branch immediately below so a past appointment is never mistaken for one still being
      // rescheduled/cancelled. Gated on BOTH pastBookedRecoveryHandler and appointments being
      // present -- absent either, this extra read/branch is skipped entirely and a BOOKED lead's
      // text is routed exactly as it was before this hardening pass, unchanged.
      if (deps.pastBookedRecoveryHandler && deps.appointments && lead.status === "BOOKED") {
        deps.logger.warn({ messageIdLast8: msgIdLast8, leadIdLast8: leadId.slice(-8) }, "whatsapp inbound checkpoint 12b: checking upcoming-appointment status (BOOKED lead)");
        const upcomingCheckStart = Date.now();
        const activeAppointment = await deps.appointments.findActiveByLeadId(lead.id);
        const hasUpcomingAppointment = !!activeAppointment && isUpcomingBooked(activeAppointment, new Date());
        deps.logger.warn(
          { messageIdLast8: msgIdLast8, durationMs: Date.now() - upcomingCheckStart, hasActiveAppointment: !!activeAppointment, hasUpcomingAppointment },
          "whatsapp inbound checkpoint 12c: upcoming-appointment check complete",
        );
        if (!hasUpcomingAppointment) {
          logBranch("booked-past-appointment-recovery", true);
          // Fase 6E.2: hasFiscalContext mirrors the qualified router's own `!!fiscalContext` --
          // fiscalContext is already resolved above for this same lead/turn, so this is the exact
          // same signal, never re-derived differently. Only affects the ORDER of an "opciones"
          // reply, never its content -- see WhatsAppPastBookedRecoveryHandler's doc comment.
          await deps.pastBookedRecoveryHandler.handleTurn({
            lead, conversationId, whatsappUserId: input.whatsappUserId, inboundText: input.text, now: new Date(),
            hasFiscalContext: !!fiscalContext,
          });
          return;
        }
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
        logBranch("booked-reschedule-intent", true);
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
        logBranch("booked-generic-fallback", true);
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
        logBranch("cancellation-turn", true);
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
        logBranch("cancelled-reactivation", true);
        await deps.reactivationHandler.handleTurn({ lead, conversationId, whatsappUserId: input.whatsappUserId, inboundText: input.text, now: new Date() });
        return;
      }
      // No qualifier/booking/cancellation/reschedule/reactivation handler configured (flags off),
      // or an existing lead outside an active round (e.g. already QUALIFIED_A/B/NURTURE_C, or a
      // CONTACTED lead that still carries a product from a prior round): no automated reply, same
      // as Phase 2.
      logBranch("no-match", false);
    },
    deps.logger,
    { leadId, conversationId },
  );
  deps.logger.warn(
    { messageIdLast8: msgIdLast8, leadIdLast8: leadId.slice(-8), conversationIdLast8: conversationId.slice(-8), durationMs: Date.now() - processingBoundaryStart },
    "whatsapp inbound checkpoint 15: processing boundary complete",
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
  // Fase 6C: optional, opaque state markers only (e.g. qualifiedMainMenuMetadata()) -- never
  // PII, never a score/band. Every existing call site omits this and keeps getting `metadata: {}`
  // exactly as before.
  metadata: Record<string, unknown> = {},
): Promise<void> {
  let providerMessageId: string | undefined;
  // Pre-launch production diagnostic (temporary, redacted): never the full recipient, never the
  // message body.
  deps.logger.warn({ leadId, conversationId, toLast4: to.length >= 4 ? to.slice(-4) : to }, "attempting WhatsApp outbound response");
  try {
    const result = await deps.messaging.sendText(to, body);
    providerMessageId = result.providerMessageId;
    deps.logger.warn(
      { leadId, conversationId, messageIdLast8: providerMessageId?.slice(-8) },
      "WhatsApp outbound response sent",
    );
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
        "WhatsApp outbound response failed -- the inbound message that triggered it remains persisted.",
      );
    } else {
      deps.logger.warn(
        { leadId, conversationId, reason: "unknown", ...recipientDiagnostics },
        "WhatsApp outbound response failed -- the inbound message that triggered it remains persisted.",
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
    metadata,
  });
}
