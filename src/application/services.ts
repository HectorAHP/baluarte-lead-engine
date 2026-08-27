import {createHash} from "node:crypto";
import type { LeadRepository,CalendarProvider,AppointmentRepository,BookingAttemptRepository,LeadScoreRepository,Logger } from "./ports.js";
import type { Vertical,Lead,LeadStatus } from "../domain/lead.js";
import type { Appointment } from "../domain/appointment.js";
import type { BookingAttempt } from "../domain/booking-attempt.js";
import {scorePatrimonial,scoreGmm,LEGACY_MANUAL_SCORING_RULES_VERSION,type PatrimonialScoreInput,type GmmScoreInput,type ScoreClass} from "../domain/scoring.js";
import type {QualificationVertical} from "../domain/qualification-fields.js";
import {assertTransition} from "../domain/state-machine.js";
import {normalizePhoneToE164} from "../domain/phone.js";
import {LeadNotFoundError,SlotUnavailableError,IdempotencyConflictError} from "../domain/errors.js";

function targetStatusForScore(scoreClass:ScoreClass):LeadStatus{return scoreClass==="A"?"QUALIFIED_A":scoreClass==="B"?"QUALIFIED_B":"NURTURE_C";}

export class LeadService{
  constructor(private readonly leads:LeadRepository,private readonly leadScores:LeadScoreRepository){}

  async createLead(input:{firstName?:string;lastName?:string;phone?:string;email?:string;source?:string;sourceDetail?:string;productVertical?:Vertical;productInterest?:string;metaLeadId?:string;whatsappUserId?:string;consentContact?:boolean;}):Promise<Lead>{
    const {phone,consentContact,...rest}=input;
    const phoneE164=normalizePhoneToE164(phone)??undefined;
    return this.leads.create({
      country:"MX",
      ...rest,
      phoneRaw:phone,
      phoneE164,
      consentContact:consentContact??false,
      productVertical:input.productVertical??"UNKNOWN",
      status:"NEW",
      score:0,
      assignedAdvisor:"Hector Herrera",
    });
  }

  private async requireLead(id:string):Promise<Lead>{
    const lead=await this.leads.findById(id);
    if(!lead) throw new LeadNotFoundError(id);
    return lead;
  }

  private async transitionTo(id:string,target:LeadStatus,buildPatch:(lead:Lead)=>Partial<Lead> = ()=>({})):Promise<Lead>{
    const lead=await this.requireLead(id);
    assertTransition(lead.status,target);
    return this.leads.update(id,{...buildPatch(lead),status:target});
  }

  async markContacted(id:string):Promise<Lead>{
    return this.transitionTo(id,"CONTACTED",(lead)=>lead.firstContactAt?{}:{firstContactAt:new Date()});
  }

  async startQualification(id:string):Promise<Lead>{
    return this.transitionTo(id,"QUALIFYING");
  }

  /**
   * Records that a lead responded to us, from any channel. For a brand-new lead (status NEW)
   * this is simultaneously their first contact AND first response -- e.g. a WhatsApp-originated
   * lead's very first inbound message represents both at once, so both timestamps are set
   * together in that case, alongside the NEW -> CONTACTED transition. For a lead that was
   * already contacted through some other channel (e.g. created manually, or via Meta Lead Ads,
   * and Héctor reached out first), this only backfills firstResponseAt if it was never set --
   * their status and firstContactAt are left untouched, since this isn't a new contact event.
   */
  async recordInboundContact(id:string):Promise<Lead>{
    const lead=await this.requireLead(id);
    if(lead.status==="NEW"){
      return this.transitionTo(id,"CONTACTED",(current)=>({
        ...(current.firstContactAt?{}:{firstContactAt:new Date()}),
        ...(current.firstResponseAt?{}:{firstResponseAt:new Date()}),
      }));
    }
    if(!lead.firstResponseAt){
      return this.leads.update(id,{firstResponseAt:new Date()});
    }
    return lead;
  }

  async requestHumanHandoff(id:string):Promise<Lead>{
    return this.transitionTo(id,"HUMAN_HANDOFF");
  }

  async requestDoNotContact(id:string):Promise<Lead>{
    return this.transitionTo(id,"DO_NOT_CONTACT");
  }

  async scorePatrimonialLead(id:string,input:PatrimonialScoreInput):Promise<Lead>{
    const r=scorePatrimonial(input);
    const target=targetStatusForScore(r.scoreClass);
    // qualifiedAt means "became commercially qualified" (see Lead.qualifiedAt), not "finished
    // the questionnaire" -- so it is set only for QUALIFIED_A/QUALIFIED_B, never NURTURE_C.
    const lead=await this.transitionTo(id,target,(current)=>({
      score:r.total,
      scoreClass:r.scoreClass,
      ...(target!=="NURTURE_C"&&!current.qualifiedAt?{qualifiedAt:new Date()}:{}),
    }));
    await this.leadScores.create({leadId:id,vertical:"PATRIMONIAL",total:r.total,scoreClass:r.scoreClass,breakdown:r.breakdown,rulesVersion:LEGACY_MANUAL_SCORING_RULES_VERSION});
    return lead;
  }

  async scoreGmmLead(id:string,input:GmmScoreInput):Promise<Lead>{
    const r=scoreGmm(input);
    const target=targetStatusForScore(r.scoreClass);
    const lead=await this.transitionTo(id,target,(current)=>({
      score:r.total,
      scoreClass:r.scoreClass,
      ...(target!=="NURTURE_C"&&!current.qualifiedAt?{qualifiedAt:new Date()}:{}),
    }));
    await this.leadScores.create({leadId:id,vertical:"GMM",total:r.total,scoreClass:r.scoreClass,breakdown:r.breakdown,rulesVersion:LEGACY_MANUAL_SCORING_RULES_VERSION});
    return lead;
  }

  /**
   * Phase 3B: applies an already-computed conversational-qualifier score (see
   * qualification-scoring.ts) to a lead's lifecycle -- same transition + qualifiedAt semantics
   * as scorePatrimonialLead/scoreGmmLead above, generalized to accept a pre-computed result
   * instead of computing one from the older scoring.ts formula.
   */
  async applyQualificationScore(id:string,input:{vertical:QualificationVertical;total:number;scoreClass:ScoreClass;breakdown:Record<string,number|string>;rulesVersion:string}):Promise<Lead>{
    const target=targetStatusForScore(input.scoreClass);
    const lead=await this.transitionTo(id,target,(current)=>({
      score:input.total,
      scoreClass:input.scoreClass,
      ...(target!=="NURTURE_C"&&!current.qualifiedAt?{qualifiedAt:new Date()}:{}),
    }));
    await this.leadScores.create({leadId:id,vertical:input.vertical,total:input.total,scoreClass:input.scoreClass,breakdown:input.breakdown,rulesVersion:input.rulesVersion});
    return lead;
  }
}

export interface BookInput{leadId:string;title:string;description:string;start:Date;end:Date;attendeeEmail?:string;timezone:string;}

function fingerprintBooking(input:BookInput):string{
  const payload=JSON.stringify({leadId:input.leadId,title:input.title,description:input.description,start:input.start.toISOString(),end:input.end.toISOString(),attendeeEmail:input.attendeeEmail??null});
  return createHash("sha256").update(payload).digest("hex");
}

export class AppointmentService{
  constructor(private readonly calendar:CalendarProvider,private readonly appointments:AppointmentRepository,private readonly bookingAttempts:BookingAttemptRepository,private readonly leads:LeadRepository,private readonly logger:Logger){}

  getAvailability(from:Date,to:Date,durationMinutes=30){
    return this.calendar.getAvailableSlots(from,to,durationMinutes);
  }

  /**
   * Idempotent booking: the same Idempotency-Key + identical payload always returns the same
   * appointment; the same key with a different payload is rejected. See docs/ARCHITECTURE.md
   * for the full idempotency/double-booking design and its known limitations.
   */
  async book(input:BookInput,idempotencyKey:string):Promise<Appointment>{
    const fingerprint=fingerprintBooking(input);
    const existing=await this.bookingAttempts.findByKey(idempotencyKey);
    if(existing){
      if(existing.requestFingerprint!==fingerprint) throw new IdempotencyConflictError(idempotencyKey);
      if(existing.status==="COMPLETED"&&existing.appointmentId){
        const appt=await this.appointments.findById(existing.appointmentId);
        if(appt) return appt;
      }
      return this.completeBooking(existing,input);
    }
    const attempt=await this.bookingAttempts.create({leadId:input.leadId,idempotencyKey,requestFingerprint:fingerprint,status:"PENDING"});
    return this.completeBooking(attempt,input);
  }

  private async completeBooking(attempt:BookingAttempt,input:BookInput):Promise<Appointment>{
    let providerEventId=attempt.providerEventId;
    let meetingUrl=attempt.meetingUrl;

    if(!providerEventId){
      if(!await this.calendar.isSlotAvailable(input.start,input.end)){
        await this.bookingAttempts.update(attempt.id,{status:"FAILED"}).catch(()=>{});
        throw new SlotUnavailableError();
      }
      let event;
      try{
        event=await this.calendar.createEvent(input);
      }catch(err){
        await this.bookingAttempts.update(attempt.id,{status:"FAILED"}).catch(()=>{});
        throw err;
      }
      providerEventId=event.eventId;
      meetingUrl=event.meetingUrl;
      await this.bookingAttempts.update(attempt.id,{providerEventId,meetingUrl});
    }

    let appointment:Appointment;
    try{
      appointment=await this.appointments.create({leadId:input.leadId,status:"BOOKED",startsAt:input.start,endsAt:input.end,timezone:input.timezone,calendarEventId:providerEventId,meetingProvider:"GOOGLE_MEET",meetingUrl});
    }catch(err){
      await this.bookingAttempts.update(attempt.id,{status:"FAILED"}).catch(()=>{});
      await this.calendar.deleteEvent(providerEventId).catch(()=>{});
      throw err;
    }

    await this.bookingAttempts.update(attempt.id,{status:"COMPLETED",appointmentId:appointment.id});
    // The appointment row (just persisted above) is the source of truth for "is this lead
    // booked" -- a failure updating this denormalized convenience timestamp on the lead must
    // NOT roll back or invalidate an already-successful booking. But it must not be silently
    // swallowed either: log a sanitized structured warning (leadId + appointmentId only, never
    // the underlying error's raw payload) so the failure is observable.
    // TODO(reconciliation): no background job exists yet to backfill leads.booked_at for
    // appointments where this write failed. Until one exists, `select a.lead_id, a.id from
    // appointments a join leads l on l.id = a.lead_id where l.booked_at is null` finds them.
    await this.leads.update(input.leadId,{bookedAt:new Date()}).catch((err)=>{
      this.logger.warn(
        {leadId:input.leadId,appointmentId:appointment.id,reason:err instanceof Error?err.message:"unknown"},
        "Failed to record booked_at on lead after a successful appointment booking. The appointment is valid and unaffected; leads.booked_at is stale for this lead until reconciled.",
      );
    });
    return appointment;
  }
}
