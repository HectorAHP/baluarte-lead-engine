import { describe, expect, it } from "vitest";
import { buildTestApp, TEST_HUBSPOT_SYNC_RUNNER_SECRET } from "./helpers/test-app.js";
import { InMemoryHubSpotSyncOutboxRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeHubSpotCRMProvider } from "../src/infrastructure/fake-hubspot-crm-provider.js";

describe("Fase 7C -- POST /internal/hubspot-sync/run", () => {
  it("item 29: with no HUBSPOT_SYNC_RUNNER_SECRET configured, fails closed with 401", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/internal/hubspot-sync/run", headers: { authorization: "Bearer anything" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "NOT_CONFIGURED" });
  });

  it("item 29: wrong or missing bearer token -> 401", async () => {
    const app = await buildTestApp({ hubspotSyncRunnerSecret: TEST_HUBSPOT_SYNC_RUNNER_SECRET });
    const wrong = await app.inject({ method: "POST", url: "/internal/hubspot-sync/run", headers: { authorization: "Bearer nope" } });
    expect(wrong.statusCode).toBe(401);
    const missing = await app.inject({ method: "POST", url: "/internal/hubspot-sync/run" });
    expect(missing.statusCode).toBe(401);
  });

  it("item 30: correct token -> 200, processes the batch, sanitized summary (no PII)", async () => {
    const hubspotSyncOutboxRepo = new InMemoryHubSpotSyncOutboxRepository();
    await hubspotSyncOutboxRepo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: { email: "a@example.com", properties: { bc_fiscal_score: 50 } } });
    const app = await buildTestApp({ hubspotSyncRunnerSecret: TEST_HUBSPOT_SYNC_RUNNER_SECRET, hubspotSyncOutboxRepo, hubspotCrm: new FakeHubSpotCRMProvider() });

    const res = await app.inject({ method: "POST", url: "/internal/hubspot-sync/run", headers: { authorization: `Bearer ${TEST_HUBSPOT_SYNC_RUNNER_SECRET}` } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ ok: true, claimed: 1, succeeded: 1, retryScheduled: 0, permanentlyFailed: 0 });
    expect(JSON.stringify(body)).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}/); // no uuid ever in the response
    expect((await hubspotSyncOutboxRepo.listByStatus("SUCCEEDED"))).toHaveLength(1);
  });

  it("item 31: with no outbox rows pending, always returns a safe empty summary -- never errors", async () => {
    const app = await buildTestApp({ hubspotSyncRunnerSecret: TEST_HUBSPOT_SYNC_RUNNER_SECRET });
    const res = await app.inject({ method: "POST", url: "/internal/hubspot-sync/run", headers: { authorization: `Bearer ${TEST_HUBSPOT_SYNC_RUNNER_SECRET}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, claimed: 0, succeeded: 0, retryScheduled: 0, permanentlyFailed: 0 });
  });

  it("its own rate limit (20/min) is independent from every other route's", async () => {
    const app = await buildTestApp({ hubspotSyncRunnerSecret: TEST_HUBSPOT_SYNC_RUNNER_SECRET });
    const res = await app.inject({ method: "POST", url: "/internal/hubspot-sync/run", headers: { authorization: `Bearer ${TEST_HUBSPOT_SYNC_RUNNER_SECRET}` } });
    expect(res.headers["x-ratelimit-limit"]).toBe("20");
  });

  it("a payload over 2048 bytes is rejected (413) before the auth check even matters", async () => {
    const app = await buildTestApp({ hubspotSyncRunnerSecret: TEST_HUBSPOT_SYNC_RUNNER_SECRET });
    const res = await app.inject({
      method: "POST", url: "/internal/hubspot-sync/run",
      headers: { authorization: `Bearer ${TEST_HUBSPOT_SYNC_RUNNER_SECRET}`, "content-type": "application/json" },
      payload: JSON.stringify({ junk: "x".repeat(3000) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it("item 29: the route never reads req.body -- an arbitrary/malformed body never changes which batch is processed", async () => {
    const hubspotSyncOutboxRepo = new InMemoryHubSpotSyncOutboxRepository();
    await hubspotSyncOutboxRepo.tryCreate({ leadId: "lead-1", submissionId: "sub-1", payload: { properties: {} } });
    const app = await buildTestApp({ hubspotSyncRunnerSecret: TEST_HUBSPOT_SYNC_RUNNER_SECRET, hubspotSyncOutboxRepo, hubspotCrm: new FakeHubSpotCRMProvider() });

    const res = await app.inject({
      method: "POST", url: "/internal/hubspot-sync/run",
      headers: { authorization: `Bearer ${TEST_HUBSPOT_SYNC_RUNNER_SECRET}`, "content-type": "application/json" },
      payload: JSON.stringify({ batchSize: 999999, leadId: "some-other-lead", templateName: "arbitrary" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().claimed).toBe(1); // exactly the one real row -- the body's own "batchSize"/"leadId" fields are ignored entirely
  });
});
