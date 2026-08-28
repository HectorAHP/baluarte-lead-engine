import {randomUUID} from "node:crypto";
import type {LeadRepository,AppointmentRepository,BookingAttemptRepository,ConversationRepository,MessageRepository,QualificationAnswerRepository,LeadScoreRepository,OfferedSlotRepository,SlotOfferClaimRepository,LeadStatusHistoryRepository,AppointmentStatusHistoryRepository,AppointmentMessageDeliveryRepository,AppointmentCancellationRepository,AppointmentRescheduleRepository} from "../application/ports.js";
import type {Lead,LeadDedupKey} from "../domain/lead.js";
import type {Appointment,AppointmentStatus} from "../domain/appointment.js";
import type {BookingAttempt,BookingAttemptStatus} from "../domain/booking-attempt.js";
import type {Conversation} from "../domain/conversation.js";
import type {Message} from "../domain/message.js";
import type {QualificationAnswer} from "../domain/qualification-answer.js";
import type {LeadScoreRecord} from "../domain/lead-score-record.js";
import type {OfferedSlot} from "../domain/offered-slot.js";
import type {SlotOfferClaim} from "../domain/slot-offer-claim.js";
import type {LeadStatusHistoryEntry} from "../domain/lead-status-history.js";
import type {AppointmentStatusHistoryEntry} from "../domain/appointment-status-history.js";
import type {AppointmentMessageDelivery} from "../domain/appointment-message-delivery.js";
import type {AppointmentCancellation} from "../domain/appointment-cancellation.js";
import type {AppointmentReschedule} from "../domain/appointment-reschedule.js";
import {SlotUnavailableError,DuplicateMessageError,BookingAttemptKeyConflictError} from "../domain/errors.js";
import {messageDedupKey} from "../domain/message-dedup-key.js";

export class InMemoryLeadRepository implements LeadRepository{
  private data=new Map<string,Lead>();
  async create(input:Omit<Lead,"id"|"createdAt"|"updatedAt">){const now=new Date();const lead={...input,id:randomUUID(),createdAt:now,updatedAt:now};this.data.set(lead.id,lead);return lead;}
  async findById(id:string){return this.data.get(id)??null;}
  async update(id:string,patch:Partial<Lead>){const c=this.data.get(id);if(!c)throw new Error("LEAD_NOT_FOUND");const n={...c,...patch,id,updatedAt:new Date()};this.data.set(id,n);return n;}
  async findByDedupKey(key:LeadDedupKey):Promise<Lead|null>{
    const all=[...this.data.values()];
    if(key.metaLeadId){const m=all.find(l=>l.metaLeadId===key.metaLeadId);if(m)return m;}
    if(key.whatsappUserId){const m=all.find(l=>l.whatsappUserId===key.whatsappUserId);if(m)return m;}
    if(key.phoneE164){const m=all.find(l=>l.phoneE164===key.phoneE164);if(m)return m;}
    if(key.email){const normalized=key.email.toLowerCase();const m=all.find(l=>l.email?.toLowerCase()===normalized);if(m)return m;}
    return null;
  }
}

export class InMemoryAppointmentRepository implements AppointmentRepository{
  private data=new Map<string,Appointment>();
  async create(input:Omit<Appointment,"id">){
    const overlaps=[...this.data.values()].some(a=>a.status!=="CANCELLED"&&input.startsAt<a.endsAt&&input.endsAt>a.startsAt);
    if(overlaps) throw new SlotUnavailableError();
    const a={...input,id:randomUUID()};
    this.data.set(a.id,a);
    return a;
  }
  async findById(id:string){return this.data.get(id)??null;}
  async update(id:string,patch:Partial<Appointment>){const c=this.data.get(id);if(!c)throw new Error("APPOINTMENT_NOT_FOUND");const n={...c,...patch,id};this.data.set(id,n);return n;}
  async findActiveByLeadId(leadId:string):Promise<Appointment|null>{
    // Map iteration order is insertion order, so the last match is the most recently created --
    // no separate createdAt field needed on the domain type for this in-memory implementation.
    const matches=[...this.data.values()].filter(a=>a.leadId===leadId&&a.status==="BOOKED");
    return matches.length>0?matches[matches.length-1]:null;
  }
  async listActiveByLeadId(leadId:string):Promise<Appointment[]>{
    return [...this.data.values()].filter(a=>a.leadId===leadId&&a.status==="BOOKED");
  }
  async findMostRecentByLeadId(leadId:string):Promise<Appointment|null>{
    // Map iteration order is insertion order -- same "last match = most recent" reasoning as
    // findActiveByLeadId above, just without the status filter.
    const matches=[...this.data.values()].filter(a=>a.leadId===leadId);
    return matches.length>0?matches[matches.length-1]:null;
  }
  async claimTransition(id:string,expectedStatus:AppointmentStatus,nextStatus:AppointmentStatus):Promise<Appointment|null>{
    const current=this.data.get(id);
    if(!current) return null;
    if(current.status!==expectedStatus) return null;
    const claimed={...current,status:nextStatus};
    this.data.set(id,claimed);
    return claimed;
  }
}

/**
 * Mirrors SupabaseBookingAttemptRepository's ownership contract exactly (same errors, same
 * claimTransition compare-and-set semantics) so tests exercise the same behavior the real
 * repository provides. Every method here runs with no `await` before its Map mutation, so two
 * "concurrent" calls issued via Promise.all() never interleave mid-check -- each completes
 * atomically before the next one's body runs, the same mutual-exclusion guarantee Postgres row
 * locking gives claimTransition's WHERE clause in production.
 */
export class InMemoryBookingAttemptRepository implements BookingAttemptRepository{
  private data=new Map<string,BookingAttempt>();
  private byKey=new Map<string,string>();
  async findByKey(idempotencyKey:string){
    const id=this.byKey.get(idempotencyKey);
    return id?this.data.get(id)??null:null;
  }
  async create(input:Omit<BookingAttempt,"id"|"createdAt"|"updatedAt">){
    if(this.byKey.has(input.idempotencyKey)) throw new BookingAttemptKeyConflictError(input.idempotencyKey);
    const now=new Date();
    const attempt={...input,id:randomUUID(),createdAt:now,updatedAt:now};
    this.data.set(attempt.id,attempt);
    this.byKey.set(input.idempotencyKey,attempt.id);
    return attempt;
  }
  async update(id:string,patch:Partial<BookingAttempt>){
    const c=this.data.get(id);
    if(!c)throw new Error("BOOKING_ATTEMPT_NOT_FOUND");
    const n={...c,...patch,id,updatedAt:new Date()};
    this.data.set(id,n);
    return n;
  }
  async claimTransition(id:string,expectedStatus:BookingAttemptStatus,nextStatus:BookingAttemptStatus,options?:{updatedBefore:Date}){
    const current=this.data.get(id);
    if(!current) return null;
    if(current.status!==expectedStatus) return null;
    if(options?.updatedBefore && !(current.updatedAt<options.updatedBefore)) return null;
    const claimed={...current,status:nextStatus,updatedAt:new Date()};
    this.data.set(id,claimed);
    return claimed;
  }
  async listByLeadId(leadId:string){
    return [...this.data.values()].filter(a=>a.leadId===leadId);
  }
}

export class InMemoryConversationRepository implements ConversationRepository{
  private data=new Map<string,Conversation>();
  async create(input:Omit<Conversation,"id"|"createdAt"|"updatedAt">){
    const now=new Date();
    const c={...input,id:randomUUID(),createdAt:now,updatedAt:now};
    this.data.set(c.id,c);
    return c;
  }
  async findById(id:string){return this.data.get(id)??null;}
  async findActiveByLeadId(leadId:string){
    return [...this.data.values()].find(c=>c.leadId===leadId&&c.status==="ACTIVE")??null;
  }
  async update(id:string,patch:Partial<Conversation>){
    const c=this.data.get(id);
    if(!c)throw new Error("CONVERSATION_NOT_FOUND");
    const n={...c,...patch,id,updatedAt:new Date()};
    this.data.set(id,n);
    return n;
  }
}

export class InMemoryMessageRepository implements MessageRepository{
  private data=new Map<string,Message>();
  // Composite key: provider message IDs are only guaranteed unique within their own channel.
  private byChannelAndProviderMessageId=new Map<string,string>();
  async create(input:Omit<Message,"id"|"createdAt">){
    if(input.providerMessageId){
      const key=messageDedupKey(input.channel,input.providerMessageId);
      if(this.byChannelAndProviderMessageId.has(key)) throw new DuplicateMessageError(input.channel,input.providerMessageId);
    }
    const m={...input,id:randomUUID(),createdAt:new Date()};
    this.data.set(m.id,m);
    if(input.providerMessageId) this.byChannelAndProviderMessageId.set(messageDedupKey(input.channel,input.providerMessageId),m.id);
    return m;
  }
  async findByProviderMessageId(channel:Message["channel"],providerMessageId:string){
    const id=this.byChannelAndProviderMessageId.get(messageDedupKey(channel,providerMessageId));
    return id?this.data.get(id)??null:null;
  }
  async listByConversationId(conversationId:string){
    return [...this.data.values()].filter(m=>m.conversationId===conversationId).sort((a,b)=>a.createdAt.getTime()-b.createdAt.getTime());
  }
}

export class InMemoryQualificationAnswerRepository implements QualificationAnswerRepository{
  private data:QualificationAnswer[]=[];
  async create(input:Omit<QualificationAnswer,"id"|"createdAt">){
    const a={...input,id:randomUUID(),createdAt:new Date()};
    this.data.push(a);
    return a;
  }
  async listByLeadId(leadId:string){
    return this.data.filter(a=>a.leadId===leadId).sort((a,b)=>a.createdAt.getTime()-b.createdAt.getTime());
  }
}

export class InMemoryLeadScoreRepository implements LeadScoreRepository{
  private data:LeadScoreRecord[]=[];
  async create(input:Omit<LeadScoreRecord,"id"|"createdAt">){
    const r={...input,id:randomUUID(),createdAt:new Date()};
    this.data.push(r);
    return r;
  }
  async listByLeadId(leadId:string){
    return this.data.filter(r=>r.leadId===leadId).sort((a,b)=>a.createdAt.getTime()-b.createdAt.getTime());
  }
}

export class InMemoryOfferedSlotRepository implements OfferedSlotRepository{
  private data=new Map<string,OfferedSlot>();
  // Mirrors migration 010's `unique (round_id, position)` constraint, so tests exercise the same
  // "duplicate position within a round is rejected" behavior the real database enforces.
  private roundPositionKeys=new Set<string>();

  async create(input:Omit<OfferedSlot,"id"|"createdAt">){
    const key=`${input.roundId}:${input.position}`;
    if(this.roundPositionKeys.has(key)) throw new Error(`OFFERED_SLOT_DUPLICATE_ROUND_POSITION: ${key}`);
    const s={...input,id:randomUUID(),createdAt:new Date()};
    this.data.set(s.id,s);
    this.roundPositionKeys.add(key);
    return s;
  }

  /**
   * All rows or none -- mirrors a single multi-row Postgres INSERT's atomicity. Validates the
   * ENTIRE batch (including (roundId, position) duplicates, both against already-persisted rows
   * and within the batch itself) before writing anything; only then commits every row.
   */
  async createMany(inputs:Array<Omit<OfferedSlot,"id"|"createdAt">>):Promise<OfferedSlot[]>{
    const keys=inputs.map((input)=>`${input.roundId}:${input.position}`);
    const seenInBatch=new Set<string>();
    for(const key of keys){
      if(this.roundPositionKeys.has(key)||seenInBatch.has(key)){
        throw new Error(`OFFERED_SLOT_DUPLICATE_ROUND_POSITION: ${key}`);
      }
      seenInBatch.add(key);
    }
    const now=new Date();
    const rows=inputs.map((input)=>({...input,id:randomUUID(),createdAt:now}));
    for(let i=0;i<rows.length;i++){
      this.data.set(rows[i].id,rows[i]);
      this.roundPositionKeys.add(keys[i]);
    }
    return rows;
  }

  async listActiveByConversationId(conversationId:string,now:Date,rescheduleContextId?:string){
    return [...this.data.values()]
      .filter(s=>s.conversationId===conversationId&&!s.selected&&s.expiresAt>now&&s.rescheduleContextId===rescheduleContextId)
      .sort((a,b)=>a.position-b.position);
  }

  async listRoundIdsByConversationId(conversationId:string,rescheduleContextId?:string):Promise<string[]>{
    const ids=new Set<string>();
    for(const s of this.data.values()){
      if(s.conversationId===conversationId && s.rescheduleContextId===rescheduleContextId) ids.add(s.roundId);
    }
    return [...ids];
  }

  async update(id:string,patch:Partial<OfferedSlot>){
    const c=this.data.get(id);
    if(!c)throw new Error("OFFERED_SLOT_NOT_FOUND");
    const n={...c,...patch,id};
    this.data.set(id,n);
    return n;
  }
}

/**
 * Shared backing state for InMemorySlotOfferClaimRepository -- exists as its own object
 * (separate from the repository class) so tests simulating "two app instances hitting the same
 * Postgres table" can construct two InMemorySlotOfferClaimRepository wrappers around ONE shared
 * store, rather than two independent in-memory tables that would trivially never conflict. A
 * repository built with no store argument gets its own private one (the normal single-instance
 * case, same convention as every other InMemory* repository in this file).
 */
export class InMemorySlotOfferClaimStore {
  data=new Map<string,SlotOfferClaim>();
}

/**
 * Mirrors SupabaseSlotOfferClaimRepository's exact contract: tryCreate/tryReclaim never throw
 * for "lost the race" (return null), release never throws for "no longer the owner" (return
 * false). Every method runs with no `await` before its Map mutation -- same reasoning as
 * InMemoryBookingAttemptRepository -- so concurrent calls issued via Promise.all() never
 * interleave mid-check.
 */
export class InMemorySlotOfferClaimRepository implements SlotOfferClaimRepository{
  constructor(private readonly store:InMemorySlotOfferClaimStore=new InMemorySlotOfferClaimStore()){}

  async tryCreate(input:{conversationId:string;ownerToken:string;intendedRoundId:string}):Promise<SlotOfferClaim|null>{
    if(this.store.data.has(input.conversationId)) return null;
    const now=new Date();
    const claim:SlotOfferClaim={conversationId:input.conversationId,ownerToken:input.ownerToken,intendedRoundId:input.intendedRoundId,claimedAt:now,updatedAt:now};
    this.store.data.set(input.conversationId,claim);
    return claim;
  }

  async findByConversationId(conversationId:string):Promise<SlotOfferClaim|null>{
    return this.store.data.get(conversationId)??null;
  }

  async tryReclaim(params:{conversationId:string;expectedOwnerToken:string;newOwnerToken:string;intendedRoundId:string;staleBefore:Date;now:Date}):Promise<SlotOfferClaim|null>{
    const current=this.store.data.get(params.conversationId);
    if(!current) return null;
    if(current.ownerToken!==params.expectedOwnerToken) return null;
    if(!(current.updatedAt<params.staleBefore)) return null;
    const reclaimed:SlotOfferClaim={conversationId:params.conversationId,ownerToken:params.newOwnerToken,intendedRoundId:params.intendedRoundId,claimedAt:params.now,updatedAt:params.now};
    this.store.data.set(params.conversationId,reclaimed);
    return reclaimed;
  }

  async release(conversationId:string,ownerToken:string):Promise<boolean>{
    const current=this.store.data.get(conversationId);
    if(!current||current.ownerToken!==ownerToken) return false;
    this.store.data.delete(conversationId);
    return true;
  }
}

// -------------------------------------------------------------------------------------------
// Phase 4A -- lifecycle audit foundation (see docs/PHASE4-DESIGN.md). Not wired into any
// user-visible flow yet.
// -------------------------------------------------------------------------------------------

export class InMemoryLeadStatusHistoryRepository implements LeadStatusHistoryRepository{
  private data:LeadStatusHistoryEntry[]=[];
  async create(input:Omit<LeadStatusHistoryEntry,"id"|"createdAt">){
    const row={...input,id:randomUUID(),createdAt:new Date()};
    this.data.push(row);
    return row;
  }
  async listByLeadId(leadId:string){
    return this.data.filter(r=>r.leadId===leadId).sort((a,b)=>a.createdAt.getTime()-b.createdAt.getTime());
  }
}

export class InMemoryAppointmentStatusHistoryRepository implements AppointmentStatusHistoryRepository{
  private data:AppointmentStatusHistoryEntry[]=[];
  async create(input:Omit<AppointmentStatusHistoryEntry,"id"|"createdAt">){
    const row={...input,id:randomUUID(),createdAt:new Date()};
    this.data.push(row);
    return row;
  }
  async listByAppointmentId(appointmentId:string){
    return this.data.filter(r=>r.appointmentId===appointmentId).sort((a,b)=>a.createdAt.getTime()-b.createdAt.getTime());
  }
}

/**
 * Mirrors the real table's `unique (idempotency_key)` constraint, so tests exercise the same
 * "two equivalent deliveries for the same appointment can never coexist" guarantee the database
 * enforces. No `await` before any Map mutation -- same reasoning as
 * InMemoryBookingAttemptRepository/InMemorySlotOfferClaimRepository.
 */
export class InMemoryAppointmentMessageDeliveryRepository implements AppointmentMessageDeliveryRepository{
  private data=new Map<string,AppointmentMessageDelivery>();
  private byIdempotencyKey=new Map<string,string>();

  async tryCreate(input:Omit<AppointmentMessageDelivery,"id"|"createdAt"|"updatedAt"|"attemptCount"|"status">&{status?:AppointmentMessageDelivery["status"]}):Promise<AppointmentMessageDelivery|null>{
    if(this.byIdempotencyKey.has(input.idempotencyKey)) return null;
    const now=new Date();
    const row:AppointmentMessageDelivery={...input,status:input.status??"PENDING",attemptCount:0,id:randomUUID(),createdAt:now,updatedAt:now};
    this.data.set(row.id,row);
    this.byIdempotencyKey.set(input.idempotencyKey,row.id);
    return row;
  }

  async findByIdempotencyKey(idempotencyKey:string):Promise<AppointmentMessageDelivery|null>{
    const id=this.byIdempotencyKey.get(idempotencyKey);
    return id?this.data.get(id)??null:null;
  }

  async update(id:string,patch:Partial<AppointmentMessageDelivery>):Promise<AppointmentMessageDelivery>{
    const c=this.data.get(id);
    if(!c)throw new Error("APPOINTMENT_MESSAGE_DELIVERY_NOT_FOUND");
    const n={...c,...patch,id,updatedAt:new Date()};
    this.data.set(id,n);
    return n;
  }
}

// -------------------------------------------------------------------------------------------
// Phase 4B -- appointment cancellation (see docs/PHASE4-DESIGN.md, migration
// 014_appointment_cancellations.sql).
// -------------------------------------------------------------------------------------------

/** Mirrors the real table's `unique (idempotency_key)` constraint, same pattern as
 * InMemoryAppointmentMessageDeliveryRepository. */
export class InMemoryAppointmentCancellationRepository implements AppointmentCancellationRepository{
  private data=new Map<string,AppointmentCancellation>();
  private byIdempotencyKey=new Map<string,string>();

  async tryCreate(input:Omit<AppointmentCancellation,"id"|"createdAt"|"updatedAt"|"attemptCount"|"status">&{status?:AppointmentCancellation["status"]}):Promise<AppointmentCancellation|null>{
    if(this.byIdempotencyKey.has(input.idempotencyKey)) return null;
    const now=new Date();
    const row:AppointmentCancellation={...input,status:input.status??"PENDING",attemptCount:0,id:randomUUID(),createdAt:now,updatedAt:now};
    this.data.set(row.id,row);
    this.byIdempotencyKey.set(input.idempotencyKey,row.id);
    return row;
  }

  async findByIdempotencyKey(idempotencyKey:string):Promise<AppointmentCancellation|null>{
    const id=this.byIdempotencyKey.get(idempotencyKey);
    return id?this.data.get(id)??null:null;
  }

  async update(id:string,patch:Partial<AppointmentCancellation>):Promise<AppointmentCancellation>{
    const c=this.data.get(id);
    if(!c)throw new Error("APPOINTMENT_CANCELLATION_NOT_FOUND");
    const n={...c,...patch,id,updatedAt:new Date()};
    this.data.set(id,n);
    return n;
  }
}

// -------------------------------------------------------------------------------------------
// Phase 4C -- appointment reschedule (see docs/PHASE4-DESIGN.md, migration
// 015_appointment_reschedules.sql).
// -------------------------------------------------------------------------------------------

/** Mirrors the real table's `unique (idempotency_key)` constraint, same pattern as
 * InMemoryAppointmentCancellationRepository. */
export class InMemoryAppointmentRescheduleRepository implements AppointmentRescheduleRepository{
  private data=new Map<string,AppointmentReschedule>();
  private byIdempotencyKey=new Map<string,string>();

  async tryCreate(input:Omit<AppointmentReschedule,"id"|"createdAt"|"updatedAt"|"attemptCount"|"status"|"phaseAStatus"|"newAppointmentId">&{status?:AppointmentReschedule["status"];phaseAStatus?:AppointmentReschedule["phaseAStatus"]}):Promise<AppointmentReschedule|null>{
    if(this.byIdempotencyKey.has(input.idempotencyKey)) return null;
    const now=new Date();
    const row:AppointmentReschedule={...input,status:input.status??"PENDING",phaseAStatus:input.phaseAStatus??"PENDING",attemptCount:0,id:randomUUID(),createdAt:now,updatedAt:now};
    this.data.set(row.id,row);
    this.byIdempotencyKey.set(input.idempotencyKey,row.id);
    return row;
  }

  async findByIdempotencyKey(idempotencyKey:string):Promise<AppointmentReschedule|null>{
    const id=this.byIdempotencyKey.get(idempotencyKey);
    return id?this.data.get(id)??null:null;
  }

  async update(id:string,patch:Partial<AppointmentReschedule>):Promise<AppointmentReschedule>{
    const c=this.data.get(id);
    if(!c)throw new Error("APPOINTMENT_RESCHEDULE_NOT_FOUND");
    const n={...c,...patch,id,updatedAt:new Date()};
    this.data.set(id,n);
    return n;
  }

  /** Mirrors InMemoryBookingAttemptRepository.claimTransition exactly -- no `await` before the
   * Map mutation, so concurrent Promise.all() calls never interleave mid-check. */
  async claimTransition(id:string,expectedStatus:AppointmentReschedule["phaseAStatus"],nextStatus:AppointmentReschedule["phaseAStatus"],options?:{updatedBefore:Date}):Promise<AppointmentReschedule|null>{
    const current=this.data.get(id);
    if(!current) return null;
    if(current.phaseAStatus!==expectedStatus) return null;
    if(options?.updatedBefore && !(current.updatedAt<options.updatedBefore)) return null;
    const claimed={...current,phaseAStatus:nextStatus,updatedAt:new Date()};
    this.data.set(id,claimed);
    return claimed;
  }
}
