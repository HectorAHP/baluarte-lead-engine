import { describe, expect, it } from "vitest";
import { buildTestApp, TEST_REMINDER_RUNNER_SECRET, TEST_ADMIN_API_TOKEN } from "./helpers/test-app.js";

describe("Fase 7B item 2/46/52 -- baseline security headers on every response", () => {
  it("a plain GET /health carries every expected header", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
    expect(res.headers["strict-transport-security"]).not.toContain("includeSubDomains");
    expect(res.headers["strict-transport-security"]).not.toContain("preload");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["permissions-policy"]).toContain("geolocation=()");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("headers are present even on a 404/error response, not just 200s", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/leads/00000000-0000-0000-0000-000000000000" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });

  it("headers are present on the WhatsApp webhook response too", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("Fase 7B item 6 -- distinct rate limits per route (never one blanket limit)", () => {
  it("each route reports its OWN configured max via x-ratelimit-limit, never a shared/default value", async () => {
    const app = await buildTestApp({ reminderRunnerSecret: TEST_REMINDER_RUNNER_SECRET, adminApiToken: TEST_ADMIN_API_TOKEN });

    const leads = await app.inject({ method: "POST", url: "/api/leads", payload: { phone: "4771230000", privacyAccepted: true, source: "WEB" } });
    const availability = await app.inject({ method: "GET", url: "/api/availability?from=2026-03-01T00:00:00.000Z&to=2026-03-02T00:00:00.000Z" });
    const reminders = await app.inject({ method: "POST", url: "/internal/reminders/run", headers: { authorization: `Bearer ${TEST_REMINDER_RUNNER_SECRET}` } });
    const markCompleted = await app.inject({ method: "POST", url: "/api/appointments/00000000-0000-0000-0000-000000000000/mark-completed", headers: { "x-admin-token": TEST_ADMIN_API_TOKEN } });
    const webhook = await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x" }); // GET isn't rate-limited (only POST is) -- confirms limits are per-route, not per-path

    expect(leads.headers["x-ratelimit-limit"]).toBe("20"); // config.LEADS_RATE_LIMIT_MAX default
    expect(availability.headers["x-ratelimit-limit"]).toBe("60");
    expect(reminders.headers["x-ratelimit-limit"]).toBe("20");
    expect(markCompleted.headers["x-ratelimit-limit"]).toBe("20");
    expect(webhook.headers["x-ratelimit-limit"]).toBeUndefined(); // GET /webhooks/whatsapp has no rate-limit config -- only the POST does
  });

  it("item 9/54: /internal/reminders/run's own rate limit triggers a 429 with the minimal safe shape once exceeded, independent of a valid secret", async () => {
    const app = await buildTestApp({ reminderRunnerSecret: TEST_REMINDER_RUNNER_SECRET });
    let last;
    for (let i = 0; i < 21; i++) {
      last = await app.inject({ method: "POST", url: "/internal/reminders/run", headers: { authorization: `Bearer ${TEST_REMINDER_RUNNER_SECRET}` } });
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.json()).toEqual({ ok: false, error: "rate_limited" });
  });

  it("POST /webhooks/whatsapp has its own generous rate limit (300/min) that never interferes with normal test traffic", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: "{}", headers: { "content-type": "application/json" } });
    expect(res.headers["x-ratelimit-limit"]).toBe("300");
  });

  it("POST /api/appointments has its own rate limit (30/min), independent of /api/leads'", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/appointments", headers: { "idempotency-key": "test-key-1" }, payload: {} });
    expect(res.headers["x-ratelimit-limit"]).toBe("30");
  });
});

describe("Fase 7B item 7/9 -- body limits on Fase 7A internal/admin endpoints", () => {
  it("a payload over 2048 bytes on /internal/reminders/run is rejected before the auth check even runs", async () => {
    const app = await buildTestApp({ reminderRunnerSecret: TEST_REMINDER_RUNNER_SECRET });
    const res = await app.inject({
      method: "POST", url: "/internal/reminders/run",
      headers: { authorization: `Bearer ${TEST_REMINDER_RUNNER_SECRET}`, "content-type": "application/json" },
      payload: JSON.stringify({ junk: "x".repeat(3000) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it("a payload over 2048 bytes on mark-completed is rejected", async () => {
    const app = await buildTestApp({ adminApiToken: TEST_ADMIN_API_TOKEN });
    const res = await app.inject({
      method: "POST", url: "/api/appointments/00000000-0000-0000-0000-000000000000/mark-completed",
      headers: { "x-admin-token": TEST_ADMIN_API_TOKEN, "content-type": "application/json" },
      payload: JSON.stringify({ junk: "x".repeat(3000) }),
    });
    expect(res.statusCode).toBe(413);
  });
});
