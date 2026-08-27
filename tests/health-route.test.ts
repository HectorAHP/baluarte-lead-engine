import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildTestApp } from "./helpers/test-app.js";
import {
  InMemoryLeadRepository, InMemoryAppointmentRepository, InMemoryBookingAttemptRepository,
  InMemoryLeadScoreRepository, InMemoryConversationRepository, InMemoryMessageRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeCalendarProvider } from "../src/infrastructure/fake-calendar.js";
import type { MessagingProvider, SendMessageResult } from "../src/application/ports.js";

/** A MessagingProvider double that is deliberately NOT FakeMessagingProvider, so the "meta"
 * branch of the whatsappProvider health check can be exercised without constructing a real
 * MetaWhatsAppProvider (whose constructor throws without real credentials). */
class StubMetaLikeProvider implements MessagingProvider {
  async sendText(): Promise<SendMessageResult> {
    return {};
  }
  async sendTemplate(): Promise<SendMessageResult> {
    return {};
  }
  async markRead(): Promise<void> {}
}

describe("GET /health whatsappProvider", () => {
  it('reports "unconfigured" when WhatsApp credentials are not configured', async () => {
    // Explicitly forces whatsappCredentialsConfigured: false rather than relying on the real
    // environment being unconfigured -- this repo's .env now legitimately holds real WhatsApp
    // credentials at later stages of the project, so this test must not depend on that. A
    // non-Fake messaging stub is supplied too, so this never constructs a real
    // MetaWhatsAppProvider regardless of what the real hasWhatsAppCredentials evaluates to.
    const app = await buildApp({
      leadsRepo: new InMemoryLeadRepository(),
      appointmentsRepo: new InMemoryAppointmentRepository(),
      bookingAttemptsRepo: new InMemoryBookingAttemptRepository(),
      leadScoresRepo: new InMemoryLeadScoreRepository(),
      conversationsRepo: new InMemoryConversationRepository(),
      messagesRepo: new InMemoryMessageRepository(),
      calendar: new FakeCalendarProvider(),
      messaging: new StubMetaLikeProvider(),
      whatsappCredentialsConfigured: false,
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().whatsappProvider).toBe("unconfigured");
  });

  it('reports "fake" when the app was explicitly constructed with a FakeMessagingProvider override', async () => {
    const app = await buildTestApp(); // always overrides messaging with FakeMessagingProvider
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().whatsappProvider).toBe("fake");
  });

  it('reports "meta" when WhatsApp credentials are configured, without leaking any credential value', async () => {
    const app = await buildTestApp({
      messaging: new StubMetaLikeProvider(),
      whatsappCredentialsConfigured: true,
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.whatsappProvider).toBe("meta");
    // Nothing beyond the sanitized enum value should ever appear on this route.
    const serialized = res.body;
    expect(serialized).not.toMatch(/access.?token/i);
    expect(serialized).not.toMatch(/phone.?number.?id/i);
    expect(serialized).not.toMatch(/business.?account/i);
    expect(serialized).not.toMatch(/verify.?token/i);
    expect(serialized).not.toMatch(/app.?secret/i);
  });

  it("whatsappProvider is always one of the three allowed values", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(["meta", "fake", "unconfigured"]).toContain(res.json().whatsappProvider);
  });
});
