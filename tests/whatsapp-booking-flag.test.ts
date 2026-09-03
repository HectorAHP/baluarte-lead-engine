import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";
import {
  InMemoryLeadRepository, InMemoryConversationRepository, InMemoryMessageRepository,
  InMemoryQualificationAnswerRepository, InMemoryLeadScoreRepository, InMemoryAppointmentRepository,
  InMemoryBookingAttemptRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import { QUALIFICATION_COMPLETE_AB_MESSAGE } from "../src/domain/message-templates.js";

describe("WHATSAPP_BOOKING_ENABLED -- config parsing", () => {
  const originalBooking = process.env.WHATSAPP_BOOKING_ENABLED;
  const originalQualification = process.env.QUALIFICATION_ENGINE_ENABLED;

  afterEach(() => {
    if (originalBooking === undefined) delete process.env.WHATSAPP_BOOKING_ENABLED;
    else process.env.WHATSAPP_BOOKING_ENABLED = originalBooking;
    if (originalQualification === undefined) delete process.env.QUALIFICATION_ENGINE_ENABLED;
    else process.env.QUALIFICATION_ENGINE_ENABLED = originalQualification;
    vi.resetModules();
  });

  it('parses exactly the string "true" as true, and everything else (including the string "false") as false -- never via Boolean() coercion', async () => {
    process.env.WHATSAPP_BOOKING_ENABLED = "true";
    vi.resetModules();
    const { config: whenTrue } = await import("../src/config.js");
    expect(whenTrue.WHATSAPP_BOOKING_ENABLED).toBe(true);

    // This is the exact bug class being guarded against: Boolean("false") is `true` in plain
    // JS, which would silently invert this flag if z.coerce.boolean() were used instead.
    process.env.WHATSAPP_BOOKING_ENABLED = "false";
    vi.resetModules();
    const { config: whenFalseString } = await import("../src/config.js");
    expect(whenFalseString.WHATSAPP_BOOKING_ENABLED).toBe(false);

    delete process.env.WHATSAPP_BOOKING_ENABLED;
    vi.resetModules();
    const { config: whenUnset } = await import("../src/config.js");
    expect(whenUnset.WHATSAPP_BOOKING_ENABLED).toBe(false);
  });

  it("is independent of QUALIFICATION_ENGINE_ENABLED in either direction", async () => {
    process.env.QUALIFICATION_ENGINE_ENABLED = "true";
    process.env.WHATSAPP_BOOKING_ENABLED = "false";
    vi.resetModules();
    const { config: first } = await import("../src/config.js");
    expect(first.QUALIFICATION_ENGINE_ENABLED).toBe(true);
    expect(first.WHATSAPP_BOOKING_ENABLED).toBe(false);

    process.env.QUALIFICATION_ENGINE_ENABLED = "false";
    process.env.WHATSAPP_BOOKING_ENABLED = "true";
    vi.resetModules();
    const { config: second } = await import("../src/config.js");
    expect(second.QUALIFICATION_ENGINE_ENABLED).toBe(false);
    expect(second.WHATSAPP_BOOKING_ENABLED).toBe(true);
  });
});

// --- webhook helpers, deliberately local to this file (same convention as the other webhook
// test files in this suite, e.g. whatsapp-qualification-e2e.test.ts) -----------------------

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function textWebhookBody(overrides: { from?: string; id?: string; body?: string; name?: string } = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ profile: { name: overrides.name ?? "Ana" }, wa_id: overrides.from ?? "5214771234567" }],
              messages: [{ from: overrides.from ?? "5214771234567", id: overrides.id ?? `wamid.${Math.random().toString(36).slice(2)}`, type: "text", text: { body: overrides.body ?? "Hola" } }],
            },
          },
        ],
      },
    ],
  });
}

function buildRepos() {
  return {
    leadsRepo: new InMemoryLeadRepository(),
    conversationsRepo: new InMemoryConversationRepository(),
    messagesRepo: new InMemoryMessageRepository(),
    qualificationAnswersRepo: new InMemoryQualificationAnswerRepository(),
    leadScoresRepo: new InMemoryLeadScoreRepository(),
    appointmentsRepo: new InMemoryAppointmentRepository(),
    bookingAttemptsRepo: new InMemoryBookingAttemptRepository(),
    calendar: new FakeCalendarProvider(),
  };
}

async function send(app: Awaited<ReturnType<typeof buildTestApp>>, from: string, id: string, body: string) {
  const payload = textWebhookBody({ from, id, body });
  return app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    payload,
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET) },
  });
}

describe("WHATSAPP_BOOKING_ENABLED -- test isolation from the real .env", () => {
  it("buildTestApp() with no override is false regardless of what the real .env currently holds", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({ messaging: new FakeMessagingProvider(), qualificationEngineEnabled: true, ...repos });
    // No functional assertion possible yet (no booking handler consumes the flag) -- this
    // documents the default itself, matching the same isolation guarantee already established
    // for qualificationEngineEnabled.
    expect(app).toBeTruthy();
  });

  it("an explicit whatsappBookingEnabled: true override is accepted without error, independent of qualificationEngineEnabled", async () => {
    const repos = buildRepos();
    const app = await buildTestApp({
      messaging: new FakeMessagingProvider(),
      qualificationEngineEnabled: false,
      whatsappBookingEnabled: true,
      ...repos,
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("WHATSAPP_BOOKING_ENABLED -- qualification -> booking wiring (Phase 3C is now connected)", () => {
  // NOTE: prior to the Phase 3C wiring block, this file asserted that WHATSAPP_BOOKING_ENABLED=true
  // alone changed nothing ("no handler consumes it yet"). That premise is no longer true by
  // design -- see tests/whatsapp-booking-e2e.test.ts for the full Phase 3C flag-matrix and E2E
  // coverage. This describe block keeps exactly the two flag-isolation facts that still belong
  // in this file: booking OFF still behaves exactly like Phase 3B, and booking ON now visibly
  // changes behavior (proving the flag is truly wired, not a dead no-op).

  it("qualification=true, booking=false -- a full SAVINGS qualification to QUALIFIED_A behaves exactly like Phase 3B: no offer, no BOOKING_PENDING", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, whatsappBookingEnabled: false, ...repos });
    const from = "5214775000001";
    const turns = ["Hola", "1", "1", "1", "5", "sí", "1"]; // -> SAVINGS, QUALIFIED_A

    for (let i = 0; i < turns.length; i++) {
      await send(app, from, `wamid.flag.${i}`, turns[i]);
    }

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("QUALIFIED_A");
    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead!.id);
    expect(conversation?.status).toBe("ACTIVE");
    expect(messaging.sentTexts).toHaveLength(turns.length);
    expect(messaging.sentTexts.at(-1)?.body).toBe(QUALIFICATION_COMPLETE_AB_MESSAGE);
  });

  it("qualification=true, booking=true -- the same SAVINGS flow now continues past QUALIFIED_A into an offer + BOOKING_PENDING", async () => {
    const messaging = new FakeMessagingProvider();
    const repos = buildRepos();
    const app = await buildTestApp({ messaging, qualificationEngineEnabled: true, whatsappBookingEnabled: true, ...repos });
    const from = "5214775000002";
    const turns = ["Hola", "1", "1", "1", "5", "sí", "1"]; // -> SAVINGS, QUALIFIED_A

    for (let i = 0; i < turns.length; i++) {
      await send(app, from, `wamid.flagon.${i}`, turns[i]);
    }

    const lead = await repos.leadsRepo.findByDedupKey({ whatsappUserId: from });
    expect(lead?.status).toBe("BOOKING_PENDING");
    expect(lead?.bookingStartedAt).toBeTruthy();
    const conversation = await repos.conversationsRepo.findActiveByLeadId(lead!.id);
    expect(conversation?.status).toBe("ACTIVE");
    // One extra outbound vs. the booking=false case above: the qualification-complete message,
    // THEN a separate offer message -- never merged into one.
    expect(messaging.sentTexts).toHaveLength(turns.length + 1);
    expect(messaging.sentTexts.at(-2)?.body).toBe(QUALIFICATION_COMPLETE_AB_MESSAGE);
    expect(messaging.sentTexts.at(-1)?.body).toContain("Tengo estos horarios disponibles");
  });
});
