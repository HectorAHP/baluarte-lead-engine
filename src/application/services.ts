import {createHash} from "node:crypto";
import type { LeadRepository,CalendarProvider,AppointmentRepository,BookingAttemptRepository,LeadScoreRepository,LeadStatusHistoryRepository,Logger } from "./ports.js";
import type { Vertical,Lead,LeadStatus } from "../domain/lead.js";
import type { Appointment } from "../domain/appointment.js";
import type { BookingAttempt } from "../domain/booking-attempt.js";
import {scorePatrimonial,scoreGmm,LEGACY_MANUAL_SCORING_RULES_VERSION,type PatrimonialScoreInput,type GmmScoreInput,type ScoreClass} from "../domain/scoring.js";
import type {QualificationVertical} from "../domain/qualification-fields.js";
import {assertTransition} from "../domain/state-machine.js";
import {normalizePhoneToE164} from "../domain/phone.js";
import {LeadNotFoundError,SlotUnavailableError,IdempotencyConflictError,BookingAttemptKeyConflictError,BookingInProgressError,BookingAttemptInconsistentError} from "../domain/errors.js";
import {recordLeadStatusTransition} from "./lead-status-audit.js";

function targetStatusForScore(scoreClass:ScoreClass):LeadStatus{return scoreClass==="A"?"QUALIFIED_A":scoreClass==="B"?"QUALIFIED_B":"NURTURE_C";}

export class LeadService{
  constructor(
    private readonly leads:LeadRepository,
    private readonly leadScores:LeadScoreRepository,
    private readonly leadStatusHistory:LeadStatusHistoryRepository,
    private readonly logger:Logger,
  ){}

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

  /**
   * The single choke point for every state-machine-validated leads.status write in this class.
   * Phase 4A: after the real write succeeds, records exactly one lead_status_history row via the
   * shared recordLeadStatusTransition helper (never duplicated per public method below) --
   * best-effort, never affects the transition itself if the audit write fails (see that helper's
   * doc comment).
   */
  private async transitionTo(id:string,target:LeadStatus,eventType:string,buildPatch:(lead:Lead)=>Partial<Lead> = ()=>({})):Promise<Lead>{
    const lead=await this.requireLead(id);
    assertTransition(lead.status,target);
    const updated=await this.leads.update(id,{...buildPatch(lead),status:target});
    await recordLeadStatusTransition(this.leadStatusHistory,this.logger,{leadId:id,fromStatus:lead.status,toStatus:target,eventType});
    return updated;
  }

  async markContacted(id:string):Promise<Lead>{
    return this.transitionTo(id,"CONTACTED","LEAD_CONTACTED",(lead)=>lead.firstContactAt?{}:{firstContactAt:new Date()});
  }

  async startQualification(id:string):Promise<Lead>{
    return this.transitionTo(id,"QUALIFYING","QUALIFICATION_STARTED");
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
      return this.transitionTo(id,"CONTACTED","LEAD_CONTACTED",(current)=>({
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
    return this.transitionTo(id,"HUMAN_HANDOFF","HUMAN_HANDOFF_REQUESTED");
  }

  async requestDoNotContact(id:string):Promise<Lead>{
    return this.transitionTo(id,"DO_NOT_CONTACT","DO_NOT_CONTACT_REQUESTED");
  }

  async scorePatrimonialLead(id:string,input:PatrimonialScoreInput):Promise<Lead>{
    const r=scorePatrimonial(input);
    const target=targetStatusForScore(r.scoreClass);
    // qualifiedAt means "became commercially qualified" (see Lead.qualifiedAt), not "finished
    // the questionnaire" -- so it is set only for QUALIFIED_A/QUALIFIED_B, never NURTURE_C.
    const lead=await this.transitionTo(id,target,"QUALIFICATION_SCORED",(current)=>({
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
    const lead=await this.transitionTo(id,target,"QUALIFICATION_SCORED",(current)=>({
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
    const lead=await this.transitionTo(id,target,"QUALIFICATION_SCORED",(current)=>({
      score:input.total,
      scoreClass:input.scoreClass,
      ...(target!=="NURTURE_C"&&!current.qualifiedAt?{qualifiedAt:new Date()}:{}),
    }));
    await this.leadScores.create({leadId:id,vertical:input.vertical,total:input.total,scoreClass:input.scoreClass,breakdown:input.breakdown,rulesVersion:input.rulesVersion});
    return lead;
  }
}

export interface BookInput{leadId:string;title:string;description:string;start:Date;end:Date;attendeeEmail?:string;timezone:string;}

/** Exported for tests only, so ownership/concurrency tests can pre-seed a booking_attempts row
 * with a fingerprint that matches what book() itself would compute for a given input. */
export function fingerprintBooking(input:BookInput):string{
  const payload=JSON.stringify({leadId:input.leadId,title:input.title,description:input.description,start:input.start.toISOString(),end:input.end.toISOString(),attendeeEmail:input.attendeeEmail??null});
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * How long a PENDING booking_attempts row can sit untouched before it's treated as abandoned
 * (the owning process died before reaching COMPLETED or FAILED) rather than genuinely in
 * progress. A full completeBooking cycle (Google freebusy/insert + Supabase insert) normally
 * finishes in low single-digit seconds; 2 minutes is a generous multiple of that to rule out
 * ordinary latency/GC pauses as false positives, while staying far shorter than an offered
 * slot's own validity window (so stale-booking recovery kicks in long before a user would need
 * to wait for a whole new round of offered slots).
 */
export const PENDING_STALE_THRESHOLD_MS = 2 * 60 * 1000;

export class AppointmentService{
  constructor(private readonly calendar:CalendarProvider,private readonly appointments:AppointmentRepository,private readonly bookingAttempts:BookingAttemptRepository,private readonly leads:LeadRepository,private readonly logger:Logger){}

  getAvailability(from:Date,to:Date,durationMinutes=30){
    return this.calendar.getAvailableSlots(from,to,durationMinutes);
  }

  /**
   * Idempotent, ownership-safe booking. Only the request that WINS the right to move a
   * booking_attempts row into (or create it as) PENDING ever calls Google/creates an
   * appointment -- every other concurrent caller for the same idempotency key is turned away
   * with a typed error before touching either. See docs/ARCHITECTURE.md for the full
   * idempotency/double-booking design.
   *
   * Ownership is established one of two ways:
   *  - create() wins outright (brand-new key): the creator owns it, full stop.
   *  - create() loses to a concurrent creator (BookingAttemptKeyConflictError, Postgres 23505 on
   *    idempotency_key): re-fetch and fall through to the same existing-row handling below.
   *  - an existing row is COMPLETED: return its appointment idempotently, or flag inconsistency.
   *  - an existing row is PENDING and fresh (updatedAt within PENDING_STALE_THRESHOLD_MS):
   *    someone else is genuinely working on it right now -- BookingInProgressError.
   *  - an existing row is PENDING and stale: reclaim it via a two-step compare-and-set
   *    (PENDING -> FAILED -> PENDING). Two-step, not a direct "PENDING -> PENDING", because a
   *    CAS only serializes concurrent callers when the WHERE-matched value actually changes --
   *    two concurrent `WHERE status='PENDING'` updates would otherwise both succeed. Losing
   *    either step means someone else already reclaimed it -- BookingInProgressError.
   *  - an existing row is FAILED: reclaim via the same FAILED -> PENDING compare-and-set the
   *    stale-PENDING path's second step already uses. Losing it -- BookingInProgressError.
   */
  async book(input:BookInput,idempotencyKey:string):Promise<Appointment>{
    const fingerprint=fingerprintBooking(input);
    let existing=await this.bookingAttempts.findByKey(idempotencyKey);

    if(!existing){
      try{
        const attempt=await this.bookingAttempts.create({leadId:input.leadId,idempotencyKey,requestFingerprint:fingerprint,status:"PENDING"});
        return this.completeBooking(attempt,input); // won outright -- sole owner, no further check needed
      }catch(err){
        if(!(err instanceof BookingAttemptKeyConflictError)) throw err;
        existing=await this.bookingAttempts.findByKey(idempotencyKey);
        if(!existing) throw err; // shouldn't happen; never hang the caller on a phantom conflict
      }
    }

    if(existing.requestFingerprint!==fingerprint) throw new IdempotencyConflictError(idempotencyKey);
    return this.claimExistingAttempt(existing,input);
  }

  private async claimExistingAttempt(existing:BookingAttempt,input:BookInput):Promise<Appointment>{
    if(existing.status==="COMPLETED"){
      if(existing.appointmentId){
        const appt=await this.appointments.findById(existing.appointmentId);
        if(appt) return appt;
      }
      // COMPLETED with no resolvable appointment is data corruption, not a retryable condition --
      // recreating the appointment or re-calling Google here could produce a duplicate. This
      // needs human reconciliation, never a silent automatic retry.
      throw new BookingAttemptInconsistentError(existing.id);
    }

    if(existing.status==="PENDING"){
      const staleCutoff=new Date(Date.now()-PENDING_STALE_THRESHOLD_MS);
      if(existing.updatedAt>staleCutoff){
        throw new BookingInProgressError(existing.idempotencyKey); // genuinely fresh -- someone else owns it
      }
      const forcedFailed=await this.bookingAttempts.claimTransition(existing.id,"PENDING","FAILED",{updatedBefore:staleCutoff});
      if(!forcedFailed) throw new BookingInProgressError(existing.idempotencyKey); // lost step 1
      const claimed=await this.bookingAttempts.claimTransition(forcedFailed.id,"FAILED","PENDING");
      if(!claimed) throw new BookingInProgressError(existing.idempotencyKey); // lost step 2
      return this.completeBooking(claimed,input);
    }

    // FAILED
    const claimed=await this.bookingAttempts.claimTransition(existing.id,"FAILED","PENDING");
    if(!claimed) throw new BookingInProgressError(existing.idempotencyKey);
    return this.completeBooking(claimed,input);
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
    // booked" -- a failure updating these denormalized convenience fields on the lead must NOT
    // roll back or invalidate an already-successful booking. But it must not be silently
    // swallowed either: log a sanitized structured warning (leadId + appointmentId only, never
    // the underlying error's raw payload) so the failure is observable. meetingAt is set from
    // appointment.startsAt (the persisted, authoritative value) in this SAME call, never a
    // separate write -- this is the one place a successful book() ever sets it, so there is
    // nothing here for an idempotent retry (claimExistingAttempt returns the existing appointment
    // directly, never re-entering completeBooking) to duplicate or overwrite incorrectly.
    // TODO(reconciliation): no background job exists yet to backfill leads.booked_at/meeting_at
    // for appointments where this write failed. Until one exists, `select a.lead_id, a.id,
    // a.starts_at from appointments a join leads l on l.id = a.lead_id where l.booked_at is null
    // or l.meeting_at is null` finds them. WhatsAppBookingHandler's markLeadBooked
    // (booking-outcome-dispatch.ts) also self-heals both fields defensively, backfilling whichever
    // is still missing, whenever it later reconfirms an already-BOOKED lead against a real
    // appointment (e.g. the "already booked" guard) -- see there.
    await this.leads.update(input.leadId,{bookedAt:new Date(),meetingAt:appointment.startsAt}).catch((err)=>{
      this.logger.warn(
        {leadId:input.leadId,appointmentId:appointment.id,reason:err instanceof Error?err.message:"unknown"},
        "Failed to record booked_at/meeting_at on lead after a successful appointment booking. The appointment is valid and unaffected; leads.booked_at/meeting_at are stale for this lead until reconciled.",
      );
    });
    return appointment;
  }
}
