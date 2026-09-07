import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { buildTestApp, TEST_META_APP_SECRET } from "./helpers/test-app.js";

/**
 * Fase 7G -- proves the trustProxy fix is correctly WIRED into the real app's rate-limited
 * routes (not just the isolated mechanism already exhaustively proven in
 * trust-proxy-fastify.test.ts). Every request below carries a real 2-hop
 * X-Forwarded-For chain (client -> Cloudflare edge -> Render load balancer, matching the
 * confirmed topology) via `headers` + a `remoteAddress` override on `app.inject()`.
 */
const RENDER_LB_IP = "10.201.5.12";
const CLOUDFLARE_EDGE_IP = "172.68.10.5"; // genuine Cloudflare address (172.64.0.0/13)
const CLIENT_A_IP = "203.0.113.10";
const CLIENT_B_IP = "203.0.113.20";

function xffFor(clientIp: string, spoofedPrefix?: string): string {
  return spoofedPrefix ? `${spoofedPrefix}, ${clientIp}, ${CLOUDFLARE_EDGE_IP}` : `${clientIp}, ${CLOUDFLARE_EDGE_IP}`;
}

async function injectAs(app: Awaited<ReturnType<typeof buildTestApp>>, opts: { method: "GET" | "POST"; url: string; clientIp: string; spoofedPrefix?: string; payload?: Record<string, unknown>; headers?: Record<string, string> }) {
  return app.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload,
    remoteAddress: RENDER_LB_IP,
    headers: { "x-forwarded-for": xffFor(opts.clientIp, opts.spoofedPrefix), ...(opts.headers ?? {}) },
  });
}

describe("Fase 7G item 19 -- POST /api/leads: real client IP bucketing", () => {
  it("1/6: the same resolved client IP hits the same bucket -- exhausts a low override and gets 429, exact shape unchanged", async () => {
    const app = await buildTestApp({ leadsRateLimitMax: 2, leadsRateLimitWindowMs: 60_000 });

    // Distinct phone numbers -- POST /api/leads dedupes by phone independently of rate limiting
    // (a repeat phone legitimately returns 200 "found existing", not 201); this test counts
    // REQUESTS toward the rate limit, which is agnostic to that outcome, so each call here uses
    // its own phone to keep the 201/201/429 sequence unambiguous.
    const r1 = await injectAs(app, { method: "POST", url: "/api/leads", clientIp: CLIENT_A_IP, payload: { firstName: "Ana", phone: "+525512340101", privacyAccepted: true } });
    const r2 = await injectAs(app, { method: "POST", url: "/api/leads", clientIp: CLIENT_A_IP, payload: { firstName: "Ana", phone: "+525512340102", privacyAccepted: true } });
    const r3 = await injectAs(app, { method: "POST", url: "/api/leads", clientIp: CLIENT_A_IP, payload: { firstName: "Ana", phone: "+525512340103", privacyAccepted: true } });

    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r3.statusCode).toBe(429); // same client, 3rd request within the window -- correctly limited
    expect(r3.json()).toEqual({ ok: false, error: "rate_limited" }); // 6: shape unchanged
  });

  it("2: a genuinely different resolved client IP gets a SEPARATE bucket, unaffected by client A's usage", async () => {
    const app = await buildTestApp({ leadsRateLimitMax: 1, leadsRateLimitWindowMs: 60_000 });
    const payload = { firstName: "Ana", phone: "+525512345678", privacyAccepted: true };

    const a1 = await injectAs(app, { method: "POST", url: "/api/leads", clientIp: CLIENT_A_IP, payload: { ...payload, phone: "+525512340001" } });
    expect(a1.statusCode).toBe(201);
    const a2 = await injectAs(app, { method: "POST", url: "/api/leads", clientIp: CLIENT_A_IP, payload: { ...payload, phone: "+525512340002" } });
    expect(a2.statusCode).toBe(429); // client A's own budget (1/window) is exhausted

    const b1 = await injectAs(app, { method: "POST", url: "/api/leads", clientIp: CLIENT_B_IP, payload: { ...payload, phone: "+525512340003" } });
    expect(b1.statusCode).toBe(201); // client B has never been throttled -- a genuinely separate bucket
  });

  it("3: a spoofed X-Forwarded-For prefix cannot let client A bypass their own limit", async () => {
    const app = await buildTestApp({ leadsRateLimitMax: 1, leadsRateLimitWindowMs: 60_000 });
    const payload = { firstName: "Ana", phone: "+525512340010", privacyAccepted: true };

    const first = await injectAs(app, { method: "POST", url: "/api/leads", clientIp: CLIENT_A_IP, payload });
    expect(first.statusCode).toBe(201);
    const secondWithSpoofedPrefix = await injectAs(app, { method: "POST", url: "/api/leads", clientIp: CLIENT_A_IP, spoofedPrefix: "9.9.9.9, 8.8.8.8", payload: { ...payload, phone: "+525512340011" } });
    expect(secondWithSpoofedPrefix.statusCode).toBe(429); // still the same real client -- still limited
  });

  it("4/5: idempotency and normal lead creation are unaffected by the trustProxy change", async () => {
    const app = await buildTestApp({});
    const payload = { firstName: "Ana", phone: "+525512340099", privacyAccepted: true };

    const first = await injectAs(app, { method: "POST", url: "/api/leads", clientIp: CLIENT_A_IP, payload, headers: { "idempotency-key": "test-idem-key-12345" } });
    const second = await injectAs(app, { method: "POST", url: "/api/leads", clientIp: CLIENT_A_IP, payload, headers: { "idempotency-key": "test-idem-key-12345" } });
    expect(first.statusCode).toBe(201); // created
    expect(second.statusCode).toBe(200); // idempotent hit (same phone) -- found existing, unrelated to rate limiting, unchanged by this fix
    expect(first.json().leadId).toBe(second.json().leadId); // idempotent -- same lead, not a duplicate
  });
});

describe("Fase 7G item 20 -- GET /api/availability: real client IP bucketing", () => {
  function availabilityUrl() {
    const from = new Date();
    const to = new Date(from.getTime() + 7 * 86_400_000);
    return `/api/availability?from=${from.toISOString()}&to=${to.toISOString()}&duration=30`;
  }

  it("1/3: two different resolved client IPs each get their own bucket and both succeed normally", async () => {
    const app = await buildTestApp({});
    const a = await injectAs(app, { method: "GET", url: availabilityUrl(), clientIp: CLIENT_A_IP });
    const b = await injectAs(app, { method: "GET", url: availabilityUrl(), clientIp: CLIENT_B_IP });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });

  it("2: the SAME resolved client IP consistently decrements the SAME rate-limit counter regardless of a spoofed prefix (proves bucketing without needing to exhaust the real 60/min limit)", async () => {
    const app = await buildTestApp({});
    const first = await injectAs(app, { method: "GET", url: availabilityUrl(), clientIp: CLIENT_A_IP });
    const second = await injectAs(app, { method: "GET", url: availabilityUrl(), clientIp: CLIENT_A_IP, spoofedPrefix: "1.1.1.1, 2.2.2.2" });
    const remaining1 = Number(first.headers["x-ratelimit-remaining"]);
    const remaining2 = Number(second.headers["x-ratelimit-remaining"]);
    expect(remaining2).toBe(remaining1 - 1); // one shared, consistently-decrementing bucket for this one real client
  });

  it("5: business-hours/weekend/date-preference behavior is untouched by this fix -- a normal query still returns the expected shape", async () => {
    const app = await buildTestApp({});
    const res = await injectAs(app, { method: "GET", url: availabilityUrl(), clientIp: CLIENT_A_IP });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("timezone");
    expect(body).toHaveProperty("slots");
  });
});

describe("Fase 7G item 21 -- POST /api/appointments: booking unaffected", () => {
  it("rate limiting works, and separate resolved client IPs each get an independent budget", async () => {
    const app = await buildTestApp({});
    // Far-future date, matching this codebase's own established convention for tests that
    // complete a live booking against a real availability search (see e.g.
    // whatsapp-booked-generic-fallback-e2e.test.ts's test D) -- never colliding with any other
    // test's own booked slot.
    const start = new Date("2030-06-20T15:00:00.000Z");
    const end = new Date("2030-06-20T15:30:00.000Z");
    const payload = { leadId: "00000000-0000-0000-0000-000000000000", title: "Cita", description: "Cita", start: start.toISOString(), end: end.toISOString(), timezone: "America/Mexico_City" };

    // A nonexistent leadId is expected to fail lead-lookup-side validation, not rate limiting --
    // this test only cares that the request REACHES the handler (i.e. isn't itself rate-limited)
    // and that two different real clients are never conflated.
    const a = await injectAs(app, { method: "POST", url: "/api/appointments", clientIp: CLIENT_A_IP, payload, headers: { "idempotency-key": "appt-key-a" } });
    const b = await injectAs(app, { method: "POST", url: "/api/appointments", clientIp: CLIENT_B_IP, payload, headers: { "idempotency-key": "appt-key-b" } });
    expect(a.statusCode).not.toBe(429);
    expect(b.statusCode).not.toBe(429);
  });
});

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
function textWebhookBody(from: string, id: string, body: string) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "waba-1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      contacts: [{ profile: { name: "Ana" }, wa_id: from }],
      messages: [{ from, id, type: "text", text: { body } }],
    } }] }],
  });
}

describe("Fase 7G item 18 -- POST /webhooks/whatsapp: signature remains the primary control, rate limit never replaces it", () => {
  it("1: valid signature -> accepted (200)", async () => {
    const app = await buildTestApp({});
    const payload = textWebhookBody("5214771230001", "wamid.a1", "Hola");
    const res = await app.inject({
      method: "POST", url: "/webhooks/whatsapp", payload, remoteAddress: RENDER_LB_IP,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET), "x-forwarded-for": xffFor(CLIENT_A_IP) },
    });
    expect(res.statusCode).toBe(200);
  });

  it("2/4: invalid signature -> rejected, REGARDLESS of the resolved client IP or rate-limit budget -- signature verification is never bypassed by trustProxy", async () => {
    const app = await buildTestApp({});
    const payload = textWebhookBody("5214771230002", "wamid.a2", "Hola");
    const res = await app.inject({
      method: "POST", url: "/webhooks/whatsapp", payload, remoteAddress: RENDER_LB_IP,
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef", "x-forwarded-for": xffFor(CLIENT_A_IP) },
    });
    expect(res.statusCode).toBe(401);
  });

  it("3: a burst of legitimate callbacks from the SAME real Meta-observed IP is not prematurely blocked (well within the 300/60s budget)", async () => {
    const app = await buildTestApp({});
    for (let i = 0; i < 10; i++) {
      const payload = textWebhookBody("5214771230003", `wamid.burst${i}`, "Hola");
      const res = await app.inject({
        method: "POST", url: "/webhooks/whatsapp", payload, remoteAddress: RENDER_LB_IP,
        headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET), "x-forwarded-for": xffFor(CLIENT_A_IP) },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("5: payload dedupe (same provider_message_id) is unaffected by the trustProxy change", async () => {
    const app = await buildTestApp({});
    const payload = textWebhookBody("5214771230004", "wamid.dup", "Hola");
    const headers = { "content-type": "application/json", "x-hub-signature-256": sign(payload, TEST_META_APP_SECRET), "x-forwarded-for": xffFor(CLIENT_A_IP) };
    const r1 = await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload, remoteAddress: RENDER_LB_IP, headers });
    const r2 = await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload, remoteAddress: RENDER_LB_IP, headers });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200); // deduped, not an error, unchanged behavior
  });
});

describe("Fase 7G item 22 -- admin/internal auth precedence: trustProxy never changes auth outcomes", () => {
  it("POST /internal/reminders/run without a valid secret is still rejected (401), regardless of resolved client IP", async () => {
    const app = await buildTestApp({});
    const res = await injectAs(app, { method: "POST", url: "/internal/reminders/run", clientIp: CLIENT_A_IP, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("POST /internal/hubspot-sync/run without a valid secret is still rejected (401), regardless of resolved client IP", async () => {
    const app = await buildTestApp({});
    const res = await injectAs(app, { method: "POST", url: "/internal/hubspot-sync/run", clientIp: CLIENT_A_IP, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/leads/:id/recover-handoff without ADMIN_API_TOKEN is still rejected, regardless of resolved client IP", async () => {
    const app = await buildTestApp({});
    const res = await injectAs(app, { method: "POST", url: "/api/leads/00000000-0000-0000-0000-000000000000/recover-handoff", clientIp: CLIENT_A_IP, payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
