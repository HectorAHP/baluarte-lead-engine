import type { Lead, LeadDedupKey } from "../domain/lead.js"; import type { Appointment } from "../domain/appointment.js"; import type { BookingAttempt } from "../domain/booking-attempt.js"; import type { Conversation } from "../domain/conversation.js"; import type { Message } from "../domain/message.js"; import type { QualificationAnswer } from "../domain/qualification-answer.js"; import type { LeadScoreRecord } from "../domain/lead-score-record.js"; import type { OfferedSlot } from "../domain/offered-slot.js";
export interface LeadRepository { create(input:Omit<Lead,"id"|"createdAt"|"updatedAt">):Promise<Lead>; findById(id:string):Promise<Lead|null>; update(id:string,patch:Partial<Lead>):Promise<Lead>; findByDedupKey(key:LeadDedupKey):Promise<Lead|null>; }
export interface AppointmentRepository { create(input:Omit<Appointment,"id">):Promise<Appointment>; findById(id:string):Promise<Appointment|null>; update(id:string,patch:Partial<Appointment>):Promise<Appointment>; }
export interface BookingAttemptRepository { findByKey(idempotencyKey:string):Promise<BookingAttempt|null>; create(input:Omit<BookingAttempt,"id"|"createdAt">):Promise<BookingAttempt>; update(id:string,patch:Partial<BookingAttempt>):Promise<BookingAttempt>; }
export interface ConversationRepository { create(input:Omit<Conversation,"id"|"createdAt"|"updatedAt">):Promise<Conversation>; findById(id:string):Promise<Conversation|null>; findActiveByLeadId(leadId:string):Promise<Conversation|null>; update(id:string,patch:Partial<Conversation>):Promise<Conversation>; }
export interface MessageRepository { create(input:Omit<Message,"id"|"createdAt">):Promise<Message>; findByProviderMessageId(channel:Message["channel"],providerMessageId:string):Promise<Message|null>; listByConversationId(conversationId:string):Promise<Message[]>; }
export interface QualificationAnswerRepository { create(input:Omit<QualificationAnswer,"id"|"createdAt">):Promise<QualificationAnswer>; listByLeadId(leadId:string):Promise<QualificationAnswer[]>; }
export interface LeadScoreRepository { create(input:Omit<LeadScoreRecord,"id"|"createdAt">):Promise<LeadScoreRecord>; listByLeadId(leadId:string):Promise<LeadScoreRecord[]>; }
export interface OfferedSlotRepository { create(input:Omit<OfferedSlot,"id"|"createdAt">):Promise<OfferedSlot>; listActiveByConversationId(conversationId:string,now:Date):Promise<OfferedSlot[]>; update(id:string,patch:Partial<OfferedSlot>):Promise<OfferedSlot>; }
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
