import type { Lead, LeadDedupKey } from "../domain/lead.js"; import type { Appointment, AppointmentStatus } from "../domain/appointment.js"; import type { BookingAttempt, BookingAttemptStatus } from "../domain/booking-attempt.js"; import type { Conversation } from "../domain/conversation.js"; import type { Message } from "../domain/message.js"; import type { QualificationAnswer } from "../domain/qualification-answer.js"; import type { LeadScoreRecord } from "../domain/lead-score-record.js"; import type { OfferedSlot } from "../domain/offered-slot.js"; import type { SlotOfferClaim } from "../domain/slot-offer-claim.js"; import type { LeadStatusHistoryEntry } from "../domain/lead-status-history.js"; import type { AppointmentStatusHistoryEntry } from "../domain/appointment-status-history.js"; import type { AppointmentMessageDelivery } from "../domain/appointment-message-delivery.js"; import type { AppointmentCancellation } from "../domain/appointment-cancellation.js"; import type { AppointmentReschedule } from "../domain/appointment-reschedule.js";
import type { ProcessedEvent } from "../domain/processed-event.js";
import type { FiscalLeadScore } from "../domain/fiscal-lead-score.js";
export interface LeadRepository { create(input:Omit<Lead,"id"|"createdAt"|"updatedAt">):Promise<Lead>; findById(id:string):Promise<Lead|null>; update(id:string,patch:Partial<Lead>):Promise<Lead>; findByDedupKey(key:LeadDedupKey):Promise<Lead|null>; }
/**
 * Generic (provider, event_id) idempotency guard, backed by the `processed_events` table
 * (existing since migration 001, previously unused by any application code). Same tryCreate
 * idiom as SlotOfferClaimRepository/AppointmentMessageDeliveryRepository/etc: wins outright
 * (insert succeeds) or returns null on a (provider, event_id) unique-conflict -- i.e. this exact
 * event was already processed -- never throws for that case, only for genuinely unexpected
 * errors. First consumer: web-lead-capture.ts, keyed by the frontend-generated submissionId.
 */
export interface ProcessedEventRepository {
  tryCreate(input: { provider: string; eventId: string }): Promise<ProcessedEvent | null>;
}
export interface AppointmentRepository {
  create(input:Omit<Appointment,"id">):Promise<Appointment>;
  findById(id:string):Promise<Appointment|null>;
  update(id:string,patch:Partial<Appointment>):Promise<Appointment>;
  /**
   * The lead's most recent appointment with status "BOOKED" -- CANCELLED and any other status
   * never count as "active". Returns null (never throws) when none exists.
   *
   * AMBIGUOUS BY DESIGN during the brief Phase 4C reschedule coexistence window (new appointment
   * persisted BOOKED, old not yet CAS'd to RESCHEDULED -- see AppointmentRescheduleService's class
   * doc comment, item 7 of the Phase 4C hardening report): with two BOOKED rows for one lead, this
   * always returns the NEWEST one (most recently created -- both InMemory's insertion-order "last
   * match" and Supabase's `order(created_at desc).limit(1)` agree on this). Callers that could
   * plausibly run DURING that window (WhatsAppCancellationHandler, WhatsAppRescheduleHandler) NEVER
   * use this single-row method for their own target-appointment resolution -- both exclusively use
   * listActiveByLeadId below and treat >1 as a hard escalation, precisely so this ambiguity can
   * never cause either handler to act on the wrong appointment. Only WhatsAppBookingHandler and
   * SlotOfferingService (booking mode) still use this method, and neither is ever reachable for a
   * lead that could be mid-reschedule (both require BOOKING_PENDING/QUALIFIED_A/B, never
   * RESCHEDULE_REQUESTED).
   */
  findActiveByLeadId(leadId:string):Promise<Appointment|null>;
  /**
   * Every BOOKED appointment for this lead (there should only ever be at most one outside the
   * Phase 4C reschedule coexistence window above -- this exists so a caller can DETECT ">1" as a
   * genuine data-consistency violation, which findActiveByLeadId's single-row "most recent"
   * contract cannot surface). Phase 4B: WhatsAppCancellationHandler uses this to decide between
   * "proceed" (exactly 1), "escalate, nothing to cancel" (0), and "escalate, inconsistent" (>1).
   * Phase 4C: WhatsAppRescheduleHandler does the same.
   */
  listActiveByLeadId(leadId:string):Promise<Appointment[]>;
  /** The lead's single most recent appointment regardless of status, or null if none ever
   * existed. Used only to locate the target appointment for an idempotent cancellation retry once
   * it's no longer BOOKED (i.e. already CANCELLED) -- never to guess which appointment a booking
   * flow should act on. */
  findMostRecentByLeadId(leadId:string):Promise<Appointment|null>;
  /**
   * Atomic compare-and-set: transitions row `id` from `expectedStatus` to `nextStatus` ONLY if its
   * current status still matches `expectedStatus`. Returns the updated row if this call won the
   * race, or null if another request already changed the status first -- never throws for the
   * "lost the race" case. Mirrors BookingAttemptRepository.claimTransition's exact contract
   * (appointments has no updatedAt column, so there is no `updatedBefore` staleness option here --
   * unlike a booking attempt, an appointment has no legitimate "in progress, not yet decided"
   * intermediate status to ever go stale).
   */
  claimTransition(id:string,expectedStatus:AppointmentStatus,nextStatus:AppointmentStatus):Promise<Appointment|null>;
  /** Every appointment row for this lead, ANY status (BOOKED, RESCHEDULED, CANCELLED, or any
   * other) -- unlike every other method on this interface, deliberately not scoped to "active" or
   * "most recent". Not used by any booking/cancellation/reschedule business logic (those all use
   * the status-scoped methods above, which is what keeps their concurrency contracts precise) --
   * exists purely for read-only administrative tooling (see scripts/reset-test-lead.ts), which
   * needs to see the FULL Phase 4B/4C history for a lead (e.g. an old RESCHEDULED row sitting
   * alongside a new BOOKED one) before deleting it, not just the single currently-active row
   * findActiveByLeadId returns. Same rationale/precedent as
   * BookingAttemptRepository.listByLeadId. */
  listAllByLeadId(leadId:string):Promise<Appointment[]>;
}
export interface BookingAttemptRepository {
  findByKey(idempotencyKey:string):Promise<BookingAttempt|null>;
  create(input:Omit<BookingAttempt,"id"|"createdAt"|"updatedAt">):Promise<BookingAttempt>;
  update(id:string,patch:Partial<BookingAttempt>):Promise<BookingAttempt>;
  /**
   * Atomic compare-and-set: transitions row `id` from `expectedStatus` to `nextStatus` (and
   * bumps updatedAt) ONLY if its current status still matches `expectedStatus` (and, when
   * `options.updatedBefore` is given, only if updatedAt is older than that cutoff too).
   * Returns the updated row if this call won the race, or null if another request already
   * changed the status first -- never throws for the "lost the race" case, that's an expected
   * outcome, not an error.
   */
  claimTransition(id:string,expectedStatus:BookingAttemptStatus,nextStatus:BookingAttemptStatus,options?:{updatedBefore:Date}):Promise<BookingAttempt|null>;
  /** Every booking_attempts row for this lead, in no particular guaranteed order. Not used by
   * any booking/idempotency logic (that's all keyed by idempotencyKey) -- exists purely for
   * read-only administrative tooling (see scripts/reset-test-lead.ts) that needs to preview/audit
   * what exists for a lead before deleting it. */
  listByLeadId(leadId:string):Promise<BookingAttempt[]>;
}
export interface ConversationRepository { create(input:Omit<Conversation,"id"|"createdAt"|"updatedAt">):Promise<Conversation>; findById(id:string):Promise<Conversation|null>; findActiveByLeadId(leadId:string):Promise<Conversation|null>; update(id:string,patch:Partial<Conversation>):Promise<Conversation>; }
export interface MessageRepository { create(input:Omit<Message,"id"|"createdAt">):Promise<Message>; findByProviderMessageId(channel:Message["channel"],providerMessageId:string):Promise<Message|null>; listByConversationId(conversationId:string):Promise<Message[]>; }
export interface QualificationAnswerRepository { create(input:Omit<QualificationAnswer,"id"|"createdAt">):Promise<QualificationAnswer>; listByLeadId(leadId:string):Promise<QualificationAnswer[]>; }
export interface LeadScoreRepository { create(input:Omit<LeadScoreRecord,"id"|"createdAt">):Promise<LeadScoreRecord>; listByLeadId(leadId:string):Promise<LeadScoreRecord[]>; }
/**
 * Fase 6A -- fiscal calculator commercial scoring (fiscal_v1), deliberately separate from
 * LeadScoreRepository/lead_scores above (see migration 018_fiscal_lead_scores.sql's header
 * comment for why: LeadScoreRecord.vertical/scoreClass are closed types owned by the WhatsApp
 * conversational qualifier, and breakdown cannot hold a reasons array).
 */
export interface FiscalLeadScoreRepository {
  /** Wins outright (INSERT succeeds) or returns null on a (lead_id, submission_id) conflict --
   * never throws for the "already scored this submission" case, same tryCreate convention as
   * ProcessedEventRepository/SlotOfferClaimRepository. This is what makes fiscal scoring
   * idempotent per calculator submission. */
  tryCreate(input: Omit<FiscalLeadScore, "id" | "createdAt">): Promise<FiscalLeadScore | null>;
  /** Every fiscal_lead_scores row for this lead, newest first -- used by the WhatsApp context
   * bridge (fiscal-lead-context.ts) to read the most recent score/bands for a lead. */
  listByLeadId(leadId: string): Promise<FiscalLeadScore[]>;
}
export interface OfferedSlotRepository {
  create(input:Omit<OfferedSlot,"id"|"createdAt">):Promise<OfferedSlot>;
  /**
   * Atomic batch insert: all rows are persisted, or -- on any failure, including a
   * (round_id, position) duplicate -- none are. Backed by a single multi-row Postgres INSERT
   * statement, which is atomic by default (a Postgres statement runs as one implicit
   * transaction; an error anywhere in a multi-row INSERT aborts and rolls back the whole
   * statement, not just the offending row). This is the ONLY method SlotOfferingService.createRound
   * uses to persist a round -- never a loop of individual create() calls -- so a round is never
   * left partially persisted. create() is kept only for other/simpler callers and tests that
   * seed a single row.
   */
  createMany(inputs:Array<Omit<OfferedSlot,"id"|"createdAt">>):Promise<OfferedSlot[]>;
  /**
   * Active (unselected, unexpired) offered_slots for this conversation, scoped by booking
   * context -- undefined (the default) returns ONLY reschedule_context_id IS NULL rows (booking
   * mode); a value returns ONLY rows tagged with that exact reschedule_context_id. Never a mix of
   * both. THIS is the query that decides REUSED vs CREATE-NEW in SlotOfferingService, so an
   * unscoped call here is the single most consequential place a booking-context leak could ever
   * happen -- see the Phase 4C post-mortem: this parameter was originally added ONLY to
   * listRoundIdsByConversationId below (the round-COUNTING query) and omitted here (the
   * round-REUSE query) by mistake, which let a reschedule silently reuse an unselected leftover
   * slot from the conversation's ORIGINAL booking round whenever that round hadn't fully expired
   * yet. Every caller MUST now pass the correct context explicitly (or omit it for booking mode).
   */
  listActiveByConversationId(conversationId:string,now:Date,rescheduleContextId?:string):Promise<OfferedSlot[]>;
  update(id:string,patch:Partial<OfferedSlot>):Promise<OfferedSlot>;
  /**
   * Every distinct round_id offered for this conversation IN THIS BOOKING CONTEXT, across ALL
   * rounds (active, expired, or selected) -- used exclusively for round counting (see
   * MAX_OFFER_ROUNDS in slot-offering-service.ts). Deduplicated by the repository itself: the
   * returned array has one entry per round, never one per offered_slots row. Supabase/PostgREST
   * has no clean way to express `COUNT(DISTINCT round_id)` through the query builder without a
   * custom RPC function, so implementations instead fetch round_id for every matching row and
   * dedupe in application code -- correct (if occasionally fetching a few extra values) rather
   * than a wrong pseudo-aggregate.
   *
   * Phase 4C: `rescheduleContextId` scopes the count so a reschedule's round budget is
   * independent of the conversation's original booking rounds (and vice versa) -- omitted/
   * undefined (the default, unchanged Phase 3C behavior) counts only rounds with
   * reschedule_context_id IS NULL (booking-mode rounds); passing a value counts only rounds
   * tagged with that exact reschedule_context_id. Never a mix of both.
   */
  listRoundIdsByConversationId(conversationId:string,rescheduleContextId?:string):Promise<string[]>;
}
export interface SlotOfferClaimRepository {
  /** Wins outright (INSERT succeeds) or returns null on a PK conflict (conversation_id already
   * claimed) -- never throws for the "lost the race" case, only for genuinely unexpected errors. */
  tryCreate(input:{conversationId:string;ownerToken:string;intendedRoundId:string}):Promise<SlotOfferClaim|null>;
  findByConversationId(conversationId:string):Promise<SlotOfferClaim|null>;
  /**
   * Single-step compare-and-set for reclaiming an abandoned claim: atomically rewrites
   * owner_token/intended_round_id/claimed_at/updated_at ONLY if the row still belongs to
   * `expectedOwnerToken` AND was last touched before `staleBefore`. Because owner_token is part
   * of both the WHERE predicate and the SET clause, two concurrent reclaimers targeting the same
   * stale row cannot both win: Postgres serializes the two UPDATEs via row-level locking, and
   * whichever runs second re-evaluates its WHERE clause against the row the first one already
   * committed -- owner_token no longer matches, so the second returns 0 rows. No transitional
   * status value is needed for this guarantee. Returns null if the claim moved (won by someone
   * else, or turned out fresh) between read and write -- never throws for that case.
   */
  tryReclaim(params:{conversationId:string;expectedOwnerToken:string;newOwnerToken:string;intendedRoundId:string;staleBefore:Date;now:Date}):Promise<SlotOfferClaim|null>;
  /** Owner-safe release: deletes the row ONLY if it still belongs to `ownerToken`. Returns
   * `false` (never an error) when the caller is no longer the owner -- e.g. it was reclaimed as
   * stale while this caller was still working. A `false` result must never be treated as failure
   * to clean up; it means someone else already has (or now owns) this claim. */
  release(conversationId:string,ownerToken:string):Promise<boolean>;
}
// Phase 4A -- lifecycle audit foundation (see docs/PHASE4-DESIGN.md). No handler wires any of
// these into a user-visible flow yet.

export interface LeadStatusHistoryRepository {
  create(input: Omit<LeadStatusHistoryEntry, "id" | "createdAt">): Promise<LeadStatusHistoryEntry>;
  /** Read-only, chronological -- for audit/debugging inspection of one lead's history. Not
   * consumed by any business logic in Phase 4A. */
  listByLeadId(leadId: string): Promise<LeadStatusHistoryEntry[]>;
}

export interface AppointmentStatusHistoryRepository {
  create(input: Omit<AppointmentStatusHistoryEntry, "id" | "createdAt">): Promise<AppointmentStatusHistoryEntry>;
  listByAppointmentId(appointmentId: string): Promise<AppointmentStatusHistoryEntry[]>;
}

export interface AppointmentMessageDeliveryRepository {
  /** Wins outright (INSERT succeeds) or returns null on an idempotency_key conflict -- never
   * throws for the "already scheduled/sent" case, same convention as
   * SlotOfferClaimRepository.tryCreate. No caller exists yet in Phase 4A. */
  tryCreate(input: Omit<AppointmentMessageDelivery, "id" | "createdAt" | "updatedAt" | "attemptCount" | "status"> & { status?: AppointmentMessageDelivery["status"] }): Promise<AppointmentMessageDelivery | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<AppointmentMessageDelivery | null>;
  update(id: string, patch: Partial<AppointmentMessageDelivery>): Promise<AppointmentMessageDelivery>;
}

// Phase 4B -- appointment cancellation (see docs/PHASE4-DESIGN.md, migration
// 014_appointment_cancellations.sql). Tracks Calendar-cleanup completion for a cancellation --
// deliberately not booking_attempts or appointment_message_deliveries (wrong semantics for
// either).
export interface AppointmentCancellationRepository {
  /** Wins outright (INSERT succeeds) or returns null on an idempotency_key conflict -- never
   * throws for the "already tracked" case, same convention as SlotOfferClaimRepository.tryCreate
   * / AppointmentMessageDeliveryRepository.tryCreate. */
  tryCreate(input: Omit<AppointmentCancellation, "id" | "createdAt" | "updatedAt" | "attemptCount" | "status"> & { status?: AppointmentCancellation["status"] }): Promise<AppointmentCancellation | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<AppointmentCancellation | null>;
  update(id: string, patch: Partial<AppointmentCancellation>): Promise<AppointmentCancellation>;
  /** Every appointment_cancellations row for this lead -- read-only administrative tooling only
   * (see scripts/reset-test-lead.ts), same rationale as
   * BookingAttemptRepository.listByLeadId / AppointmentRepository.listAllByLeadId. Not used by
   * any cancellation business logic, which is all keyed by idempotencyKey/appointmentId. */
  listByLeadId(leadId: string): Promise<AppointmentCancellation[]>;
}

// Phase 4C -- appointment reschedule (see docs/PHASE4-DESIGN.md, migration
// 015_appointment_reschedules.sql). Guards "create the new appointment" ownership (Phase A, via
// idempotencyKey uniqueness) AND tracks old-Calendar-event cleanup (Phase B) in one row -- see
// domain/appointment-reschedule.ts's doc comment for why this is one table, not a reuse of
// appointment_cancellations or booking_attempts.
export interface AppointmentRescheduleRepository {
  /** Wins outright (INSERT succeeds) or returns null on an idempotency_key conflict -- never
   * throws for the "already tracked" case, same convention as every other tryCreate here.
   * phaseAStatus defaults to 'PENDING', mirroring booking_attempts.status's default. */
  tryCreate(input: Omit<AppointmentReschedule, "id" | "createdAt" | "updatedAt" | "attemptCount" | "status" | "phaseAStatus" | "newAppointmentId"> & { status?: AppointmentReschedule["status"]; phaseAStatus?: AppointmentReschedule["phaseAStatus"] }): Promise<AppointmentReschedule | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<AppointmentReschedule | null>;
  update(id: string, patch: Partial<AppointmentReschedule>): Promise<AppointmentReschedule>;
  /**
   * Atomic compare-and-set on phaseAStatus ONLY (never Phase B's `status` field) -- transitions
   * row `id` from `expectedStatus` to `nextStatus` ONLY if its current phaseAStatus still matches,
   * and (when `options.updatedBefore` is given) only if updatedAt is older than that cutoff too.
   * Returns the updated row if this call won the race, or null if another request already changed
   * it first -- never throws for the "lost the race" case. Mirrors
   * BookingAttemptRepository.claimTransition's exact contract (including the two-step
   * PENDING -> FAILED -> PENDING stale-reclaim pattern AppointmentRescheduleService uses).
   */
  claimTransition(id: string, expectedStatus: AppointmentReschedule["phaseAStatus"], nextStatus: AppointmentReschedule["phaseAStatus"], options?: { updatedBefore: Date }): Promise<AppointmentReschedule | null>;
  /** Every appointment_reschedules row for this lead -- read-only administrative tooling only
   * (see scripts/reset-test-lead.ts), same rationale as
   * BookingAttemptRepository.listByLeadId / AppointmentRepository.listAllByLeadId. Not used by
   * any reschedule business logic, which is all keyed by idempotencyKey/oldAppointmentId. */
  listByLeadId(leadId: string): Promise<AppointmentReschedule[]>;
}

export interface CalendarSlot{start:Date;end:Date;} export interface CalendarEventInput{title:string;description:string;start:Date;end:Date;attendeeEmail?:string;} export interface CalendarEventResult{eventId:string;meetingUrl?:string;}
export interface CalendarProvider{getAvailableSlots(from:Date,to:Date,durationMinutes:number):Promise<CalendarSlot[]>;isSlotAvailable(start:Date,end:Date):Promise<boolean>;createEvent(input:CalendarEventInput):Promise<CalendarEventResult>;deleteEvent(eventId:string):Promise<void>;}
/**
 * Fase 6F -- HubSpot CRM sync (fiscal calculator -> HubSpot contact). Deliberately minimal: one
 * method, matching CalendarProvider's own single-purpose-port style. `properties` is a flat,
 * already-built HubSpot property map (see domain/hubspot-fiscal-properties.ts) -- this interface
 * has NO knowledge of fiscal/scoring/lead concepts, only "upsert a contact identified by
 * email/phone with these properties", so no HubSpot-specific vocabulary (portal, private app,
 * contact ID shapes) ever needs to leak into application/domain code that depends on it -- same
 * boundary discipline as MessagingProvider's own doc comment.
 */
export interface HubSpotContactUpsertInput {
  /** Normalized email, when known. At least one of email/phone must be present -- callers never
   * invoke this with both absent (see HubSpotFiscalSyncService). */
  email?: string;
  /** E.164 phone, when known. */
  phone?: string;
  firstName?: string;
  lastName?: string;
  /** Native HubSpot default properties, reused rather than shadowed with a custom duplicate --
   * see the Fase 6F report, item 5. */
  city?: string;
  state?: string;
  /** Flat bc_fiscal_* property map, see domain/hubspot-fiscal-properties.ts. */
  properties: Record<string, string | number | boolean>;
}
export interface HubSpotContactUpsertResult {
  hubspotContactId: string;
  /** true when this call created a brand-new HubSpot contact; false when it matched and updated
   * an existing one (by normalized email, then normalized phone -- see the real adapter's doc
   * comment for the exact search order). */
  created: boolean;
}
export interface HubSpotCRMProvider {
  upsertContact(input: HubSpotContactUpsertInput): Promise<HubSpotContactUpsertResult>;
}
export interface AIProvider{generateStructured<T>(systemPrompt:string,messages:Array<{role:"user"|"assistant";content:string}>,schemaName:string):Promise<T>;}
/** Structured warning-level logging, matching pino's `log.warn(details, message)` calling
 * convention so Fastify's `app.log` can be passed directly in production with no adapter. */
export interface Logger{warn(details:Record<string,unknown>,message:string):void;}
export interface SendMessageResult{providerMessageId?:string;}
/** Channel-agnostic messaging port. No Meta/WhatsApp-specific concepts (wa_id, Graph API
 * shapes, template categories, etc.) belong in this interface or in any code that depends on
 * it -- those live only inside MetaWhatsAppProvider. */
export interface MessagingProvider{
  sendText(to:string,body:string):Promise<SendMessageResult>;
  sendTemplate(to:string,templateName:string,languageCode:string,params?:string[]):Promise<SendMessageResult>;
  markRead(providerMessageId:string):Promise<void>;
}
