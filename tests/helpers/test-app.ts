import { buildApp, type AppDependencies } from "../../src/app.js";
import {
  InMemoryLeadRepository, InMemoryAppointmentRepository, InMemoryBookingAttemptRepository,
  InMemoryLeadScoreRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
  InMemoryLeadStatusHistoryRepository, InMemoryAppointmentStatusHistoryRepository, InMemoryAppointmentMessageDeliveryRepository,
  InMemoryAppointmentCancellationRepository, InMemoryAppointmentRescheduleRepository,
  InMemoryFiscalLeadScoreRepository,
} from "../../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../../src/infrastructure/fake-calendar.js";
import { FakeMessagingProvider } from "../../src/infrastructure/fake-messaging-provider.js";
import { FakeHubSpotCRMProvider } from "../../src/infrastructure/fake-hubspot-crm-provider.js";
import { FakeEmailDomainChecker } from "../../src/infrastructure/fake-email-domain-checker.js";

/**
 * Always supplies a COMPLETE set of in-memory/fake dependencies -- never a partial override
 * merged with buildApp()'s config-driven defaults. This is deliberate: this repo's .env can
 * (and, in this project's later stages, does) contain real Supabase/Google/Meta credentials.
 * `buildApp()` with any dependency omitted would happily construct a real client for it. Every
 * test in this suite must be structurally incapable of touching a real external service,
 * regardless of what's in the environment -- this helper is what guarantees that.
 */
export const TEST_WHATSAPP_VERIFY_TOKEN = "test-verify-token";
export const TEST_META_APP_SECRET = "test-app-secret";
// Fase 7A -- same "a fixed test value, never buildApp()'s own config fallback" rationale as the
// two constants above.
export const TEST_REMINDER_RUNNER_SECRET = "test-reminder-runner-secret";
export const TEST_ADMIN_API_TOKEN = "test-admin-api-token";

export function buildTestApp(overrides: Partial<AppDependencies> = {}) {
  return buildApp({
    // Phase 4C hardening (item 15): forces buildApp() to NEVER construct a real Supabase client,
    // regardless of what SUPABASE_URL/SUPABASE_SECRET_KEY are set to in this repo's real .env
    // (which does carry live production credentials). Without this, buildApp() would still
    // construct a genuine SupabaseClient object whenever those env vars are set -- harmless by
    // itself (the JS client's constructor makes no network call, and every repo below is already
    // overridden with an InMemory instance so the client is never actually used for a query) but
    // an unnecessary, avoidable exposure and a cosmetic accuracy problem for /health's
    // persistenceProvider field. See tests/test-harness-safety.test.ts for the guard that proves
    // this holds.
    supabaseClient: null,
    leadsRepo: new InMemoryLeadRepository(),
    appointmentsRepo: new InMemoryAppointmentRepository(),
    bookingAttemptsRepo: new InMemoryBookingAttemptRepository(),
    leadScoresRepo: new InMemoryLeadScoreRepository(),
    conversationsRepo: new InMemoryConversationRepository(),
    messagesRepo: new InMemoryMessageRepository(),
    offeredSlotsRepo: new InMemoryOfferedSlotRepository(),
    slotOfferClaimsRepo: new InMemorySlotOfferClaimRepository(),
    // Phase 4A -- same "complete set, never a config-driven default" rationale as every repo
    // above.
    leadStatusHistoryRepo: new InMemoryLeadStatusHistoryRepository(),
    appointmentStatusHistoryRepo: new InMemoryAppointmentStatusHistoryRepository(),
    appointmentMessageDeliveryRepo: new InMemoryAppointmentMessageDeliveryRepository(),
    // Phase 4B/4C -- same "complete set, never a config-driven default" rationale as every repo
    // above. Their absence here was a real gap: buildApp() always constructs
    // AppointmentCancellationService/AppointmentRescheduleService regardless of either feature
    // flag, so with real SUPABASE_URL/SUPABASE_SECRET_KEY set in this repo's .env (which it is),
    // omitting these would have silently pointed a cancellation/reschedule test's Calendar-cleanup
    // bookkeeping at the REAL Supabase appointment_cancellations/appointment_reschedules tables --
    // exactly the failure mode this helper's own doc comment exists to prevent.
    appointmentCancellationsRepo: new InMemoryAppointmentCancellationRepository(),
    appointmentReschedulesRepo: new InMemoryAppointmentRescheduleRepository(),
    // Fase 6A -- same "complete set, never a config-driven default" rationale as every repo above.
    fiscalLeadScoresRepo: new InMemoryFiscalLeadScoreRepository(),
    calendar: new FakeCalendarProvider(),
    messaging: new FakeMessagingProvider(),
    // Fase 6F -- same "complete set, never a config-driven default" rationale as every provider
    // above. This repo's real .env carries no HUBSPOT_PRIVATE_APP_TOKEN today, so buildApp()'s own
    // default would already resolve to `undefined` here -- this explicit override is what keeps
    // that true even if a future .env change adds one, exactly like calendar/messaging above.
    hubspotCrm: new FakeHubSpotCRMProvider(),
    whatsappVerifyToken: TEST_WHATSAPP_VERIFY_TOKEN,
    metaAppSecret: TEST_META_APP_SECRET,
    // Explicit false defaults, not left to buildApp()'s own config fallback: this repo's .env
    // can (and during real Phase 3B/3C validation, does) set these to true. Every test must get
    // a deterministic false unless it explicitly asks for true -- the exact bug this project hit
    // once already with QUALIFICATION_ENGINE_ENABLED, now guarded here for both flags so no
    // future test can reintroduce it by omission.
    qualificationEngineEnabled: false,
    whatsappBookingEnabled: false,
    whatsappCancellationEnabled: false,
    whatsappRescheduleEnabled: false,
    // Fase 7A -- same deterministic-false-unless-asked rationale as every flag above.
    appointmentRemindersEnabled: false,
    postMeetingFollowupEnabled: false,
    appointmentConfirmationEnabled: false,
    // Fase 7A -- undefined by default (not TEST_REMINDER_RUNNER_SECRET/TEST_ADMIN_API_TOKEN): a
    // test must opt IN to a configured secret to exercise the authorized path, so the default
    // posture for every other test is "these endpoints fail closed", exactly production's
    // real posture whenever the corresponding env var is unset.
    reminderRunnerSecret: undefined,
    adminApiToken: undefined,
    // Fase 7B -- same deterministic-false-unless-asked rationale as every flag above. Every
    // computation this whole feature adds (email/phone quality, DNS check, honeypot enforcement,
    // WhatsApp passive verification) stays completely OFF by default in every test, exactly
    // matching production's own real default. emailDomainChecker defaults to a Fake that never
    // performs real DNS I/O -- never buildApp()'s own DnsEmailDomainChecker fallback, same
    // rationale as calendar/messaging/hubspotCrm above.
    leadIntegrityEnabled: false,
    emailDnsValidationEnabled: false,
    disposableEmailCheckEnabled: false,
    honeypotEnabled: false,
    emailDomainChecker: new FakeEmailDomainChecker(),
    ...overrides,
  });
}
