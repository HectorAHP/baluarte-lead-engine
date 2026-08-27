import {randomUUID} from "node:crypto";
import type {LeadRepository,AppointmentRepository,BookingAttemptRepository,ConversationRepository,MessageRepository,QualificationAnswerRepository,LeadScoreRepository,OfferedSlotRepository} from "../application/ports.js";
import type {Lead,LeadDedupKey} from "../domain/lead.js";
import type {Appointment} from "../domain/appointment.js";
import type {BookingAttempt} from "../domain/booking-attempt.js";
import type {Conversation} from "../domain/conversation.js";
import type {Message} from "../domain/message.js";
import type {QualificationAnswer} from "../domain/qualification-answer.js";
import type {LeadScoreRecord} from "../domain/lead-score-record.js";
import type {OfferedSlot} from "../domain/offered-slot.js";
import {SlotUnavailableError,DuplicateMessageError} from "../domain/errors.js";
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
}

export class InMemoryBookingAttemptRepository implements BookingAttemptRepository{
  private data=new Map<string,BookingAttempt>();
  private byKey=new Map<string,string>();
  async findByKey(idempotencyKey:string){
    const id=this.byKey.get(idempotencyKey);
    return id?this.data.get(id)??null:null;
  }
  async create(input:Omit<BookingAttempt,"id"|"createdAt">){
    if(this.byKey.has(input.idempotencyKey)) throw new Error("IDEMPOTENCY_KEY_ALREADY_EXISTS");
    const attempt={...input,id:randomUUID(),createdAt:new Date()};
    this.data.set(attempt.id,attempt);
    this.byKey.set(input.idempotencyKey,attempt.id);
    return attempt;
  }
  async update(id:string,patch:Partial<BookingAttempt>){
    const c=this.data.get(id);
    if(!c)throw new Error("BOOKING_ATTEMPT_NOT_FOUND");
    const n={...c,...patch,id};
    this.data.set(id,n);
    return n;
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
  async create(input:Omit<OfferedSlot,"id"|"createdAt">){
    const s={...input,id:randomUUID(),createdAt:new Date()};
    this.data.set(s.id,s);
    return s;
  }
  async listActiveByConversationId(conversationId:string,now:Date){
    return [...this.data.values()]
      .filter(s=>s.conversationId===conversationId&&!s.selected&&s.expiresAt>now)
      .sort((a,b)=>a.position-b.position);
  }
  async update(id:string,patch:Partial<OfferedSlot>){
    const c=this.data.get(id);
    if(!c)throw new Error("OFFERED_SLOT_NOT_FOUND");
    const n={...c,...patch,id};
    this.data.set(id,n);
    return n;
  }
}
