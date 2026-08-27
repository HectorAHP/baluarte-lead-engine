import type { Lead, LeadDedupKey } from "../domain/lead.js"; import type { Appointment } from "../domain/appointment.js"; import type { BookingAttempt, BookingAttemptStatus } from "../domain/booking-attempt.js"; import type { Conversation } from "../domain/conversation.js"; import type { Message } from "../domain/message.js"; import type { QualificationAnswer } from "../domain/qualification-answer.js"; import type { LeadScoreRecord } from "../domain/lead-score-record.js"; import type { OfferedSlot } from "../domain/offered-slot.js"; import type { SlotOfferClaim } from "../domain/slot-offer-claim.js";
export interface LeadRepository { create(input:Omit<Lead,"id"|"createdAt"|"updatedAt">):Promise<Lead>; findById(id:string):Promise<Lead|null>; update(id:string,patch:Partial<Lead>):Promise<Lead>; findByDedupKey(key:LeadDedupKey):Promise<Lead|null>; }
export interface AppointmentRepository {
  create(input:Omit<Appointment,"id">):Promise<Appointment>;
  findById(id:string):Promise<Appointment|null>;
  update(id:string,patch:Partial<Appointment>):Promise<Appointment>;
  /** The lead's most recent appointment with status "BOOKED" -- CANCELLED and any other status
   * never count as "active". Returns null (never throws) when none exists. */
  findActiveByLeadId(leadId:string):Promise<Appointment|null>;
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
  listActiveByConversationId(conversationId:string,now:Date):Promise<OfferedSlot[]>;
  update(id:string,patch:Partial<OfferedSlot>):Promise<OfferedSlot>;
  /**
   * Every distinct round_id offered for this conversation, across ALL rounds (active, expired,
   * or selected) -- used exclusively for round counting (see MAX_OFFER_ROUNDS in
   * slot-offering-service.ts). Deduplicated by the repository itself: the returned array has one
   * entry per round, never one per offered_slots row. Supabase/PostgREST has no clean way to
   * express `COUNT(DISTINCT round_id)` through the query builder without a custom RPC function,
   * so implementations instead fetch round_id for every matching row and dedupe in application
   * code -- correct (if occasionally fetching a few extra values) rather than a wrong
   * pseudo-aggregate.
   */
  listRoundIdsByConversationId(conversationId:string):Promise<string[]>;
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
export interface CalendarSlot{start:Date;end:Date;} export interface CalendarEventInput{title:string;description:string;start:Date;end:Date;attendeeEmail?:string;} export interface CalendarEventResult{eventId:string;meetingUrl?:string;}
export interface CalendarProvider{getAvailableSlots(from:Date,to:Date,durationMinutes:number):Promise<CalendarSlot[]>;isSlotAvailable(start:Date,end:Date):Promise<boolean>;createEvent(input:CalendarEventInput):Promise<CalendarEventResult>;deleteEvent(eventId:string):Promise<void>;}
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
