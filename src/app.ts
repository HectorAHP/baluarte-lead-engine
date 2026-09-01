import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { config, hasGoogleCalendarCredentials, hasWhatsAppCredentials } from "./config.js";
import {
  InMemoryLeadRepository, InMemoryAppointmentRepository, InMemoryBookingAttemptRepository,
  InMemoryLeadScoreRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryQualificationAnswerRepository, InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository, InMemoryAppointmentMessageDeliveryRepository,
  InMemoryAppointmentCancellationRepository, InMemoryAppointmentRescheduleRepository,
} from "./infrastructure/memory-repositories.js";
import { SupabaseLeadRepository } from "./infrastructure/supabase-lead-repository.js";
import { SupabaseAppointmentRepository } from "./infrastructure/supabase-appointment-repository.js";
import { SupabaseBookingAttemptRepository } from "./infrastructure/supabase-booking-attempt-repository.js";
import { SupabaseLeadScoreRepository } from "./infrastructure/supabase-lead-score-repository.js";
import { SupabaseConversationRepository } from "./infrastructure/supabase-conversation-repository.js";
import { SupabaseMessageRepository } from "./infrastructure/supabase-message-repository.js";
import { SupabaseQualificationAnswerRepository } from "./infrastructure/supabase-qualification-answer-repository.js";
import { SupabaseOfferedSlotRepository } from "./infrastructure/supabase-offered-slot-repository.js";
import { SupabaseSlotOfferClaimRepository } from "./infrastructure/supabase-slot-offer-claim-repository.js";
import { SupabaseLeadStatusHistoryRepository } from "./infrastructure/supabase-lead-status-history-repository.js";
import { SupabaseAppointmentStatusHistoryRepository } from "./infrastructure/supabase-appointment-status-history-repository.js";
import { SupabaseAppointmentMessageDeliveryRepository } from "./infrastructure/supabase-appointment-message-delivery-repository.js";
import { SupabaseAppointmentCancellationRepository } from "./infrastructure/supabase-appointment-cancellation-repository.js";
import { SupabaseAppointmentRescheduleRepository } from "./infrastructure/supabase-appointment-reschedule-repository.js";
import { createSupabaseClient } from "./infrastructure/supabase-client.js";
import { FakeCalendarProvider } from "./infrastructure/fake-calendar.js";
import { GoogleCalendarProvider } from "./infrastructure/google-calendar-provider.js";
import { FakeMessagingProvider } from "./infrastructure/fake-messaging-provider.js";
import { MetaWhatsAppProvider } from "./infrastructure/meta-whatsapp-provider.js";
import { LeadService, AppointmentService } from "./application/services.js";
import { SlotOfferingService } from "./application/slot-offering-service.js";
import { AppointmentCancellationService } from "./application/appointment-cancellation-service.js";
import { AppointmentRescheduleService } from "./application/appointment-reschedule-service.js";
import { handleInboundWhatsAppText } from "./application/whatsapp-inbound-service.js";
import { WhatsAppQualificationHandler } from "./application/whatsapp-qualification-handler.js";
import { WhatsAppBookingHandler } from "./application/whatsapp-booking-handler.js";
import { WhatsAppCancellationHandler } from "./application/whatsapp-cancellation-handler.js";
import { WhatsAppRescheduleHandler } from "./application/whatsapp-reschedule-handler.js";
import { WhatsAppReactivationHandler } from "./application/whatsapp-reactivation-handler.js";
import { WhatsAppPastBookedRecoveryHandler } from "./application/whatsapp-past-booked-recovery-handler.js";
import { extractWhatsAppMessages } from "./domain/whatsapp-webhook-payload.js";
import { verifyMetaSignature } from "./domain/meta-signature.js";
import { timingSafeEqualStrings } from "./domain/timing-safe-compare.js";
import {
  LeadNotFoundError, InvalidLeadTransitionError, SlotUnavailableError,
  IdempotencyConflictError, CalendarProviderError,
} from "./domain/errors.js";
import type {
  LeadRepository, AppointmentRepository, BookingAttemptRepository, LeadScoreRepository,
  ConversationRepository, MessageRepository, QualificationAnswerRepository, OfferedSlotRepository,
  SlotOfferClaimRepository, CalendarProvider, MessagingProvider,
  LeadStatusHistoryRepository, AppointmentStatusHistoryRepository, AppointmentMessageDeliveryRepository,
  AppointmentCancellationRepository, AppointmentRescheduleRepository,
} from "./application/ports.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface AppDependencies {
  /**
   * Phase 4C hardening (item 15): explicit override for the Supabase client itself, not just the
   * individual repositories built from it. `undefined` (the default) keeps today's production
   * behavior -- construct a real client whenever config.SUPABASE_URL/SUPABASE_SECRET_KEY are set.
   * `null` forces NO Supabase client to ever be constructed, regardless of what's in .env --
   * tests/helpers/test-app.ts always passes `null` explicitly, so `npm test` can never touch a
   * real Supabase client even when real production credentials are present in the environment's
   * .env (this repo's own .env does carry them -- see the Phase 4C hardening report). This also
   * makes /health's `persistenceProvider` field accurate in tests (it was previously driven by
   * config.SUPABASE_URL/SUPABASE_SECRET_KEY's mere presence, not by which persistence layer the
   * app actually wired -- a cosmetic-only mismatch in test runs, now closed).
   */
  supabaseClient?: SupabaseClient | null;
  leadsRepo?: LeadRepository;
  appointmentsRepo?: AppointmentRepository;
  bookingAttemptsRepo?: BookingAttemptRepository;
  leadScoresRepo?: LeadScoreRepository;
  conversationsRepo?: ConversationRepository;
  messagesRepo?: MessageRepository;
  qualificationAnswersRepo?: QualificationAnswerRepository;
  /** Phase 3C: the offered_slots repository. Wired here so SlotOfferingService is constructible
   * and injectable -- no route or handler consumes it yet in this block. */
  offeredSlotsRepo?: OfferedSlotRepository;
  /** Phase 3C concurrency hardening: protects SlotOfferingService's round-creation critical
   * section against two concurrent callers for the same conversation (see migration 011). */
  slotOfferClaimsRepo?: SlotOfferClaimRepository;
  /** Phase 4A: lifecycle audit foundation (see docs/PHASE4-DESIGN.md). Consumed by LeadService,
   * SlotOfferingService, and booking-outcome-dispatch.ts/whatsapp-booking-handler.ts's
   * markLeadBooked/escalateToHuman to record lead_status_history rows -- no route or handler
   * changes behavior based on it. */
  leadStatusHistoryRepo?: LeadStatusHistoryRepository;
  /** Phase 4A introduced this unconsumed; Phase 4B gives it its first real consumer
   * (AppointmentCancellationService, via recordAppointmentStatusTransition on a real
   * BOOKED -> CANCELLED transition). */
  appointmentStatusHistoryRepo?: AppointmentStatusHistoryRepository;
  /** Phase 4A: constructed and injectable, but not consumed by any code yet -- no scheduler/sweep
   * exists. Ready for Phase 4D/4E. */
  appointmentMessageDeliveryRepo?: AppointmentMessageDeliveryRepository;
  /** Phase 4B: tracks Google Calendar cleanup completion for a cancellation. Consumed by
   * AppointmentCancellationService (always constructed) regardless of whether
   * WHATSAPP_CANCELLATION_ENABLED is on -- only the WhatsApp-facing handler is gated by the flag. */
  appointmentCancellationsRepo?: AppointmentCancellationRepository;
  /** Phase 4C: tracks new-appointment-creation ownership AND old-Calendar-cleanup completion for
   * a reschedule. Consumed by AppointmentRescheduleService (always constructed) regardless of
   * whether WHATSAPP_RESCHEDULE_ENABLED is on -- only the WhatsApp-facing handler is gated by the
   * flag, same convention as appointmentCancellationsRepo above. */
  appointmentReschedulesRepo?: AppointmentRescheduleRepository;
  calendar?: CalendarProvider;
  messaging?: MessagingProvider;
  /** Override for config.WHATSAPP_VERIFY_TOKEN -- exists so webhook verification is testable
   * without real WhatsApp credentials in the environment. */
  whatsappVerifyToken?: string;
  /** Override for config.META_APP_SECRET -- exists so signature validation is testable without
   * a real Meta app secret in the environment. */
  metaAppSecret?: string;
  /** Override for hasWhatsAppCredentials, used only for the /health `whatsappProvider` field --
   * exists so the "meta" health state is testable without constructing a real
   * MetaWhatsAppProvider (whose constructor throws without real credentials). Does not affect
   * which messaging provider is actually used for sending -- that's still governed by
   * `overrides.messaging` / the real hasWhatsAppCredentials, unchanged. */
  whatsappCredentialsConfigured?: boolean;
  /** Override for config.QUALIFICATION_ENGINE_ENABLED -- exists so tests can exercise the
   * Phase 3B qualifier flow without setting a real env var. Production defaults to the config
   * value (itself defaulting to false). */
  qualificationEngineEnabled?: boolean;
  /** Override for config.WHATSAPP_BOOKING_ENABLED -- same rationale and precedence as
   * qualificationEngineEnabled above, kept as a fully independent flag. As of this block, no
   * code reads this for anything beyond the boot-time log line: no booking handler exists yet,
   * so this flag cannot change behavior no matter its value. */
  whatsappBookingEnabled?: boolean;
  /** Override for config.WHATSAPP_CANCELLATION_ENABLED -- same rationale and precedence as
   * whatsappBookingEnabled above, kept fully independent. */
  whatsappCancellationEnabled?: boolean;
  /** Override for config.WHATSAPP_RESCHEDULE_ENABLED -- same rationale and precedence as
   * whatsappCancellationEnabled above, kept fully independent. */
  whatsappRescheduleEnabled?: boolean;
}

export async function buildApp(overrides: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  // Captures the exact raw bytes of every JSON body, needed to verify Meta's HMAC signature
  // (which is computed over the raw payload, not a re-serialization of the parsed object).
  // Behaves identically to Fastify's built-in JSON parser for every other route.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if ((body as Buffer).length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const whatsappVerifyToken = overrides.whatsappVerifyToken ?? config.WHATSAPP_VERIFY_TOKEN;
  const metaAppSecret = overrides.metaAppSecret ?? config.META_APP_SECRET;

  // overrides.supabaseClient !== undefined lets a caller force EITHER a specific client OR null
  // (never constructing one) -- see AppDependencies' doc comment (Phase 4C hardening item 15).
  // undefined (production's only path) preserves today's exact behavior.
  const supabaseClient = overrides.supabaseClient !== undefined ? overrides.supabaseClient : config.SUPABASE_URL && config.SUPABASE_SECRET_KEY ? createSupabaseClient() : null;
  const leadsRepo = overrides.leadsRepo ?? (supabaseClient ? new SupabaseLeadRepository(supabaseClient) : new InMemoryLeadRepository());
  const appointmentsRepo = overrides.appointmentsRepo ?? (supabaseClient ? new SupabaseAppointmentRepository(supabaseClient) : new InMemoryAppointmentRepository());
  const bookingAttemptsRepo = overrides.bookingAttemptsRepo ?? (supabaseClient ? new SupabaseBookingAttemptRepository(supabaseClient) : new InMemoryBookingAttemptRepository());
  const leadScoresRepo = overrides.leadScoresRepo ?? (supabaseClient ? new SupabaseLeadScoreRepository(supabaseClient) : new InMemoryLeadScoreRepository());
  const conversationsRepo = overrides.conversationsRepo ?? (supabaseClient ? new SupabaseConversationRepository(supabaseClient) : new InMemoryConversationRepository());
  const messagesRepo = overrides.messagesRepo ?? (supabaseClient ? new SupabaseMessageRepository(supabaseClient) : new InMemoryMessageRepository());
  const qualificationAnswersRepo = overrides.qualificationAnswersRepo ?? (supabaseClient ? new SupabaseQualificationAnswerRepository(supabaseClient) : new InMemoryQualificationAnswerRepository());
  const slotOfferClaimsRepo = overrides.slotOfferClaimsRepo ?? (supabaseClient ? new SupabaseSlotOfferClaimRepository(supabaseClient) : new InMemorySlotOfferClaimRepository());
  const offeredSlotsRepo = overrides.offeredSlotsRepo ?? (supabaseClient ? new SupabaseOfferedSlotRepository(supabaseClient) : new InMemoryOfferedSlotRepository());
  // Phase 4A/4B -- lifecycle audit foundation. leadStatusHistoryRepo and (as of Phase 4B)
  // appointmentStatusHistoryRepo are both consumed below; appointmentMessageDeliveryRepo remains
  // constructed and injectable but has no consumer yet (see AppDependencies' doc comments above).
  const leadStatusHistoryRepo = overrides.leadStatusHistoryRepo ?? (supabaseClient ? new SupabaseLeadStatusHistoryRepository(supabaseClient) : new InMemoryLeadStatusHistoryRepository());
  const appointmentStatusHistoryRepo = overrides.appointmentStatusHistoryRepo ?? (supabaseClient ? new SupabaseAppointmentStatusHistoryRepository(supabaseClient) : new InMemoryAppointmentStatusHistoryRepository());
  const appointmentMessageDeliveryRepo = overrides.appointmentMessageDeliveryRepo ?? (supabaseClient ? new SupabaseAppointmentMessageDeliveryRepository(supabaseClient) : new InMemoryAppointmentMessageDeliveryRepository());
  void appointmentMessageDeliveryRepo; // constructed for future Phase 4D/4E wiring; unused in 4B
  // Phase 4B: appointment_status_history now HAS a real consumer (AppointmentCancellationService
  // below) -- the earlier "unused in 4A" placeholder no longer applies to this one.
  const appointmentCancellationsRepo = overrides.appointmentCancellationsRepo ?? (supabaseClient ? new SupabaseAppointmentCancellationRepository(supabaseClient) : new InMemoryAppointmentCancellationRepository());
  // Phase 4C: same "always constructed, only the WhatsApp-facing handler is flag-gated" pattern.
  const appointmentReschedulesRepo = overrides.appointmentReschedulesRepo ?? (supabaseClient ? new SupabaseAppointmentRescheduleRepository(supabaseClient) : new InMemoryAppointmentRescheduleRepository());
  const calendar = overrides.calendar ?? (hasGoogleCalendarCredentials ? new GoogleCalendarProvider() : new FakeCalendarProvider());
  const messaging = overrides.messaging ?? (hasWhatsAppCredentials ? new MetaWhatsAppProvider() : new FakeMessagingProvider());

  const leadService = new LeadService(leadsRepo, leadScoresRepo, leadStatusHistoryRepo, app.log);
  const appointmentService = new AppointmentService(calendar, appointmentsRepo, bookingAttemptsRepo, leadsRepo, app.log);
  // Always constructed -- cheap, stateless, and needed by both qualificationHandler (to offer
  // slots right after QUALIFIED_A/B) and bookingHandler below, each gated independently by its
  // own flag.
  const slotOfferingService = new SlotOfferingService(calendar, offeredSlotsRepo, appointmentsRepo, leadsRepo, slotOfferClaimsRepo, leadStatusHistoryRepo, app.log);
  // Phase 4B: always constructed -- cheap, stateless, same rationale as slotOfferingService above.
  // Only the WhatsApp-facing cancellationHandler below is gated by the feature flag.
  const cancellationService = new AppointmentCancellationService(calendar, appointmentsRepo, appointmentCancellationsRepo, appointmentStatusHistoryRepo, app.log);
  // Phase 4C: always constructed -- cheap, stateless, same rationale as cancellationService above.
  // Depends on cancellationService itself (reused wholesale for the double-booking-race rollback
  // path -- see AppointmentRescheduleService's class doc comment).
  const rescheduleService = new AppointmentRescheduleService(calendar, appointmentsRepo, appointmentReschedulesRepo, appointmentStatusHistoryRepo, cancellationService, app.log);

  // "fake" only when a test/dev caller explicitly passed a FakeMessagingProvider override --
  // NOT whenever the resolved `messaging` instance happens to be one, since the normal
  // production fallback (missing credentials) also constructs a FakeMessagingProvider. That
  // fallback case must report "unconfigured", not "fake".
  const whatsappCredentialsConfigured = overrides.whatsappCredentialsConfigured ?? hasWhatsAppCredentials;
  const whatsappProvider: "meta" | "fake" | "unconfigured" =
    overrides.messaging instanceof FakeMessagingProvider ? "fake" : whatsappCredentialsConfigured ? "meta" : "unconfigured";

  // Same "explicit test override wins" reasoning as whatsappProvider above -- /health must report
  // "fake" whenever a caller (always true for buildTestApp) explicitly injected a
  // FakeCalendarProvider, never "google" just because real Google credentials happen to be
  // present in .env while they're structurally unused.
  const calendarProviderLabel: "google" | "fake" =
    overrides.calendar instanceof FakeCalendarProvider ? "fake" : hasGoogleCalendarCredentials ? "google" : "fake";

  // Phase 3B feature flag. false (the default) keeps WhatsApp behavior byte-for-byte identical
  // to Phase 2 -- handleInboundWhatsAppText never receives a qualificationHandler, so its new
  // conditional branches are simply never taken. Enable with QUALIFICATION_ENGINE_ENABLED=true
  // in .env for a controlled test (see the Phase 3B report for the exact steps).
  const qualificationEngineEnabled = overrides.qualificationEngineEnabled ?? config.QUALIFICATION_ENGINE_ENABLED;

  // Phase 3C feature flag. Deliberately independent of qualificationEngineEnabled: booking never
  // replaces or bypasses qualification -- a lead only ever reaches BOOKING_PENDING by first
  // completing qualification (QUALIFIED_A/B), so this flag alone can never activate booking
  // behavior for a lead that hasn't gone through the qualifier.
  const whatsappBookingEnabled = overrides.whatsappBookingEnabled ?? config.WHATSAPP_BOOKING_ENABLED;

  // Phase 4B feature flag. Independent of both flags above: cancellation only ever activates for
  // a lead already BOOKED/CANCEL_PENDING, a status a lead can only reach via the booking flow --
  // this flag alone can never let a pre-booking lead skip ahead into cancellation.
  const whatsappCancellationEnabled = overrides.whatsappCancellationEnabled ?? config.WHATSAPP_CANCELLATION_ENABLED;

  // Phase 4C feature flag. Independent of the three flags above: reschedule only ever activates
  // for a lead already BOOKED/RESCHEDULE_REQUESTED, statuses a lead can only reach via the
  // booking flow -- this flag alone can never let a pre-booking lead skip ahead into reschedule.
  const whatsappRescheduleEnabled = overrides.whatsappRescheduleEnabled ?? config.WHATSAPP_RESCHEDULE_ENABLED;

  const qualificationHandler = qualificationEngineEnabled
    ? new WhatsAppQualificationHandler({
        leads: leadsRepo,
        conversations: conversationsRepo,
        messages: messagesRepo,
        leadScores: leadScoresRepo,
        qualificationAnswers: qualificationAnswersRepo,
        leadService,
        messaging,
        leadStatusHistory: leadStatusHistoryRepo,
        logger: app.log,
        // Present only when booking is ALSO enabled -- with it undefined, applyOutcome's
        // QUALIFICATION_COMPLETE branch behaves exactly as Phase 3B (message only, no offer).
        slotOffering: whatsappBookingEnabled ? slotOfferingService : undefined,
      })
    : undefined;

  // Phase 3C: only constructed when the flag is on. undefined keeps handleInboundWhatsAppText's
  // new booking-routing branch (see whatsapp-inbound-service.ts) untaken -- Phase 3B/2 behavior
  // is unchanged with this flag off, exactly like qualificationHandler above.
  const bookingHandler = whatsappBookingEnabled
    ? new WhatsAppBookingHandler(
        {
          leads: leadsRepo,
          conversations: conversationsRepo,
          appointments: appointmentsRepo,
          offeredSlots: offeredSlotsRepo,
          slotOffering: slotOfferingService,
          appointmentService,
          messaging,
          messages: messagesRepo,
          leadStatusHistory: leadStatusHistoryRepo,
          logger: app.log,
        },
        config.ADVISOR_TIMEZONE,
      )
    : undefined;

  // Phase 4B: only constructed when the flag is on. undefined keeps handleInboundWhatsAppText's
  // new BOOKED/CANCEL_PENDING routing branch (see whatsapp-inbound-service.ts) untaken -- Phase
  // 3C behavior is unchanged with this flag off, exactly like bookingHandler above.
  const cancellationHandler = whatsappCancellationEnabled
    ? new WhatsAppCancellationHandler(
        {
          leads: leadsRepo,
          conversations: conversationsRepo,
          appointments: appointmentsRepo,
          messaging,
          messages: messagesRepo,
          leadStatusHistory: leadStatusHistoryRepo,
          cancellationService,
          logger: app.log,
        },
        config.ADVISOR_TIMEZONE,
      )
    : undefined;

  // Phase 4C: only constructed when the flag is on. undefined keeps handleInboundWhatsAppText's
  // new RESCHEDULE_REQUESTED / BOOKED-reschedule-intent routing branches untaken -- Phase 4B
  // behavior is unchanged with this flag off, exactly like cancellationHandler above.
  const rescheduleHandler = whatsappRescheduleEnabled
    ? new WhatsAppRescheduleHandler(
        {
          leads: leadsRepo,
          conversations: conversationsRepo,
          appointments: appointmentsRepo,
          offeredSlots: offeredSlotsRepo,
          slotOffering: slotOfferingService,
          rescheduleService,
          messaging,
          messages: messagesRepo,
          leadStatusHistory: leadStatusHistoryRepo,
          logger: app.log,
        },
        config.ADVISOR_TIMEZONE,
      )
    : undefined;

  // Pre-launch hardening: reactivates a CANCELLED lead into a brand-new booking. Reuses
  // whatsappBookingEnabled (not a new flag -- see WhatsAppReactivationHandler's class doc
  // comment for why) -- undefined keeps handleInboundWhatsAppText's new CANCELLED routing branch
  // untaken, unchanged behavior with the flag off.
  const reactivationHandler = whatsappBookingEnabled
    ? new WhatsAppReactivationHandler(
        {
          leads: leadsRepo,
          conversations: conversationsRepo,
          slotOffering: slotOfferingService,
          messaging,
          messages: messagesRepo,
          leadStatusHistory: leadStatusHistoryRepo,
          logger: app.log,
        },
        config.ADVISOR_TIMEZONE,
      )
    : undefined;

  // Pre-launch hardening: recovers a BOOKED lead whose appointment is stale/past. Same
  // whatsappBookingEnabled reuse and undefined-keeps-routing-untaken reasoning as
  // reactivationHandler above -- see WhatsAppPastBookedRecoveryHandler's class doc comment.
  const pastBookedRecoveryHandler = whatsappBookingEnabled
    ? new WhatsAppPastBookedRecoveryHandler(
        {
          leads: leadsRepo,
          conversations: conversationsRepo,
          slotOffering: slotOfferingService,
          messaging,
          messages: messagesRepo,
          leadStatusHistory: leadStatusHistoryRepo,
          logger: app.log,
        },
        config.ADVISOR_TIMEZONE,
      )
    : undefined;

  // Sanitized: all flags are plain booleans, never secrets/tokens/message bodies.
  app.log.info({ qualificationEngineEnabled, whatsappBookingEnabled, whatsappCancellationEnabled, whatsappRescheduleEnabled }, "Phase 3B/3C/4B/4C WhatsApp feature flags");

  // Sanitized boot-time fingerprint of the loaded WhatsApp config -- only the last 4 characters
  // of the Phone Number ID, never the token/secret. Node only reads .env once at process start,
  // so this line is the fast way to confirm a running process picked up a recent .env change
  // instead of comparing process-start timestamps by hand.
  if (whatsappProvider === "meta") {
    app.log.info(
      { whatsappProvider, phoneNumberIdLast4: config.WHATSAPP_PHONE_NUMBER_ID?.slice(-4) },
      "WhatsApp Cloud API provider configured",
    );
  }

  app.get("/health", async () => ({
    ok: true,
    service: "baluarte-lead-engine",
    calendarProvider: calendarProviderLabel,
    persistenceProvider: supabaseClient ? "supabase" : "memory",
    whatsappProvider,
  }));

  const createLeadSchema = z.object({ firstName: z.string().min(1).optional(), lastName: z.string().min(1).optional(), phone: z.string().min(8).optional(), email: z.string().email().optional(), source: z.string().optional(), productVertical: z.enum(["PATRIMONIAL", "GMM", "UNKNOWN"]).optional(), productInterest: z.string().optional() });
  app.post("/api/leads", async (req, reply) => reply.code(201).send(await leadService.createLead(createLeadSchema.parse(req.body))));
  app.get("/api/leads/:id", async (req, reply) => { const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const lead = await leadsRepo.findById(id); return lead ?? reply.code(404).send({ error: "LEAD_NOT_FOUND" }); });
  app.post("/api/leads/:id/contact", async (req) => { const { id } = z.object({ id: z.string().uuid() }).parse(req.params); return leadService.markContacted(id); });
  app.post("/api/leads/:id/qualification/start", async (req) => { const { id } = z.object({ id: z.string().uuid() }).parse(req.params); return leadService.startQualification(id); });

  const p = z.object({ vertical: z.literal("PATRIMONIAL"), urgency: z.enum(["THIS_WEEK", "THIS_MONTH", "ONE_TO_THREE_MONTHS", "LATER", "RESEARCHING"]), monthlyCapacity: z.enum(["LT_3000", "3000_4999", "5000_9999", "10000_19999", "20000_PLUS"]), objectiveDefined: z.boolean(), hasCurrentSavingsOrInvestment: z.boolean(), acceptsMeeting: z.boolean() });
  const g = z.object({ vertical: z.literal("GMM"), renewalWindow: z.enum(["LE_30", "31_60", "61_90", "GT_90"]).optional(), wantsNewPolicyThisMonth: z.boolean().optional(), concreteNeed: z.boolean(), completeInfo: z.boolean(), acceptsMeeting: z.boolean() });
  app.post("/api/leads/:id/score", async (req) => { const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const raw = z.discriminatedUnion("vertical", [p, g]).parse(req.body); if (raw.vertical === "PATRIMONIAL") { const { vertical, ...input } = raw; return leadService.scorePatrimonialLead(id, input); } const { vertical, ...input } = raw; return leadService.scoreGmmLead(id, input); });

  app.get("/api/availability", async (req) => { const q = z.object({ from: z.coerce.date(), to: z.coerce.date(), duration: z.coerce.number().int().positive().default(config.MEETING_DURATION_MINUTES) }).parse(req.query); return { timezone: config.ADVISOR_TIMEZONE, slots: await appointmentService.getAvailability(q.from, q.to, q.duration) }; });

  app.get("/api/appointments/:id", async (req, reply) => { const { id } = z.object({ id: z.string().uuid() }).parse(req.params); const appointment = await appointmentsRepo.findById(id); return appointment ?? reply.code(404).send({ error: "APPOINTMENT_NOT_FOUND" }); });

  const book = z.object({ leadId: z.string().uuid(), title: z.string().min(1), description: z.string().default(""), start: z.coerce.date(), end: z.coerce.date(), attendeeEmail: z.string().email().optional() });
  const idempotencyHeaders = z.object({ "idempotency-key": z.string().min(1) });
  app.post("/api/appointments", async (req, reply) => {
    const { "idempotency-key": idempotencyKey } = idempotencyHeaders.parse(req.headers);
    const body = book.parse(req.body);
    const appointment = await appointmentService.book({ ...body, timezone: config.ADVISOR_TIMEZONE }, idempotencyKey);
    return reply.code(201).send(appointment);
  });

  // -- WhatsApp webhooks --------------------------------------------------------------------

  const verifyQuery = z.object({ "hub.mode": z.string().optional(), "hub.verify_token": z.string().optional(), "hub.challenge": z.string().optional() });
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const query = verifyQuery.parse(req.query);
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"] ?? "";
    const challenge = query["hub.challenge"] ?? "";
    if (mode === "subscribe" && whatsappVerifyToken && timingSafeEqualStrings(token, whatsappVerifyToken)) {
      return reply.code(200).send(challenge);
    }
    return reply.code(403).send();
  });

  app.post("/webhooks/whatsapp", async (req, reply) => {
    // Ack fast, reject clearly: without META_APP_SECRET there is no way to validate a
    // signature, so no request can be trusted -- fail closed rather than skip validation.
    if (!metaAppSecret) return reply.code(401).send();

    const signatureHeader = req.headers["x-hub-signature-256"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!verifyMetaSignature(req.rawBody ?? Buffer.alloc(0), signature, metaAppSecret)) {
      return reply.code(401).send();
    }

    // Pre-launch production diagnostic (temporary, redacted): a signature-valid webhook that
    // reaches this point can still legitimately carry zero actionable messages (a Meta status
    // callback, a read-receipt event, ...) -- this shape summary is logged BEFORE parsing so a
    // silently-empty result is always distinguishable from "never reached this route at all".
    // Never logs the raw payload, phone numbers, or message text -- only counts/shapes.
    const rawPayload = req.body as { object?: unknown; entry?: unknown } | undefined;
    const entryArray = Array.isArray(rawPayload?.entry) ? (rawPayload!.entry as unknown[]) : [];
    const fields = new Set<string>();
    let changeCount = 0;
    let hasValue = false;
    let hasMessages = false;
    let messagesCount = 0;
    for (const entry of entryArray) {
      const changes = Array.isArray((entry as { changes?: unknown })?.changes) ? ((entry as { changes: unknown[] }).changes) : [];
      changeCount += changes.length;
      for (const change of changes) {
        const c = change as { field?: unknown; value?: { messages?: unknown } };
        if (typeof c.field === "string") fields.add(c.field);
        if (c.value !== undefined) hasValue = true;
        if (Array.isArray(c.value?.messages)) {
          hasMessages = true;
          messagesCount += c.value.messages.length;
        }
      }
    }
    app.log.info(
      {
        webhookObject: typeof rawPayload?.object === "string" ? rawPayload.object : undefined,
        entryCount: entryArray.length,
        changeCount,
        fields: [...fields],
        hasValue,
        hasMessages,
        messagesCount,
      },
      "whatsapp webhook received",
    );

    // Signature-valid payloads that don't match our expected message shape (e.g. Meta status
    // callbacks) are legitimate deliveries we simply don't act on yet -- ack, don't error.
    const parserResult = extractWhatsAppMessages(req.body);
    const messages = parserResult ?? [];
    if (parserResult === null) {
      app.log.warn({ ignoredReason: "payload did not match the expected webhook envelope shape" }, "whatsapp webhook ignored: unparseable envelope");
    } else if (messages.length === 0) {
      app.log.warn({ hasMessages, ignoredReason: hasMessages ? "messages array present but no entry matched the parser's message shape" : "no messages array in this delivery (e.g. a status callback)" }, "whatsapp webhook ignored: no messages");
    }

    for (const message of messages) {
      if (message.kind === "unsupported") {
        app.log.warn({ messageIdLast8: message.providerMessageId.slice(-8), messageType: message.messageType, ignoredReason: "unsupported message type" }, "whatsapp webhook ignored: unsupported message type");
        continue;
      }
      app.log.info(
        { messageIdLast8: message.providerMessageId.slice(-8), fromLast4: message.phoneRaw.slice(-4), messageType: "text" },
        "whatsapp webhook parsed inbound message",
      );
      await handleInboundWhatsAppText(
        { leads: leadsRepo, conversations: conversationsRepo, messages: messagesRepo, leadService, messaging, logger: app.log, qualificationHandler, bookingHandler, cancellationHandler, rescheduleHandler, reactivationHandler, pastBookedRecoveryHandler, appointments: appointmentsRepo },
        message,
      );
    }

    return reply.code(200).send({ received: true });
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "VALIDATION_ERROR", details: error.flatten() });
    if (error instanceof LeadNotFoundError) return reply.code(404).send({ error: "LEAD_NOT_FOUND", leadId: error.leadId });
    if (error instanceof InvalidLeadTransitionError) return reply.code(409).send({ error: "INVALID_LEAD_TRANSITION", from: error.from, to: error.to });
    if (error instanceof SlotUnavailableError) return reply.code(409).send({ error: "SLOT_UNAVAILABLE" });
    if (error instanceof IdempotencyConflictError) return reply.code(409).send({ error: "IDEMPOTENCY_CONFLICT" });
    if (error instanceof CalendarProviderError) { app.log.error(error); return reply.code(502).send({ error: "CALENDAR_PROVIDER_ERROR" }); }
    app.log.error(error);
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  });

  return app;
}
