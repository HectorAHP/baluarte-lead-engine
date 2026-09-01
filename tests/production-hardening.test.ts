import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers/test-app.js";
import { InMemoryProcessedEventRepository } from "../src/infrastructure/memory-repositories.js";

/**
 * Production hardening for POST /api/leads: CORS allowlist, rate limiting, body/string/number
 * limits, Idempotency-Key validation, and processed_events namespace safety. Complements
 * web-leads-route.test.ts (create/dedupe/idempotency/consent/attribution/logging/lifecycle),
 * which is NOT duplicated here.
 */

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Juan",
    phone: "4771234567",
    email: "juan@example.com",
    source: "WEB_FISCAL_CALCULATOR",
    privacyAccepted: true,
    ...overrides,
  };
}

describe("CORS allowlist", () => {
  it("1. accepts the configured production Baluarte origin", async () => {
    const app = await buildTestApp({ corsAllowedOrigins: ["https://baluartecapital.com.mx", "https://www.baluartecapital.com.mx"] });
    const res = await app.inject({ method: "POST", url: "/api/leads", headers: { origin: "https://baluartecapital.com.mx" }, payload: basePayload() });
    expect(res.headers["access-control-allow-origin"]).toBe("https://baluartecapital.com.mx");
    expect(res.statusCode).toBe(201); // the request itself succeeds -- CORS only governs whether a BROWSER may read the response
  });

  it("2. omits Access-Control-Allow-Origin for an origin not on the allowlist (browser will refuse to read the response)", async () => {
    const app = await buildTestApp({ corsAllowedOrigins: ["https://baluartecapital.com.mx"] });
    const res = await app.inject({ method: "POST", url: "/api/leads", headers: { origin: "https://evil.example.com" }, payload: basePayload() });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("server-to-server callers with no Origin header at all (e.g. a future backend integration) are never blocked by CORS", async () => {
    const app = await buildTestApp({ corsAllowedOrigins: ["https://baluartecapital.com.mx"] });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload() }); // no origin header
    expect(res.statusCode).toBe(201);
  });

  it("the WhatsApp webhook (server-to-server, no Origin header) is unaffected by the allowlist", async () => {
    const app = await buildTestApp({ corsAllowedOrigins: ["https://baluartecapital.com.mx"] });
    const res = await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=abc123" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("abc123");
  });
});

describe("Rate limiting on POST /api/leads", () => {
  it("4. allows requests within the configured limit, then returns 429 with the minimal safe shape once exceeded", async () => {
    const app = await buildTestApp({ leadsRateLimitMax: 2, leadsRateLimitWindowMs: 60_000 });
    const first = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ phone: "4771111111", email: "a1@example.com" }) });
    const second = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ phone: "4772222222", email: "a2@example.com" }) });
    const third = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ phone: "4773333333", email: "a3@example.com" }) });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201); // different phone/email -- a second distinct new lead, within the limit
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ ok: false, error: "rate_limited" });
  });

  it("a different route (GET /api/leads/:id) is never rate-limited -- opt-in is per-route, not global", async () => {
    const app = await buildTestApp({ leadsRateLimitMax: 1, leadsRateLimitWindowMs: 60_000 });
    await app.inject({ method: "POST", url: "/api/leads", payload: basePayload() }); // consumes the one allowed POST
    const res = await app.inject({ method: "GET", url: "/api/leads/00000000-0000-0000-0000-000000000000" });
    expect(res.statusCode).toBe(404); // not 429 -- this route never opted into rate limiting
  });
});

describe("Body size and field-length limits", () => {
  it("5. a payload larger than the route's bodyLimit is rejected, not processed", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/leads",
      payload: basePayload({ notes: "x".repeat(50_000) }), // notes itself is capped at 4000 by Zod, but this exercises the raw bodyLimit (24_000 bytes) before Zod ever runs
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ ok: false, error: "payload_too_large" });
  });

  it("6a. a firstName far beyond the 100-char limit is rejected with 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ firstName: "A".repeat(500) }) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("6b. a fiscalCalculator.monthlyIncome above the plausible ceiling is rejected with 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/leads",
      payload: basePayload({
        fiscalCalculator: {
          monthlyIncome: 999_999_999,
          annualContribution: 0,
          deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
          calculation: { annualIncome: 0, pprDeductionLimit: 0, effectivePprContribution: 0, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 0, estimatedTaxBenefitMax: 0 },
        },
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("6c. a negative deduction is rejected with 400 (input validation, not a fiscal rule)", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/leads",
      payload: basePayload({
        fiscalCalculator: {
          monthlyIncome: 20000,
          annualContribution: 10000,
          deductions: { medicalExpenses: -500, tuition: 0, mortgageInterest: 0, other: 0 },
          calculation: { annualIncome: 240000, pprDeductionLimit: 24000, effectivePprContribution: 10000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 1000, estimatedTaxBenefitMax: 1500 },
        },
      }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Idempotency-Key validation", () => {
  it("7a. a too-short Idempotency-Key is rejected with 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": "x" }, payload: basePayload() });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("7b. an oversized Idempotency-Key is rejected with 400", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": "k".repeat(500) }, payload: basePayload() });
    expect(res.statusCode).toBe(400);
  });

  it("a well-formed UUID Idempotency-Key is accepted", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/leads", headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" }, payload: basePayload() });
    expect(res.statusCode).toBe(201);
  });
});

describe("processed_events provider namespace safety", () => {
  it("6. the SAME event_id under two DIFFERENT providers never collides -- confirms the real constraint is unique(provider, event_id), not unique(event_id) alone", async () => {
    const repo = new InMemoryProcessedEventRepository();
    const a = await repo.tryCreate({ provider: "web_lead_capture", eventId: "shared-id-123" });
    const b = await repo.tryCreate({ provider: "some_other_future_provider", eventId: "shared-id-123" });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull(); // would be null (collision) if the constraint were event_id-only
  });

  it("the SAME (provider, event_id) pair collides on the second attempt, as intended", async () => {
    const repo = new InMemoryProcessedEventRepository();
    const a = await repo.tryCreate({ provider: "web_lead_capture", eventId: "dup-456" });
    const b = await repo.tryCreate({ provider: "web_lead_capture", eventId: "dup-456" });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });
});

describe("Consent behavior (section 8 of this task)", () => {
  it("consentContact=true, once given, is never revoked by a later submission that leaves it false/absent", async () => {
    const app = await buildTestApp();
    const first = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ phone: "4779990001", email: "consent@example.com", consentContact: true }) });
    const second = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ phone: "4779990001", email: "consent@example.com", consentContact: false }) });
    expect(second.json().leadId).toBe(first.json().leadId);
    const lookup = await app.inject({ method: "GET", url: `/api/leads/${first.json().leadId}` });
    expect(lookup.json().consentContact).toBe(true); // NOT flipped back to false
  });

  it("privacyAcceptedAt is set on first acceptance and never overwritten by a later submission's timestamp", async () => {
    const app = await buildTestApp();
    const first = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ phone: "4779990002", email: "privacy@example.com" }) });
    const firstAcceptedAt = (await app.inject({ method: "GET", url: `/api/leads/${first.json().leadId}` })).json().privacyAcceptedAt;
    expect(firstAcceptedAt).toBeTruthy();

    await new Promise((r) => setTimeout(r, 5));
    await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ phone: "4779990002", email: "privacy@example.com" }) });
    const secondAcceptedAt = (await app.inject({ method: "GET", url: `/api/leads/${first.json().leadId}` })).json().privacyAcceptedAt;
    expect(secondAcceptedAt).toBe(firstAcceptedAt); // unchanged
  });
});

describe("11. /health", () => {
  it("still responds correctly after all of this hardening", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: "baluarte-lead-engine" });
  });
});
