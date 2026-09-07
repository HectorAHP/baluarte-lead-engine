import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { trustedProxyFn } from "../src/domain/trusted-proxy.js";

/**
 * Fase 7G -- real Fastify instances (not mocks) proving exactly how `req.ip` resolves under each
 * trustProxy configuration considered for this fix, and reproducing the real risk (a shared
 * bucket behind Render's proxy) before and after the fix. Simulates the confirmed real topology:
 *   client (may prepend fabricated entries) -> Cloudflare edge (appends its own observation)
 *   -> Render's load balancer (our socket peer, `request.socket.remoteAddress`)
 */
const RENDER_LB_IP = "10.201.5.12"; // simulated internal Render address -- our socket peer, constant for every request in reality
const CLOUDFLARE_EDGE_IP = "172.68.10.5"; // a genuine Cloudflare address (172.64.0.0/13)
const CLIENT_A_IP = "203.0.113.10";
const CLIENT_B_IP = "203.0.113.20";
const SPOOFED_PREFIX = "1.2.3.4, 5.6.7.8"; // fabricated entries a malicious client could prepend

async function makeIpProbeApp(trustProxyOption: unknown) {
  const app = Fastify({ trustProxy: trustProxyOption as never });
  app.get("/ip", async (req) => ({ ip: req.ip, ips: req.ips }));
  await app.ready();
  return app;
}

async function getIp(app: Awaited<ReturnType<typeof makeIpProbeApp>>, xff: string | undefined, remoteAddress: string) {
  const res = await app.inject({ method: "GET", url: "/ip", headers: xff ? { "x-forwarded-for": xff } : {}, remoteAddress });
  return res.json() as { ip: string; ips: string[] };
}

describe("Fase 7G item 3 -- req.ip with trustProxy=false (the ORIGINAL, unfixed configuration)", () => {
  it("caso A: X-Forwarded-For is completely ignored -- req.ip is always the raw socket peer (Render's own load balancer)", async () => {
    const app = await makeIpProbeApp(undefined); // no trustProxy at all -- the historical default
    const result = await getIp(app, `${SPOOFED_PREFIX}, ${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    expect(result.ip).toBe(RENDER_LB_IP);
    await app.close();
  });

  it("confirms the exact risk: two DIFFERENT real clients resolve to the SAME req.ip behind the unfixed config", async () => {
    const app = await makeIpProbeApp(undefined);
    const a = await getIp(app, `${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    const b = await getIp(app, `${CLIENT_B_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    expect(a.ip).toBe(b.ip); // both collapse to Render's own LB address -- a shared bucket
    await app.close();
  });
});

describe("Fase 7G item 4 -- trustProxy: true (rejected -- trusts an arbitrary client-controlled chain)", () => {
  it("req.ip becomes the LEFTMOST entry -- entirely client-controlled, confirming why this option is never used", async () => {
    const app = await makeIpProbeApp(true);
    const result = await getIp(app, `${SPOOFED_PREFIX}, ${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    expect(result.ip).toBe("1.2.3.4"); // the client's own fabricated first entry, not the real client
    await app.close();
  });
});

describe("Fase 7G item 4 -- trustProxy: 1 / trustProxy: 2 (numeric) -- confirmed silent no-op in this Fastify version", () => {
  it("trustProxy: 1 behaves identically to trustProxy=false -- NOT a 1-hop trust mechanism here", async () => {
    const app = await makeIpProbeApp(1);
    const result = await getIp(app, `${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    expect(result.ip).toBe(RENDER_LB_IP); // falls back to the raw socket, exactly like no trustProxy at all
    await app.close();
  });

  it("trustProxy: 2 ALSO behaves identically to trustProxy=false -- confirms this is not merely trustProxy:1 being too shallow", async () => {
    const app = await makeIpProbeApp(2);
    const result = await getIp(app, `${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    expect(result.ip).toBe(RENDER_LB_IP);
    await app.close();
  });
});

describe("Fase 7G item 4/5/16/17 -- the actual fix: trustedProxyFn (hop 0 always + Cloudflare-only beyond it)", () => {
  it("resolves the genuine client IP through the real 2-hop chain, ignoring fabricated entries the client prepended", async () => {
    const app = await makeIpProbeApp(trustedProxyFn);
    const result = await getIp(app, `${SPOOFED_PREFIX}, ${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    expect(result.ip).toBe(CLIENT_A_IP); // the real client, never the fabricated prefix
    await app.close();
  });

  it("item 16 (global bucket reproduction, AFTER the fix): two different real clients now resolve to two DIFFERENT req.ip values", async () => {
    const app = await makeIpProbeApp(trustedProxyFn);
    const a = await getIp(app, `${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    const b = await getIp(app, `${CLIENT_B_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    expect(a.ip).not.toBe(b.ip);
    expect(a.ip).toBe(CLIENT_A_IP);
    expect(b.ip).toBe(CLIENT_B_IP);
    await app.close();
  });

  it("the SAME real client always resolves to the SAME req.ip, regardless of what fabricated prefix they add or remove", async () => {
    const app = await makeIpProbeApp(trustedProxyFn);
    const withSpoofedPrefix = await getIp(app, `9.9.9.9, ${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    const withoutAnyPrefix = await getIp(app, `${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    expect(withSpoofedPrefix.ip).toBe(withoutAnyPrefix.ip);
    expect(withSpoofedPrefix.ip).toBe(CLIENT_A_IP);
    await app.close();
  });

  it("item 17 (spoofing test): a client cannot change their effective req.ip by varying ONLY the fabricated prefix -- it can never escape its own rate-limit bucket this way", async () => {
    const app = await makeIpProbeApp(trustedProxyFn);
    const attempt1 = await getIp(app, `1.1.1.1, ${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    const attempt2 = await getIp(app, `2.2.2.2, 3.3.3.3, 4.4.4.4, ${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    expect(attempt1.ip).toBe(attempt2.ip); // identical resolved key regardless of the fabricated prefix's length/content
    expect(attempt1.ip).toBe(CLIENT_A_IP);
    await app.close();
  });

  it("without any X-Forwarded-For at all (a direct hit, no proxy involved), req.ip is simply the socket peer", async () => {
    const app = await makeIpProbeApp(trustedProxyFn);
    const result = await getIp(app, undefined, CLIENT_A_IP);
    expect(result.ip).toBe(CLIENT_A_IP);
    await app.close();
  });
});

describe("Fase 7G item 16 -- reproduces the risk end-to-end through a REAL @fastify/rate-limit bucket, before and after the fix", () => {
  async function makeRateLimitedApp(trustProxyOption: unknown) {
    const app = Fastify({ trustProxy: trustProxyOption as never });
    await app.register(rateLimit, { global: false, keyGenerator: (req) => req.ip });
    app.get("/probe", { config: { rateLimit: { max: 1, timeWindow: 60_000 } } }, async () => ({ ok: true }));
    await app.ready();
    return app;
  }
  async function hit(app: Awaited<ReturnType<typeof makeRateLimitedApp>>, xff: string, remoteAddress: string) {
    return app.inject({ method: "GET", url: "/probe", headers: { "x-forwarded-for": xff }, remoteAddress });
  }

  it("BEFORE the fix (no trustProxy): two DIFFERENT real clients share one bucket -- the second one is wrongly 429'd by the first one's traffic", async () => {
    const app = await makeRateLimitedApp(undefined);
    const first = await hit(app, `${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    const second = await hit(app, `${CLIENT_B_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP); // a genuinely different client
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429); // wrongly limited -- this is the confirmed risk
    await app.close();
  });

  it("AFTER the fix (trustedProxyFn): two different real clients get independent buckets -- both succeed", async () => {
    const app = await makeRateLimitedApp(trustedProxyFn);
    const a = await hit(app, `${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    const b = await hit(app, `${CLIENT_B_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200); // no longer sharing a bucket
    await app.close();
  });

  it("AFTER the fix, the SAME real client is still correctly rate-limited on their own repeated traffic, spoofed prefix notwithstanding", async () => {
    const app = await makeRateLimitedApp(trustedProxyFn);
    const first = await hit(app, `${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP);
    const second = await hit(app, `9.9.9.9, ${CLIENT_A_IP}, ${CLOUDFLARE_EDGE_IP}`, RENDER_LB_IP); // same real client, different fabricated prefix
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429); // correctly limited -- spoofing the prefix never lets them escape their own bucket
    await app.close();
  });
});
