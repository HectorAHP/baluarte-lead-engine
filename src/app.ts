import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { config, hasGoogleCalendarCredentials, hasWhatsAppCredentials } from "./config.js";
import {
  InMemoryLeadRepository, InMemoryAppointmentRepository, InMemoryBookingAttemptRepository,
  InMemoryLeadScoreRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryQualificationAnswerRepository,
} from "./infrastructure/memory-repositories.js";
import { SupabaseLeadRepository } from "./infrastructure/supabase-lead-repository.js";
import { SupabaseAppointmentRepository } from "./infrastructure/supabase-appointment-repository.js";
import { SupabaseBookingAttemptRepository } from "./infrastructure/supabase-booking-attempt-repository.js";
import { SupabaseLeadScoreRepository } from "./infrastructure/supabase-lead-score-repository.js";
import { SupabaseConversationRepository } from "./infrastructure/supabase-conversation-repository.js";
import { SupabaseMessageRepository } from "./infrastructure/supabase-message-repository.js";
import { SupabaseQualificationAnswerRepository } from "./infrastructure/supabase-qualification-answer-repository.js";
import { createSupabaseClient } from "./infrastructure/supabase-client.js";
import { FakeCalendarProvider } from "./infrastructure/fake-calendar.js";
import { GoogleCalendarProvider } from "./infrastructure/google-calendar-provider.js";
import { FakeMessagingProvider } from "./infrastructure/fake-messaging-provider.js";
import { MetaWhatsAppProvider } from "./infrastructure/meta-whatsapp-provider.js";
import { LeadService, AppointmentService } from "./application/services.js";
import { handleInboundWhatsAppText } from "./application/whatsapp-inbound-service.js";
import { WhatsAppQualificationHandler } from "./application/whatsapp-qualification-handler.js";
import { extractWhatsAppMessages } from "./domain/whatsapp-webhook-payload.js";
import { verifyMetaSignature } from "./domain/meta-signature.js";
import { timingSafeEqualStrings } from "./domain/timing-safe-compare.js";
import {
  LeadNotFoundError, InvalidLeadTransitionError, SlotUnavailableError,
  IdempotencyConflictError, CalendarProviderError,
} from "./domain/errors.js";
import type {
  LeadRepository, AppointmentRepository, BookingAttemptRepository, LeadScoreRepository,
  ConversationRepository, MessageRepository, QualificationAnswerRepository, CalendarProvider, MessagingProvider,
} from "./application/ports.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface AppDependencies {
  leadsRepo?: LeadRepository;
  appointmentsRepo?: AppointmentRepository;
  bookingAttemptsRepo?: BookingAttemptRepository;
  leadScoresRepo?: LeadScoreRepository;
  conversationsRepo?: ConversationRepository;
  messagesRepo?: MessageRepository;
  qualificationAnswersRepo?: QualificationAnswerRepository;
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

  const supabaseClient = config.SUPABASE_URL && config.SUPABASE_SECRET_KEY ? createSupabaseClient() : null;
  const leadsRepo = overrides.leadsRepo ?? (supabaseClient ? new SupabaseLeadRepository(supabaseClient) : new InMemoryLeadRepository());
  const appointmentsRepo = overrides.appointmentsRepo ?? (supabaseClient ? new SupabaseAppointmentRepository(supabaseClient) : new InMemoryAppointmentRepository());
  const bookingAttemptsRepo = overrides.bookingAttemptsRepo ?? (supabaseClient ? new SupabaseBookingAttemptRepository(supabaseClient) : new InMemoryBookingAttemptRepository());
  const leadScoresRepo = overrides.leadScoresRepo ?? (supabaseClient ? new SupabaseLeadScoreRepository(supabaseClient) : new InMemoryLeadScoreRepository());
  const conversationsRepo = overrides.conversationsRepo ?? (supabaseClient ? new SupabaseConversationRepository(supabaseClient) : new InMemoryConversationRepository());
  const messagesRepo = overrides.messagesRepo ?? (supabaseClient ? new SupabaseMessageRepository(supabaseClient) : new InMemoryMessageRepository());
  const qualificationAnswersRepo = overrides.qualificationAnswersRepo ?? (supabaseClient ? new SupabaseQualificationAnswerRepository(supabaseClient) : new InMemoryQualificationAnswerRepository());
  const calendar = overrides.calendar ?? (hasGoogleCalendarCredentials ? new GoogleCalendarProvider() : new FakeCalendarProvider());
  const messaging = overrides.messaging ?? (hasWhatsAppCredentials ? new MetaWhatsAppProvider() : new FakeMessagingProvider());

  const leadService = new LeadService(leadsRepo, leadScoresRepo);
  const appointmentService = new AppointmentService(calendar, appointmentsRepo, bookingAttemptsRepo, leadsRepo, app.log);

  // "fake" only when a test/dev caller explicitly passed a FakeMessagingProvider override --
  // NOT whenever the resolved `messaging` instance happens to be one, since the normal
  // production fallback (missing credentials) also constructs a FakeMessagingProvider. That
  // fallback case must report "unconfigured", not "fake".
  const whatsappCredentialsConfigured = overrides.whatsappCredentialsConfigured ?? hasWhatsAppCredentials;
  const whatsappProvider: "meta" | "fake" | "unconfigured" =
    overrides.messaging instanceof FakeMessagingProvider ? "fake" : whatsappCredentialsConfigured ? "meta" : "unconfigured";

  // Phase 3B feature flag. false (the default) keeps WhatsApp behavior byte-for-byte identical
  // to Phase 2 -- handleInboundWhatsAppText never receives a qualificationHandler, so its new
  // conditional branches are simply never taken. Enable with QUALIFICATION_ENGINE_ENABLED=true
  // in .env for a controlled test (see the Phase 3B report for the exact steps).
  const qualificationEngineEnabled = overrides.qualificationEngineEnabled ?? config.QUALIFICATION_ENGINE_ENABLED;
  const qualificationHandler = qualificationEngineEnabled
    ? new WhatsAppQualificationHandler({
        leads: leadsRepo,
        conversations: conversationsRepo,
        messages: messagesRepo,
        leadScores: leadScoresRepo,
        qualificationAnswers: qualificationAnswersRepo,
        leadService,
        messaging,
        logger: app.log,
      })
    : undefined;
  if (qualificationEngineEnabled) {
    app.log.info({ qualificationEngineEnabled }, "Phase 3B qualification engine is ENABLED for WhatsApp inbound");
  }

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
    calendarProvider: hasGoogleCalendarCredentials ? "google" : "fake",
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

    // Signature-valid payloads that don't match our expected message shape (e.g. Meta status
    // callbacks) are legitimate deliveries we simply don't act on yet -- ack, don't error.
    const messages = extractWhatsAppMessages(req.body) ?? [];

    for (const message of messages) {
      if (message.kind === "unsupported") {
        app.log.warn({ providerMessageId: message.providerMessageId, messageType: message.messageType }, "Ignoring unsupported WhatsApp message type");
        continue;
      }
      await handleInboundWhatsAppText(
        { leads: leadsRepo, conversations: conversationsRepo, messages: messagesRepo, leadService, messaging, logger: app.log, qualificationHandler },
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
