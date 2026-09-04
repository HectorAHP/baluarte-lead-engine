import { randomUUID } from "node:crypto";
import type { CalendarProvider, OfferedSlotRepository, AppointmentRepository, LeadRepository, SlotOfferClaimRepository, LeadStatusHistoryRepository, Logger } from "./ports.js";
import type { OfferedSlot } from "../domain/offered-slot.js";
import type { Lead, LeadStatus } from "../domain/lead.js";
import type { Appointment } from "../domain/appointment.js";
import { assertTransition } from "../domain/state-machine.js";
import { isUpcomingBooked } from "../domain/appointment-timing.js";
import { LeadNotOfferableError, SlotOfferClaimInProgressError } from "../domain/errors.js";
import { assertSingleActiveRound } from "../domain/active-offer-consistency.js";
import { recordLeadStatusTransition } from "./lead-status-audit.js";
import { config } from "../config.js";

/**
 * Lead statuses from which offering booking slots is meaningful. Anything else (HUMAN_HANDOFF,
 * DO_NOT_CONTACT, NURTURE_C, BOOKED, or any earlier pre-qualification status) is a caller
 * precondition violation -- see LeadNotOfferableError.
 *
 * "CANCELLED" (pre-launch hardening): reactivating a lead whose appointment was cancelled into a
 * brand-new booking -- WhatsAppReactivationHandler is the only caller that can ever pass a
 * CANCELLED lead here, and only after detecting explicit new-booking/reschedule-after-cancel
 * intent in the inbound text. CANCELLED -> BOOKING_PENDING was already a valid state-machine edge
 * (Phase 4A) with no handler driving it until now -- ensureOfferableLeadStatus below reuses it via
 * the EXACT SAME mechanism that already transitions QUALIFIED_A/B leads, no new transition-writing
 * logic needed. The old (CANCELLED) appointment is never touched, restored, or referenced by this
 * or the resulting booking in any way -- AppointmentService.book() creates a wholly independent
 * new appointment, exactly like a lead's very first booking.
 *
 * "NURTURE_C" (pre-launch hardening): a lead who abandoned a prior BOOKING_PENDING round can land
 * back on NURTURE_C (see targetStatusForScore) if that was their true qualified tier -- this lets
 * them resume booking later via an explicit new-booking-intent message, same
 * WhatsAppBookingHandler.startNewBooking mechanism QUALIFIED_A/B already use. NURTURE_C ->
 * BOOKING_PENDING is the corresponding new state-machine edge.
 *
 * "BOOKED" (pre-launch hardening): a lead whose BOOKED appointment is stale/past (see
 * isUpcomingBooked) can start a genuinely NEW booking. WhatsAppPastBookedRecoveryHandler is the
 * ONLY caller that can ever pass a BOOKED lead here, and only after confirming (at the routing
 * layer, whatsapp-inbound-service.ts) that the lead's current appointment is NOT upcoming --
 * this is safe precisely BECAUSE the `activeAppointment` guard below is itself time-aware: a
 * lead with a genuinely upcoming BOOKED appointment always still short-circuits to
 * ALREADY_BOOKED, so this can never produce a second, competing future booking. BOOKED ->
 * BOOKING_PENDING was already added as a valid state-machine edge for exactly this.
 */
const OFFERABLE_LEAD_STATUSES: ReadonlySet<LeadStatus> = new Set(["QUALIFIED_A", "QUALIFIED_B", "NURTURE_C", "BOOKING_PENDING", "CANCELLED", "BOOKED"]);

/**
 * How many slots are ever persisted/shown to a lead in a single round, regardless of how many
 * the calendar provider returns. This is this service's OWN defense-in-depth enforcement of that
 * number -- both CalendarProvider implementations already cap themselves at 3 internally
 * (GoogleCalendarProvider's AvailabilityRules.maxSlots, FakeCalendarProvider's internal loop
 * break), but this service must never present more than 3 no matter what a provider returns, so
 * the cap is not solely the provider's responsibility to preserve.
 */
export const MAX_OFFERED_SLOTS = 3;

/**
 * How long an offered round of slots stays selectable before it counts as expired. 20 minutes:
 * long enough to cover a natural WhatsApp reply pace (reading three options, thinking, replying)
 * without the lead feeling rushed; short enough that an offer nobody acted on doesn't linger
 * indefinitely as "active" and block a fresh round once the lead does come back. offered_slots
 * rows are not calendar holds -- they don't reserve anything against Google Calendar -- so a
 * longer TTL would have no double-booking safety benefit, only a staleness cost.
 */
export const OFFERED_SLOT_TTL_MS = 20 * 60 * 1000;

/**
 * Maximum number of distinct rounds (distinct round_id values) a conversation may be offered
 * before slot offering stops on its own and the caller must escalate instead of continuing to
 * spend Calendar availability on a lead who hasn't committed to any of the first three. This
 * service only reports MAX_ROUNDS_REACHED -- what a caller does next (e.g. HUMAN_HANDOFF) is its
 * own policy, not this service's.
 */
export const MAX_OFFER_ROUNDS = 3;

/**
 * How long a slot_offer_claims row can sit untouched before it's treated as abandoned (the
 * owning process died before releasing it) rather than genuinely in progress. Deliberately its
 * OWN constant, not reused from AppointmentService's PENDING_STALE_THRESHOLD_MS -- these are
 * independent policies protecting structurally different critical sections (this one: a Calendar
 * READ + one batch INSERT; booking's: a Calendar WRITE + appointment INSERT), and coupling them
 * would mean changing one silently changes the other. 2 minutes, same conservative value as
 * booking's threshold, chosen deliberately for simplicity for this MVP: normal concurrency
 * (two live requests racing) is resolved by the loser waiting and re-reading, NOT by stale
 * recovery -- stale recovery exists only for a genuinely dead process, so it's safer to wait
 * too long than to steal a claim that's still legitimately in progress (e.g. a slow-but-alive
 * Calendar call).
 */
export const OFFER_CLAIM_STALE_THRESHOLD_MS = 2 * 60 * 1000;

/** How often the loser of a claim race re-checks for the winner's result. */
export const OFFER_CLAIM_POLL_INTERVAL_MS = 125;

/** Total bounded time the loser waits before giving up on this call (not on the offer itself --
 * see SlotOfferClaimInProgressError). Well under any reasonable webhook-ack timeout, and well
 * under OFFER_CLAIM_STALE_THRESHOLD_MS -- this window is for waiting out a legitimately fast
 * winner, never for detecting a dead one. */
export const OFFER_CLAIM_POLL_BUDGET_MS = 2500;

export type SlotOfferOutcome =
  | { type: "CREATED"; slots: OfferedSlot[]; lead: Lead }
  | { type: "REUSED"; slots: OfferedSlot[]; lead: Lead }
  | { type: "ALREADY_BOOKED"; appointment: Appointment }
  | { type: "NO_AVAILABILITY" }
  | { type: "MAX_ROUNDS_REACHED" };

export interface SlotOfferParams {
  lead: Lead;
  conversationId: string;
  now: Date;
  /**
   * Phase 4C: omitted (the default) is the exact, unchanged Phase 3C booking behavior --
   * assertOfferable requires QUALIFIED_A/QUALIFIED_B/BOOKING_PENDING, an existing active
   * appointment always short-circuits to ALREADY_BOOKED, and a successful round transitions the
   * lead to BOOKING_PENDING. `{type:"RESCHEDULE", oldAppointmentId}` instead requires
   * RESCHEDULE_REQUESTED, never treats the lead's still-active OLD appointment as a conflict
   * (that's the expected precondition, not a problem -- WhatsAppRescheduleHandler validates it's
   * exactly one BEFORE calling this), and never changes the lead's status (it's already
   * RESCHEDULE_REQUESTED, set by the caller before this call -- see item 3 of the Phase 4C spec,
   * "si ya existe RESCHEDULE_REQUESTED, reutilízalo"). Every other mechanic (claim/reclaim
   * concurrency, TTL, createMany atomicity, assertSingleActiveRound) is fully shared, unmodified,
   * between both modes.
   *
   * `oldAppointmentId` is carried here (not just a bare "RESCHEDULE" flag) so MAX_OFFER_ROUNDS can
   * be scoped per reschedule episode instead of cumulatively per conversation forever -- see
   * offered-slot.ts's rescheduleContextId doc comment. It's a stable, already-persistent
   * identifier (never a timestamp heuristic), available the moment
   * WhatsAppRescheduleHandler.handleIntentTurn finds the target appointment.
   */
  mode?: { type: "RESCHEDULE"; oldAppointmentId: string };
  /**
   * Fase 6E.3, narrowed by Fase 6E.3.1: when true, skips the round-cap check for THIS call only.
   * ONLY ever passed by WhatsAppPastBookedRecoveryHandler.startNewBooking, for round 1 of a brand
   * new booking episode.
   *
   * Fase 6E.3.1 UPDATE -- this is now only HALF the fix, not the whole one. The round-cap check
   * itself (see getOrCreateOffer/replaceOffer below) is now scoped to the CURRENT booking episode
   * via episodeScopedSince() -- see that method's doc comment for the full episode definition and
   * root-cause trace. `skipRoundCap` remains necessary ONLY for a new episode's very FIRST round:
   * at that exact moment the episode's own "-> BOOKING_PENDING" transition hasn't been recorded
   * yet (it's recorded AFTER this check, as part of creating that very round), so
   * episodeScopedSince() would still resolve to the PREVIOUS episode's boundary and incorrectly
   * count its rounds. Every round AFTER the first, within the SAME episode, goes through
   * WhatsAppBookingHandler.replaceOffer() -- which never passes this flag -- and is fully
   * protected by the now-episode-scoped MAX_OFFER_ROUNDS cap (see the Fase 6E.3.1 report's round
   * 1/2/3/4 test matrix for proof this is not an indefinite bypass).
   *
   * A context-id-based fix (mirroring RESCHEDULE's `oldAppointmentId` scoping) was tried first
   * (Fase 6E.3) and reverted: it requires every offered_slots row for this episode to carry a
   * non-null reschedule_context_id, but WhatsAppBookingHandler's slot-selection lookup
   * (listActiveByConversationId(conversationId, now), no context argument) only ever looks at
   * context-id-NULL rows -- so a context-scoped round would become invisible to slot selection,
   * silently breaking the booking it was supposed to enable. `skipRoundCap` avoids that failure
   * mode entirely: it changes NOTHING about what gets persisted (offered_slots.reschedule_context_id
   * stays exactly what plain booking mode would set it to -- null), so WhatsAppBookingHandler's
   * slot-selection lookup is completely unaffected. Every other caller (initial QUALIFIED_A/B
   * booking, reschedule, CANCELLED reactivation) always omits this and keeps the existing
   * (now episode-scoped) cap -- CalendarProvider and the ALREADY_BOOKED anti-double-booking guard
   * (still evaluated normally, see getOrCreateOffer below) are untouched.
   */
  skipRoundCap?: boolean;
}

/** Extracts the round-counting/tagging context id from a SlotOfferParams["mode"] -- undefined for
 * booking mode (the default), the old appointment's id for reschedule mode. Centralized here so
 * every call site derives it identically. */
function rescheduleContextIdOf(mode: SlotOfferParams["mode"]): string | undefined {
  return mode?.type === "RESCHEDULE" ? mode.oldAppointmentId : undefined;
}

export interface SlotOfferingServiceOptions {
  /** Injectable for deterministic tests; production never overrides this. Used for round_id
   * generation (both the first attempt at claim time and any stale-reclaim). */
  roundIdFactory?: () => string;
  /** Injectable for deterministic tests; production never overrides this. Used for
   * slot_offer_claims.owner_token generation. */
  ownerTokenFactory?: () => string;
  /**
   * Wall-clock source used ONLY for claim ownership/staleness decisions -- deliberately separate
   * from the `now` passed into getOrCreateOffer/replaceOffer, which stays fixed for the whole
   * call and governs business time (offered_slots TTL, bookingStartedAt, test determinism for
   * those). Ownership staleness must be judged against a clock that keeps advancing while this
   * call waits -- a frozen `now` would never let a poll loop's deadline (or a stale check)
   * actually elapse. Defaults to the real wall clock; tests inject a controllable one.
   */
  clock?: () => Date;
  /** How the loser of a claim race waits between polling attempts. Defaults to a real
   * setTimeout-based sleep; tests inject a fast/instant one so polling tests don't take
   * wall-clock seconds. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Prepares a persisted, recoverable round of offered slots for a lead moving toward a booked
 * appointment. Single responsibility, deliberately narrow:
 *  - NO WhatsApp message is ever sent from here.
 *  - NO slot selection is parsed or processed here.
 *  - NO appointment is ever created here (that remains AppointmentService.book's job).
 *
 * Round identity: every slot created together shares one round_id. Round counting and the
 * "don't mix two rounds' options" consistency check both key off round_id -- never off
 * timestamps.
 *
 * Concurrency: creating a NEW round (the only operation that can race two callers into producing
 * two active rounds for one conversation) is protected by a Postgres-backed ownership claim
 * (slot_offer_claims, migration 011) -- see claimAndCreateRound. This is NOT a process-local
 * lock: the exclusion holds across multiple app instances, because the source of truth is a
 * unique row in Postgres, not memory. Reusing an existing offer, or an appointment that already
 * exists, never touches the claim at all.
 *
 * Persistence-before-state-transition ordering (see fetchAndPersistRound) is what makes this
 * service safely retriable independent of the claim layer: if the process dies or a call fails
 * after a round's offered_slots rows are persisted but before the lead's BOOKING_PENDING
 * transition lands, the next getOrCreateOffer call finds those same active rows (Guard C) and
 * completes the transition against them -- no new Calendar call, no new rows, no duplicate round.
 */
export class SlotOfferingService {
  private readonly roundIdFactory: () => string;
  private readonly ownerTokenFactory: () => string;
  private readonly clock: () => Date;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    private readonly calendar: CalendarProvider,
    private readonly offeredSlots: OfferedSlotRepository,
    private readonly appointments: AppointmentRepository,
    private readonly leads: LeadRepository,
    private readonly slotOfferClaims: SlotOfferClaimRepository,
    private readonly leadStatusHistory: LeadStatusHistoryRepository,
    private readonly logger: Logger,
    options: SlotOfferingServiceOptions = {},
  ) {
    this.roundIdFactory = options.roundIdFactory ?? randomUUID;
    this.ownerTokenFactory = options.ownerTokenFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Idempotent, recovery-safe entrypoint. Order: lead-offerable guard -> appointment guard ->
   * active-offer lookup (REUSED, completing any interrupted transition, if found) -> round-count
   * guard -> claim-protected round creation. Reusing an existing active round never counts
   * against MAX_OFFER_ROUNDS -- only an actual new round (Calendar query + createMany) does.
   */
  async getOrCreateOffer(params: SlotOfferParams): Promise<SlotOfferOutcome> {
    const { lead, conversationId, now, mode, skipRoundCap } = params;
    this.assertOfferable(lead, mode);

    if (mode?.type !== "RESCHEDULE") {
      // RESCHEDULE mode: the lead's old appointment is expected to still be active at this point
      // (it isn't superseded until AFTER a new slot is selected) -- never a conflict, so this
      // guard simply does not apply. WhatsAppRescheduleHandler is the one that validates "exactly
      // one active appointment" before ever calling here.
      // Pre-launch hardening: a PAST BOOKED appointment (status still BOOKED, but endsAt already
      // elapsed) never blocks a new offer -- only a genuinely upcoming one does. See
      // isUpcomingBooked / WhatsAppPastBookedRecoveryHandler.
      const activeAppointment = await this.appointments.findActiveByLeadId(lead.id);
      if (activeAppointment && isUpcomingBooked(activeAppointment, now)) return { type: "ALREADY_BOOKED", appointment: activeAppointment };
    }

    const activeSlots = await this.offeredSlots.listActiveByConversationId(conversationId, now, rescheduleContextIdOf(mode));
    if (activeSlots.length > 0) return this.resolveReused(lead, now, conversationId, activeSlots, mode);

    if (!skipRoundCap) {
      const since = await this.episodeScopedSince(lead.id, mode);
      const roundIds = await this.offeredSlots.listRoundIdsByConversationId(conversationId, rescheduleContextIdOf(mode), since);
      if (roundIds.length >= MAX_OFFER_ROUNDS) return { type: "MAX_ROUNDS_REACHED" };
    }

    return this.claimAndCreateRound(lead, conversationId, now, mode);
  }

  /**
   * Forces a new round: verifies the round limit and current-offer consistency BEFORE touching
   * anything, then queries Calendar and persists the new round (through the SAME claim mechanism
   * as getOrCreateOffer -- see claimAndCreateRound), and only THEN expires whatever was active
   * before -- never the reverse.
   *
   * Ordering rationale (new-round-before-expiring-old): if Calendar has no availability or
   * createMany fails, the lead keeps whatever valid offer they already had instead of being left
   * with nothing recoverable. The unavoidable cost of this ordering is a brief window, within
   * this same call, where two rounds could both be "active" in the database -- see the residual
   * risk documented below.
   *
   * RESIDUAL RISK (no distributed transaction exists across these two writes): if createMany
   * succeeds but the subsequent expire-the-old-round update fails (e.g. the process dies, or a
   * transient DB error, in between), the conversation is left with two distinct active
   * round_ids. This method does NOT retry or paper over that -- the failure propagates to the
   * caller. The next getOrCreateOffer/replaceOffer call detects it via assertSingleActiveRound
   * and throws ActiveOfferInconsistentError rather than silently mixing both rounds' slots into
   * one list -- a loud, safe failure mode instead of fake atomicity. Recovering from that state
   * requires manually expiring one of the two rounds; no automated reconciliation exists yet.
   */
  async replaceOffer(params: SlotOfferParams): Promise<SlotOfferOutcome> {
    const { lead, conversationId, now, mode } = params;
    this.assertOfferable(lead, mode);

    if (mode?.type !== "RESCHEDULE") {
      // Pre-launch hardening: a PAST BOOKED appointment (status still BOOKED, but endsAt already
      // elapsed) never blocks a new offer -- only a genuinely upcoming one does. See
      // isUpcomingBooked / WhatsAppPastBookedRecoveryHandler.
      const activeAppointment = await this.appointments.findActiveByLeadId(lead.id);
      if (activeAppointment && isUpcomingBooked(activeAppointment, now)) return { type: "ALREADY_BOOKED", appointment: activeAppointment };
    }

    const activeSlots = await this.offeredSlots.listActiveByConversationId(conversationId, now, rescheduleContextIdOf(mode));
    assertSingleActiveRound(conversationId, activeSlots); // refuse to replace an already-inconsistent offer

    const since = await this.episodeScopedSince(lead.id, mode);
    const roundIds = await this.offeredSlots.listRoundIdsByConversationId(conversationId, rescheduleContextIdOf(mode), since);
    if (roundIds.length >= MAX_OFFER_ROUNDS) return { type: "MAX_ROUNDS_REACHED" };

    const availabilityResult = await this.claimAndCreateRound(lead, conversationId, now, mode);
    if (availabilityResult.type !== "CREATED") return availabilityResult; // NO_AVAILABILITY -- old round left untouched

    if (activeSlots.length > 0) {
      // Only expire the previous round AFTER the new one is safely persisted -- see the class
      // doc comment above for the residual-risk window this leaves if THIS step fails.
      await Promise.all(activeSlots.map((s) => this.offeredSlots.update(s.id, { expiresAt: now })));
    }

    return availabilityResult;
  }

  private assertOfferable(lead: Lead, mode?: SlotOfferParams["mode"]): void {
    const allowed = mode?.type === "RESCHEDULE" ? lead.status === "RESCHEDULE_REQUESTED" : OFFERABLE_LEAD_STATUSES.has(lead.status);
    if (!allowed) {
      throw new LeadNotOfferableError(lead.id, lead.status);
    }
  }

  /**
   * Fase 6E.3.1 -- BOOKING EPISODE definition and round-cap scoping.
   *
   * A "booking episode" is bounded by the lead's own persisted lifecycle, never inferred from
   * message text: it BEGINS the moment ensureOfferableLeadStatus below performs a REAL transition
   * into BOOKING_PENDING (recorded exactly once, as a lead_status_history row with
   * eventType "BOOKING_OFFER_STARTED" -- see recordLeadStatusTransition), and implicitly ENDS
   * whenever the lead later leaves BOOKING_PENDING for any reason (BOOKED on a successful
   * selection, NURTURE_C/CANCELLED/etc. on abandonment) -- the NEXT transition back into
   * BOOKING_PENDING starts a new episode with its own fresh boundary. No new column/table: this
   * reuses lead_status_history exactly as it already exists (Phase 4A), never a migration.
   *
   * ROOT CAUSE this closes (Fase 6E.3.1): MAX_OFFER_ROUNDS was being enforced by counting EVERY
   * offered_slots round ever created in plain booking mode for a conversation, with no time
   * boundary -- so a round used by an already-CONCLUDED prior episode (e.g. the original booking
   * that led to a now-past appointment) still counted against a LATER, unrelated episode's budget.
   * skipRoundCap (Fase 6E.3) only ever patched this for the FIRST round of a new episode
   * (WhatsAppPastBookedRecoveryHandler.startNewBooking) -- the SECOND, THIRD, ... round of that
   * SAME new episode still went through WhatsAppBookingHandler's ordinary replaceOffer() call,
   * which had no episode-scoping at all and could immediately re-trigger MAX_ROUNDS_REACHED
   * (confirmed by a reproduction test BEFORE this fix -- see the Fase 6E.3.1 report, item 1).
   *
   * Fix: every plain-booking-mode round-count check (getOrCreateOffer AND replaceOffer) now
   * passes `since` = the most recent "-> BOOKING_PENDING" lead_status_history timestamp, so
   * MAX_OFFER_ROUNDS counts ONLY rounds created since the CURRENT episode began. `skipRoundCap`
   * is still needed, unchanged, for round 1 specifically: at the moment that round's cap check
   * would run, the NEW episode's own BOOKING_PENDING transition hasn't been recorded yet (it's
   * recorded AFTER this check, inside claimAndCreateRound -> ensureOfferableLeadStatus), so
   * `since` would still resolve to the OLD episode's boundary and incorrectly count the old
   * episode's rounds -- skipRoundCap remains the correct, minimal way to let a genuinely NEW
   * episode's first round through regardless of history. It can never be exploited to bypass the
   * cap "indefinitely": every subsequent round within that same episode goes through
   * WhatsAppBookingHandler's replaceOffer() (never skipRoundCap), which is now correctly
   * episode-scoped and still enforces MAX_OFFER_ROUNDS=3 within the new episode (see the Fase
   * 6E.3.1 report's round 1/2/3/4 test matrix).
   *
   * RESCHEDULE mode is deliberately untouched (`since` stays undefined for it): its round-cap is
   * already correctly scoped by reschedule_context_id (a stable, per-episode identifier -- see
   * SlotOfferParams.mode's doc comment), an orthogonal mechanism that predates this fix and needs
   * no time filter on top of it.
   */
  private async episodeScopedSince(leadId: string, mode?: SlotOfferParams["mode"]): Promise<Date | undefined> {
    if (mode?.type === "RESCHEDULE") return undefined;
    const history = await this.leadStatusHistory.listByLeadId(leadId);
    let latest: Date | undefined;
    for (const entry of history) {
      if (entry.toStatus !== "BOOKING_PENDING") continue;
      if (!latest || entry.createdAt > latest) latest = entry.createdAt;
    }
    if (!latest) return undefined;
    // Fase 6E.4 hardening: fetchAndPersistRound persists round 1's offered_slots rows BEFORE
    // calling ensureOfferableLeadStatus (persistence-before-state-transition, by design -- see the
    // class doc comment's "RESIDUAL RISK" section), so round 1's own createdAt is DETERMINISTICALLY
    // a little EARLIER than the lead_status_history row this method reads (both stamped with a
    // fresh `new Date()` at write time, never the frozen business-time `now` param -- sequential
    // awaited code guarantees round 1's timestamp <= the transition's, never the reverse, but the
    // GAP between them is whatever that DB write actually takes -- sub-millisecond in memory, up
    // to real network latency against Supabase in production). A strict `created_at >= latest`
    // comparison therefore excludes round 1 from its OWN episode's count -- confirmed by a genuine
    // test failure (see the Fase 6E.4 report, item on this hardening). Fixed with a safety margin
    // generous enough to cover realistic same-request latency (a slow DB write, GC pause, etc.)
    // while staying far shorter than the real-world gap between two SEPARATE episodes (the first
    // appointment must actually conclude, or the lead must abandon and return, before a second
    // episode's round 1 is ever created -- minutes to days, never single-digit seconds).
    const EPISODE_BOUNDARY_MARGIN_MS = 2000;
    return new Date(latest.getTime() - EPISODE_BOUNDARY_MARGIN_MS);
  }

  private async resolveReused(lead: Lead, now: Date, conversationId: string, activeSlots: OfferedSlot[], mode?: SlotOfferParams["mode"]): Promise<SlotOfferOutcome> {
    assertSingleActiveRound(conversationId, activeSlots); // throws if data is inconsistent
    const updatedLead = await this.ensureOfferableLeadStatus(lead, now, mode);
    return { type: "REUSED", slots: activeSlots, lead: updatedLead };
  }

  /**
   * BOOKING mode (default): set-once semantics for bookingStartedAt; a lead already
   * BOOKING_PENDING is left untouched entirely (no write at all), so this is safe to call on
   * every reuse. Phase 4A: records exactly one lead_status_history row for a real transition
   * (never for the already-BOOKING_PENDING no-op), via the same shared helper
   * LeadService.transitionTo uses.
   *
   * RESCHEDULE mode: no-op, always -- the lead is already RESCHEDULE_REQUESTED by the time
   * anything in this service is ever called for it (WhatsAppRescheduleHandler sets that
   * transition itself, on detecting reschedule-intent, before calling getOrCreateOffer). There is
   * no equivalent "offer started" event to record here; CANCELLATION_REQUESTED-shaped semantics
   * don't apply to a status the lead already durably holds.
   */
  private async ensureOfferableLeadStatus(lead: Lead, now: Date, mode?: SlotOfferParams["mode"]): Promise<Lead> {
    if (mode?.type === "RESCHEDULE") return lead;
    if (lead.status === "BOOKING_PENDING") return lead;
    assertTransition(lead.status, "BOOKING_PENDING");
    const updated = await this.leads.update(lead.id, {
      status: "BOOKING_PENDING",
      ...(lead.bookingStartedAt ? {} : { bookingStartedAt: now }),
    });
    await recordLeadStatusTransition(this.leadStatusHistory, this.logger, {
      leadId: lead.id,
      fromStatus: lead.status,
      toStatus: "BOOKING_PENDING",
      eventType: "BOOKING_OFFER_STARTED",
    });
    return updated;
  }

  /**
   * Entry point for the ownership-protected "create a new round" critical section. Generates an
   * ownerToken + intendedRoundId, then tries to win the claim outright. Losing means someone
   * else already holds it -- see waitOrReclaim for what happens next.
   */
  private async claimAndCreateRound(lead: Lead, conversationId: string, now: Date, mode?: SlotOfferParams["mode"]): Promise<SlotOfferOutcome> {
    const ownerToken = this.ownerTokenFactory();
    const intendedRoundId = this.roundIdFactory();

    const won = await this.slotOfferClaims.tryCreate({ conversationId, ownerToken, intendedRoundId });
    if (won) return this.runClaimedWork(lead, conversationId, now, ownerToken, intendedRoundId, mode);

    return this.waitOrReclaim(lead, conversationId, now, ownerToken, intendedRoundId, mode);
  }

  /**
   * Lost the initial claim race. Polls for the winner's result (bounded, short) before
   * considering the claim abandoned. This deliberately keeps two concerns separate:
   *  - CONCURRENCY (two live requests racing right now): resolved here, within this call, by
   *    waiting and re-reading -- never by stealing a fresh claim.
   *  - CRASH RECOVERY (the owner is actually dead): only considered AFTER the poll budget is
   *    exhausted, and only acted on if the claim is ALREADY older than
   *    OFFER_CLAIM_STALE_THRESHOLD_MS -- a real, generous margin, not a race with the poll
   *    budget. A winner that's merely slower than the poll window (but still alive) is never
   *    stolen from; the caller gets SlotOfferClaimInProgressError instead, an explicitly
   *    recoverable technical condition.
   */
  private async waitOrReclaim(
    lead: Lead,
    conversationId: string,
    now: Date,
    ownerToken: string,
    intendedRoundId: string,
    mode?: SlotOfferParams["mode"],
  ): Promise<SlotOfferOutcome> {
    const deadline = this.clock().getTime() + OFFER_CLAIM_POLL_BUDGET_MS;
    while (this.clock().getTime() < deadline) {
      const activeSlots = await this.offeredSlots.listActiveByConversationId(conversationId, now, rescheduleContextIdOf(mode));
      if (activeSlots.length > 0) return this.resolveReused(lead, now, conversationId, activeSlots, mode);
      await this.sleepFn(OFFER_CLAIM_POLL_INTERVAL_MS);
    }

    // Poll budget exhausted -- one last check before deciding anything about the claim itself.
    const finalActiveSlots = await this.offeredSlots.listActiveByConversationId(conversationId, now, rescheduleContextIdOf(mode));
    if (finalActiveSlots.length > 0) return this.resolveReused(lead, now, conversationId, finalActiveSlots, mode);

    const existing = await this.slotOfferClaims.findByConversationId(conversationId);
    if (!existing) {
      // The claim was released (success or handled failure) without ever producing active
      // slots (e.g. NO_AVAILABILITY) -- free to try winning it ourselves now.
      const won = await this.slotOfferClaims.tryCreate({ conversationId, ownerToken, intendedRoundId });
      if (won) return this.runClaimedWork(lead, conversationId, now, ownerToken, intendedRoundId, mode);
      throw new SlotOfferClaimInProgressError(conversationId); // someone else grabbed it again right as we tried
    }

    const staleCutoff = new Date(this.clock().getTime() - OFFER_CLAIM_STALE_THRESHOLD_MS);
    if (existing.updatedAt >= staleCutoff) {
      throw new SlotOfferClaimInProgressError(conversationId); // genuinely fresh -- never steal
    }

    // Stale -- but the dead owner might have actually persisted a round before dying (case E in
    // the design: "creates round, dies before releasing"). Check once more before reclaiming so
    // a legitimately-finished round is never discarded in favor of an unnecessary reclaim.
    const preReclaimActiveSlots = await this.offeredSlots.listActiveByConversationId(conversationId, now, rescheduleContextIdOf(mode));
    if (preReclaimActiveSlots.length > 0) return this.resolveReused(lead, now, conversationId, preReclaimActiveSlots, mode);

    const newOwnerToken = this.ownerTokenFactory();
    const newIntendedRoundId = this.roundIdFactory();
    const reclaimed = await this.slotOfferClaims.tryReclaim({
      conversationId,
      expectedOwnerToken: existing.ownerToken,
      newOwnerToken,
      intendedRoundId: newIntendedRoundId,
      staleBefore: staleCutoff,
      now: this.clock(),
    });
    if (!reclaimed) throw new SlotOfferClaimInProgressError(conversationId); // lost the reclaim race to another reclaimer

    return this.runClaimedWork(lead, conversationId, now, newOwnerToken, newIntendedRoundId, mode);
  }

  /** Runs the actual Calendar-query + persist step under an already-won claim, then releases it
   * regardless of outcome (success, NO_AVAILABILITY, or a thrown error) -- best-effort; a failed
   * release just means OFFER_CLAIM_STALE_THRESHOLD_MS is the backstop instead of an immediate
   * retry, never a crash. */
  private async runClaimedWork(lead: Lead, conversationId: string, now: Date, ownerToken: string, intendedRoundId: string, mode?: SlotOfferParams["mode"]): Promise<SlotOfferOutcome> {
    try {
      return await this.fetchAndPersistRound(lead, conversationId, now, intendedRoundId, mode);
    } finally {
      await this.slotOfferClaims.release(conversationId, ownerToken).catch((err) => {
        // Sanitized: conversationId + error name only -- never the ownerToken (an opaque
        // capability-like value with no diagnostic upside in a log) or any slot/lead payload.
        this.logger.warn(
          { conversationId, errorName: err instanceof Error ? err.name : "unknown" },
          "Failed to release a slot-offering claim; the stale-reclaim threshold is the backstop.",
        );
      });
    }
  }

  /**
   * Queries Calendar and persists a new round via ONE atomic createMany call (never a loop of
   * individual create() calls), THEN transitions the lead. Order is load-bearing: if createMany
   * throws, the lead is never touched, and Postgres/InMemory's "all rows or none" guarantee
   * means no partial round is ever left behind for that failure. If the transition fails AFTER
   * createMany succeeds, the round is left safely recoverable -- see the class doc comment on
   * why that makes the whole flow retriable. `roundId` comes from the caller's already-won claim
   * (claimAndCreateRound/waitOrReclaim) -- never generated here, so every offered_slots row this
   * method persists always matches its claim's intended_round_id exactly.
   */
  private async fetchAndPersistRound(lead: Lead, conversationId: string, now: Date, roundId: string, mode?: SlotOfferParams["mode"]): Promise<SlotOfferOutcome> {
    const to = new Date(now.getTime() + config.BOOKING_MAX_DAYS_AHEAD * 86_400_000);
    const available = await this.calendar.getAvailableSlots(now, to, config.MEETING_DURATION_MINUTES);
    if (available.length === 0) return { type: "NO_AVAILABILITY" };

    const chosen = available.slice(0, MAX_OFFERED_SLOTS);
    const expiresAt = new Date(now.getTime() + OFFERED_SLOT_TTL_MS);

    const rescheduleContextId = rescheduleContextIdOf(mode);
    const persisted = await this.offeredSlots.createMany(
      chosen.map((slot, i) => ({
        conversationId,
        leadId: lead.id,
        roundId,
        slotStart: slot.start,
        slotEnd: slot.end,
        position: i + 1,
        expiresAt,
        selected: false,
        rescheduleContextId,
      })),
    );

    const updatedLead = await this.ensureOfferableLeadStatus(lead, now, mode);
    return { type: "CREATED", slots: persisted, lead: updatedLead };
  }
}
