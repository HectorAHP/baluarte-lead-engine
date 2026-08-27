import type { LeadRepository, ConversationRepository, MessageRepository, QualificationAnswerRepository, LeadScoreRepository, MessagingProvider, LeadStatusHistoryRepository, Logger } from "./ports.js";
import type { LeadService } from "./services.js";
import type { Lead } from "../domain/lead.js";
import type { AnswerRecord } from "../domain/qualification-state.js";
import { stepsForProduct } from "../domain/qualification-catalog.js";
import type { QualificationProduct } from "../domain/qualification-fields.js";
import { QualificationService } from "./qualification-service.js";
import { advanceQualification, type QualificationOutcome } from "./qualification-engine.js";
import { reconstructQualificationState } from "./qualification-state-reconstruction.js";
import { sendAndPersistReply, type QualificationTurnHandler } from "./whatsapp-inbound-service.js";
import { productVertical } from "../domain/qualification-fields.js";
import {
  scorePatrimonialQualification,
  scoreGmmQualification,
  type ClarityLevel,
  type EngagementLevel,
  type Urgency,
  type MonthlyCapacity,
} from "../domain/qualification-scoring.js";
import {
  QUALIFICATION_COMPLETE_AB_MESSAGE, NURTURE_C_MESSAGE, QUALIFIER_HUMAN_HANDOFF_MESSAGE,
  SLOT_OFFER_CLAIM_IN_PROGRESS_MESSAGE,
} from "../domain/message-templates.js";
import type { SlotOfferingService } from "./slot-offering-service.js";
import { dispatchSlotOfferOutcome, escalateToHuman } from "./booking-outcome-dispatch.js";
import { ActiveOfferInconsistentError, SlotOfferClaimInProgressError } from "../domain/errors.js";
import { config } from "../config.js";

export interface WhatsAppQualificationHandlerDeps {
  leads: LeadRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  qualificationAnswers: QualificationAnswerRepository;
  leadScores: LeadScoreRepository;
  leadService: LeadService;
  messaging: MessagingProvider;
  leadStatusHistory: LeadStatusHistoryRepository;
  logger: Logger;
  /** Phase 3C: present only when WHATSAPP_BOOKING_ENABLED is true (see app.ts). When absent,
   * applyOutcome's QUALIFICATION_COMPLETE branch behaves exactly as Phase 3B -- the completion
   * message only, no offer attempted. Booking never activates on its own: a lead only ever
   * reaches this branch by first completing qualification, so this dependency alone can never
   * bypass qualification for a lead that hasn't gone through it. */
  slotOffering?: SlotOfferingService;
}

/**
 * ENGAGEMENT cannot be read off QualificationState.retriedStepIds here: that field only lives
 * inside one advanceQualification() call's return value, and this handler reconstructs state
 * fresh from Supabase on every single inbound turn (by design -- see the reconstruction module),
 * so an in-memory retry counter never survives from one turn to the next. Every inbound WhatsApp
 * message *is* durably persisted before the qualifier ever runs though (persistInboundMessage in
 * whatsapp-inbound-service.ts, unconditionally), so the number of INBOUND messages this
 * conversation actually took to answer every required question -- versus the theoretical minimum
 * of one "trigger" message + one intent-resolving message + one per catalog question -- is a
 * reconstructable, zero-migration proxy for how much re-asking happened.
 */
async function computeEngagement(deps: Pick<WhatsAppQualificationHandlerDeps, "messages">, conversationId: string, product: QualificationProduct): Promise<EngagementLevel> {
  const allMessages = await deps.messages.listByConversationId(conversationId);
  const inboundCount = allMessages.filter((m) => m.direction === "INBOUND").length;
  const requiredSteps = stepsForProduct(product).length;
  const expectedMinimum = 2 + requiredSteps; // 1 trigger message + 1 intent-resolving message + 1 per question
  const extraAttempts = Math.max(0, inboundCount - expectedMinimum);
  if (extraAttempts === 0) return "ALL_ANSWERED";
  if (extraAttempts < requiredSteps) return "MOST_ANSWERED";
  return "LOW";
}

/**
 * Derived from the *content* of specific answers, not from retry behavior (see computeEngagement
 * above for why retries aren't reconstructable) -- a lead who picks a vague/catch-all option is
 * read as less clear about what they want, independent of how many messages it took to get
 * there. Each product's "vague" option is the one the catalog itself offers as an escape hatch.
 */
function clarityFromAnswers(product: QualificationProduct, answers: Record<string, AnswerRecord>): ClarityLevel {
  if (product === "SAVINGS") return answers.objective?.value === "OTRO" ? "AMBIGUOUS" : "CLEAR";
  if (product === "RETIREMENT_PPR") return answers.fiscal_situation?.value === "PREFERS_ADVISOR_REVIEW" ? "PARTIAL" : "CLEAR";
  return answers.priority?.value === "BALANCE" ? "PARTIAL" : "CLEAR"; // GMM
}

/**
 * Phase 3B: connects the pure Phase 3A qualifier (advanceQualification) to real WhatsApp
 * transport and Supabase persistence. Implements QualificationTurnHandler so
 * WhatsAppInboundService stays decoupled from qualification business logic -- this class is
 * where that logic actually lives.
 */
export class WhatsAppQualificationHandler implements QualificationTurnHandler {
  private readonly qualificationService: QualificationService;

  constructor(private readonly deps: WhatsAppQualificationHandlerDeps) {
    this.qualificationService = new QualificationService(deps.qualificationAnswers);
  }

  async beginQualification(leadId: string): Promise<void> {
    await this.deps.leadService.startQualification(leadId);
  }

  async handleTurn(params: { lead: Lead; conversationId: string; whatsappUserId: string; inboundText: string }): Promise<void> {
    const { lead, conversationId, whatsappUserId, inboundText } = params;

    // Guard against silently re-running the qualifier for a lead who already completed a round
    // before (score history exists) and is starting fresh again (no product chosen yet this
    // time). The only way to reach QUALIFYING with no productInterest and prior score history is
    // for something outside this WhatsApp flow to have moved a NURTURE_C (or QUALIFIED_A/B) lead
    // back to QUALIFYING -- beginQualification() here is only ever called from a brand-new
    // lead's very first message, so it can never do this by itself. Reconstructing normally in
    // that situation risks reusing a *previous* round's qualification_answers (SAVINGS and
    // RETIREMENT_PPR share field names like urgency/monthly_capacity), so this is a hard stop to
    // a human instead of a guess -- no qualification_run_id / migration needed for it.
    if (!lead.productInterest) {
      const priorScores = await this.deps.leadScores.listByLeadId(lead.id);
      if (priorScores.length > 0) {
        await this.deps.leadService.requestHumanHandoff(lead.id);
        await this.deps.conversations.update(conversationId, { status: "HUMAN_HANDOFF" });
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, QUALIFIER_HUMAN_HANDOFF_MESSAGE);
        return;
      }
    }

    const existingAnswers = await this.qualificationService.listAnswers(lead.id);
    const priorState = reconstructQualificationState(lead, existingAnswers);
    const { state: nextState, outcome } = advanceQualification(priorState, inboundText);

    if (nextState.product && nextState.product !== lead.productInterest) {
      // productVertical is set in the SAME update as productInterest, never separately -- a
      // lead with productInterest=GMM and productVertical still UNKNOWN was a real, confirmed
      // data bug (nothing downstream that filters/reports by productVertical would ever see
      // these leads). Both fields describe the same resolved product and must never drift apart.
      await this.deps.leads.update(lead.id, { productInterest: nextState.product, productVertical: productVertical(nextState.product) });
    }

    if (nextState.product) {
      const vertical = productVertical(nextState.product);
      for (const [fieldName, record] of Object.entries(nextState.answers)) {
        if (priorState.answers[fieldName]) continue; // already persisted in an earlier turn
        await this.qualificationService.recordAnswer({
          leadId: lead.id,
          conversationId,
          vertical,
          fieldName,
          fieldValue: record.value,
          source: "MANUAL",
        });
      }
    }

    await this.applyOutcome(lead, conversationId, whatsappUserId, outcome);
  }

  private async applyOutcome(lead: Lead, conversationId: string, whatsappUserId: string, outcome: QualificationOutcome): Promise<void> {
    switch (outcome.kind) {
      case "OPT_OUT":
      case "ALREADY_TERMINAL":
        // Opt-out is already handled earlier in handleInboundWhatsAppText, before this handler
        // is ever reached; ALREADY_TERMINAL is a pure safety no-op.
        return;

      case "ASK":
      case "NEEDS_CLARIFICATION":
      case "NEEDS_LOCATION_CONFIRMATION":
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, outcome.message);
        return;

      case "HUMAN_HANDOFF":
        await this.deps.leadService.requestHumanHandoff(lead.id);
        await this.deps.conversations.update(conversationId, { status: "HUMAN_HANDOFF" });
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, outcome.message);
        return;

      case "QUALIFICATION_COMPLETE": {
        // Deliberately does not touch conversation.status here (it stays ACTIVE) for all three
        // commercial outcomes -- QUALIFIED_A, QUALIFIED_B, and NURTURE_C. Unlike HUMAN_HANDOFF
        // and DO_NOT_CONTACT (both real "stop automated engagement" signals), completing
        // qualification is not a reason to close the thread: Phase 3C continues in this same
        // conversation to offer time slots for A/B, and NURTURE_C is a commercial classification,
        // not a consent decision, so nothing here should read as "don't contact this lead again."
        const engagement = await computeEngagement(this.deps, conversationId, outcome.product);
        const clarity = clarityFromAnswers(outcome.product, outcome.answers);

        const scoreResult =
          outcome.vertical === "GMM"
            ? scoreGmmQualification({
                urgency: outcome.answers.urgency.value as Urgency,
                needClarity: clarity,
                // GMM cannot reach QUALIFICATION_COMPLETE with an incomplete location -- the
                // engine only advances past the LOCATION step once city+state+postal are all set.
                locationCompleteness: "COMPLETE",
                hasCurrentInsurance:
                  outcome.answers.has_current_insurance?.value === "YES" ? true : outcome.answers.has_current_insurance?.value === "NO" ? false : "UNKNOWN",
                engagement,
                readiness: "WANTS_INFO_FIRST", // readiness=6: qualification complete, agenda not yet offered (Phase 3C)
              })
            : scorePatrimonialQualification({
                urgency: outcome.answers.urgency.value as Urgency,
                monthlyCapacity: outcome.answers.monthly_capacity.value as MonthlyCapacity,
                objectiveClarity: clarity,
                engagement,
                readiness: "WANTS_INFO_FIRST",
              });

        const updatedLead = await this.deps.leadService.applyQualificationScore(lead.id, {
          vertical: outcome.vertical,
          total: scoreResult.total,
          scoreClass: scoreResult.scoreClass,
          breakdown: { ...scoreResult.breakdown, readinessReason: "PRE_APPOINTMENT_OFFER" },
          rulesVersion: scoreResult.rulesVersion,
        });

        const message = updatedLead.scoreClass === "C" ? NURTURE_C_MESSAGE : QUALIFICATION_COMPLETE_AB_MESSAGE;
        await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, message);

        // Phase 3C: only for a genuinely qualified A/B outcome (never NURTURE_C -- that's a
        // nurture classification, not a booking-eligible one), and only when booking integration
        // is enabled (this.deps.slotOffering present). Two separate outbound messages by design
        // (never merged): the completion message above, then this offer as its own message.
        if (updatedLead.scoreClass !== "C" && this.deps.slotOffering) {
          const now = new Date();
          try {
            const offerOutcome = await this.deps.slotOffering.getOrCreateOffer({ lead: updatedLead, conversationId, now });
            await dispatchSlotOfferOutcome(this.deps, offerOutcome, updatedLead, conversationId, whatsappUserId, config.ADVISOR_TIMEZONE);
          } catch (err) {
            if (err instanceof SlotOfferClaimInProgressError) {
              // A concurrency signal, not a problem: another concurrent request is (or just was)
              // legitimately creating this conversation's offer. The qualification outcome
              // (score, scoreClass, updatedLead.status) computed above is ALREADY saved and is
              // never reverted here -- this catch only decides what to do about the offer step
              // that didn't complete. No HUMAN_HANDOFF, no forcing another round: the lead simply
              // stays whatever applyQualificationScore already set it to (QUALIFIED_A/B -- this
              // branch never reaches ensureBookingPending, so it is NOT moved to BOOKING_PENDING
              // either). A later turn (once the lead reaches BOOKING_PENDING through some other
              // path, or a future retry mechanism) can successfully create the offer once the
              // winning request's claim is no longer in the way.
              this.deps.logger.warn(
                { leadId: lead.id, conversationId, errorName: err.name },
                "Slot-offering claim in progress right after qualification completed -- qualification stays saved; asking the lead to retry shortly.",
              );
              await sendAndPersistReply(this.deps, lead.id, conversationId, whatsappUserId, SLOT_OFFER_CLAIM_IN_PROGRESS_MESSAGE);
              return;
            }
            if (err instanceof ActiveOfferInconsistentError) {
              this.deps.logger.warn(
                { leadId: lead.id, conversationId, errorName: err.name },
                "Booking data-consistency error while offering slots right after qualification -- escalating to human handoff.",
              );
              await escalateToHuman(this.deps, updatedLead, conversationId, whatsappUserId);
              return;
            }
            // Any other failure (DB error, etc.) here is NOT silently invented a recovery path
            // for -- it propagates to runProcessingBoundary's existing catch-all (logs, never
            // rethrown). Documented as an open risk in the Phase 3C block report: unlike a
            // send-only failure (sendAndPersistReply already swallows those internally), a
            // getOrCreateOffer failure here has no automatic retry trigger yet.
            throw err;
          }
        }
        return;
      }
    }
  }
}
