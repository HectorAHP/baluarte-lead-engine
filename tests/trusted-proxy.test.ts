import { describe, it, expect } from "vitest";
import { trustedProxyFn, CLOUDFLARE_IP_RANGES } from "../src/domain/trusted-proxy.js";

/**
 * Fase 7G -- pure unit tests for the trust-decision function itself (proxy-addr's
 * `(addr, i) => boolean` contract), independent of any real Fastify instance. See
 * tests/trust-proxy-fastify.test.ts for the end-to-end proof against a real Fastify app.
 */
describe("Fase 7G -- trustedProxyFn: hop 0 (the socket peer) is always trusted", () => {
  it("trusts hop 0 regardless of the address value -- it's the direct TCP peer, not a header", () => {
    expect(trustedProxyFn("10.201.5.12", 0)).toBe(true); // a plausible internal Render address
    expect(trustedProxyFn("1.2.3.4", 0)).toBe(true); // even an address with no Cloudflare relation at all
    expect(trustedProxyFn("::1", 0)).toBe(true);
  });
});

describe("Fase 7G -- trustedProxyFn: hops beyond 0 require a genuine Cloudflare address", () => {
  it("trusts a real Cloudflare IPv4 address at hop 1", () => {
    expect(trustedProxyFn("172.68.10.5", 1)).toBe(true); // within 172.64.0.0/13
    expect(trustedProxyFn("104.16.0.1", 1)).toBe(true); // within 104.16.0.0/13
    expect(trustedProxyFn("162.158.0.1", 1)).toBe(true); // within 162.158.0.0/15
  });

  it("trusts a real Cloudflare IPv6 address at hop 1", () => {
    expect(trustedProxyFn("2606:4700::1", 1)).toBe(true);
  });

  it("rejects a non-Cloudflare address at hop 1 -- this is the real client, and the walk must stop here", () => {
    expect(trustedProxyFn("203.0.113.10", 1)).toBe(false); // a real-world client-shaped address
    expect(trustedProxyFn("8.8.8.8", 1)).toBe(false);
  });

  it("rejects a non-Cloudflare address at deeper hops too -- trust is never granted just for being further back in the chain", () => {
    expect(trustedProxyFn("1.2.3.4", 2)).toBe(false);
    expect(trustedProxyFn("5.6.7.8", 5)).toBe(false);
  });

  it("a client-fabricated address that happens to fall inside a Cloudflare range would still be trusted at hop >=1 -- this is expected and safe: it can only ever matter if it sits BEHIND a hop that itself failed the Cloudflare check, and the walk already stopped there first (see trust-proxy-fastify.test.ts's spoofing tests for the full chain-level proof)", () => {
    expect(trustedProxyFn("172.64.0.1", 3)).toBe(true);
  });
});

describe("Fase 7G -- CLOUDFLARE_IP_RANGES sanity", () => {
  it("is non-empty and contains both IPv4 and IPv6 CIDR ranges", () => {
    expect(CLOUDFLARE_IP_RANGES.length).toBeGreaterThan(0);
    expect(CLOUDFLARE_IP_RANGES.some((r) => r.includes("."))).toBe(true);
    expect(CLOUDFLARE_IP_RANGES.some((r) => r.includes(":"))).toBe(true);
    expect(CLOUDFLARE_IP_RANGES.every((r) => /\/\d{1,3}$/.test(r))).toBe(true); // every entry is a real CIDR, never a bare IP
  });
});
