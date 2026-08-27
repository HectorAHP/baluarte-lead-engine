import { buildApp, type AppDependencies } from "../../src/app.js";
import {
  InMemoryLeadRepository, InMemoryAppointmentRepository, InMemoryBookingAttemptRepository,
  InMemoryLeadScoreRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryOfferedSlotRepository, InMemorySlotOfferClaimRepository,
} from "../../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../../src/infrastructure/fake-calendar.js";
import { FakeMessagingProvider } from "../../src/infrastructure/fake-messaging-provider.js";

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

export function buildTestApp(overrides: Partial<AppDependencies> = {}) {
  return buildApp({
    leadsRepo: new InMemoryLeadRepository(),
    appointmentsRepo: new InMemoryAppointmentRepository(),
    bookingAttemptsRepo: new InMemoryBookingAttemptRepository(),
    leadScoresRepo: new InMemoryLeadScoreRepository(),
    conversationsRepo: new InMemoryConversationRepository(),
    messagesRepo: new InMemoryMessageRepository(),
    offeredSlotsRepo: new InMemoryOfferedSlotRepository(),
    slotOfferClaimsRepo: new InMemorySlotOfferClaimRepository(),
    calendar: new FakeCalendarProvider(),
    messaging: new FakeMessagingProvider(),
    whatsappVerifyToken: TEST_WHATSAPP_VERIFY_TOKEN,
    metaAppSecret: TEST_META_APP_SECRET,
    // Explicit false defaults, not left to buildApp()'s own config fallback: this repo's .env
    // can (and during real Phase 3B/3C validation, does) set these to true. Every test must get
    // a deterministic false unless it explicitly asks for true -- the exact bug this project hit
    // once already with QUALIFICATION_ENGINE_ENABLED, now guarded here for both flags so no
    // future test can reintroduce it by omission.
    qualificationEngineEnabled: false,
    whatsappBookingEnabled: false,
    ...overrides,
  });
}
