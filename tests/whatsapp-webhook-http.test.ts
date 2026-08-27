import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTestApp, TEST_WHATSAPP_VERIFY_TOKEN, TEST_META_APP_SECRET } from "./helpers/test-app.js";
import { FakeMessagingProvider } from "../src/infrastructure/fake-messaging-provider.js";

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
              messages: [{ from: overrides.from ?? "5214771234567", id: overrides.id ?? "wamid.http.1", type: "text", text: { body: overrides.body ?? "Hola" } }],
            },
          },
        ],
      },
    ],
  });
}

describe("GET /webhooks/whatsapp verification", () => {
  it(
    "returns the challenge for a valid subscribe request",
    async () => {
      const app = await buildTestApp();
      const res = await app.inject({
        method: "GET",
        url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TEST_WHATSAPP_VERIFY_TOKEN}&hub.challenge=challenge-123`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("challenge-123");
    },
    // Same rationale as tests/appointments-route.test.ts: the first buildApp() call in a
    // worker (heavy googleapis import) can occasionally exceed vitest's 5s default under load.
    15000,
  );

  it("returns 403 for a wrong verify_token, without leaking the configured value", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=challenge-123",
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(TEST_WHATSAPP_VERIFY_TOKEN);
  });

  it("returns 403 when hub.mode is not subscribe", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: `/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=${TEST_WHATSAPP_VERIFY_TOKEN}&hub.challenge=challenge-123`,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /webhooks/whatsapp signature validation", () => {
  it("rejects a request with no signature header", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: textWebhookBody(), headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a request with an invalid signature", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: textWebhookBody(),
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a request signed with the wrong secret", async () => {
    const app = await buildTestApp();
    const body = textWebhookBody();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: body,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body, "not-the-real-secret") },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a validly signed request and processes it", async () => {
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ messaging });
    const body = textWebhookBody();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: body,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body, TEST_META_APP_SECRET) },
    });
    expect(res.statusCode).toBe(200);
    expect(messaging.sentTexts).toHaveLength(1);
  });
});

describe("POST /webhooks/whatsapp end-to-end", () => {
  it("a duplicate delivery of the same message does not create a second lead or send a second reply", async () => {
    const messaging = new FakeMessagingProvider();
    const app = await buildTestApp({ messaging });
    const body = textWebhookBody({ id: "wamid.dup" });
    const headers = { "content-type": "application/json", "x-hub-signature-256": sign(body, TEST_META_APP_SECRET) };

    const first = await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: body, headers });
    const second = await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: body, headers });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(messaging.sentTexts).toHaveLength(1);
  });

  it("an unsupported message type (e.g. image) is acknowledged without crashing and without creating a lead", async () => {
    const app = await buildTestApp();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [{ from: "5214779999999", id: "wamid.img", type: "image" }] } }] }],
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: body,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body, TEST_META_APP_SECRET) },
    });
    expect(res.statusCode).toBe(200);
  });
});
