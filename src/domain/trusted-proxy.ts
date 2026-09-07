import proxyAddr from "@fastify/proxy-addr";

/**
 * Fase 7G -- trustProxy hardening. Full audit trail lives in docs/security/FASE7G-TRUST-PROXY.md;
 * this file is the single source of truth for the actual trust decision Fastify uses to resolve
 * `req.ip`/`req.ips`.
 *
 * CONFIRMED TOPOLOGY (Render, verified against Render's own published article + community
 * engineering statements -- see the doc above for exact citations; NOT formal per-header spec,
 * explicitly flagged as such): all inbound traffic to a Render web service passes through
 * Cloudflare's edge network first, then Render's own load balancer, before reaching this
 * container. That means our process's OWN socket peer (`request.socket.remoteAddress`, hop 0 in
 * proxy-addr's indexing) is Render's internal load balancer -- never Cloudflare, never the real
 * client -- and the genuine client IP (when present) sits one hop further back inside
 * X-Forwarded-For, appended by Cloudflare's edge.
 *
 * CONFIRMED EMPIRICALLY (this exact installed Fastify version, 5.12.1): a NUMERIC `trustProxy`
 * value (e.g. `1` or `2`) is NOT a hop-count trust mechanism here -- Fastify's own
 * lib/request.js deliberately treats any number as `function () { return false }` ("Hop-count-
 * only trust cannot validate the immediate peer. Fail closed so direct clients cannot spoof
 * X-Forwarded-* values by supplying enough hops.") This makes `trustProxy: 1` (the Fase 7G spec's
 * own default hypothesis) a SILENT NO-OP in this codebase's actual dependency tree -- verified by
 * a real Fastify instance in this repo's own tests (see tests/trust-proxy-fastify.test.ts), not
 * merely by reading the changelog. `trustProxy: true` was also verified to trust the ENTIRE
 * X-Forwarded-For chain, including entries a client can freely fabricate -- confirmed unsafe by
 * the same test file, never used here.
 *
 * DESIGN: a custom trust FUNCTION (the only remaining safe option), matching proxy-addr's
 * `(addr, i) => boolean` contract:
 *  - `i === 0` (the socket peer, Render's own load balancer): ALWAYS trusted. This isn't a
 *    security decision so much as an unavoidable fact -- it's literally how the TCP connection
 *    reached this process; there is no header to falsify at this layer.
 *  - Every hop beyond that is trusted ONLY while its address matches Cloudflare's own published
 *    IP ranges (CLOUDFLARE_IP_RANGES below). The walk stops at the first address that is NOT a
 *    Cloudflare address -- which, given the real topology above, is exactly the genuine client
 *    IP Cloudflare itself observed, and becomes `req.ip`.
 *
 * WHY NOT trustProxy:true / a plain CIDR-only list: `true` trusts every hop unconditionally,
 * including ones a client can freely inject (see CONFIRMED EMPIRICALLY above -- this was the
 * actual failure mode measured). A CIDR-only list (no special-casing for i===0) would ALSO fail
 * here: Render's own load balancer IP is not itself a Cloudflare address, so a Cloudflare-only
 * CIDR list would immediately reject hop 0 and fall back to the raw socket address every time --
 * silently reproducing the exact bug this fix closes. The function form is what makes "always
 * trust the socket, but only Cloudflare beyond it" expressible at all.
 *
 * SECURITY PROPERTY (verified in tests/trust-proxy-fastify.test.ts): a client cannot change
 * `req.ip` by fabricating extra X-Forwarded-For entries in front of what Cloudflare appends --
 * the walk always stops at the first non-Cloudflare address, so anything the client prepends
 * further left is never reached. A client that somehow reaches this container WITHOUT passing
 * through Cloudflare (e.g. a direct hit bypassing the intended edge) can only ever make `req.ip`
 * equal to their own literal connecting address or a single self-declared header value -- never a
 * longer fabricated chain, since the walk still stops at the first non-Cloudflare hop.
 *
 * MAINTENANCE: Cloudflare's published ranges change rarely but do change. Source of truth:
 * https://www.cloudflare.com/ips-v4/ and https://www.cloudflare.com/ips-v6/ (fetched and embedded
 * here as of Fase 7G / 2026-09-07). Re-verify against those URLs periodically; this list is NOT
 * fetched at runtime (a network dependency on every single request is not an acceptable
 * trade-off for a list that changes on the order of years, not requests).
 */
export const CLOUDFLARE_IP_RANGES: readonly string[] = [
  // IPv4 -- https://www.cloudflare.com/ips-v4/
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  // IPv6 -- https://www.cloudflare.com/ips-v6/
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

/** Reuses proxy-addr's own CIDR/IP parsing (the exact same library Fastify itself uses internally
 * for req.ip resolution) rather than a second, hand-rolled IPv4/IPv6 matcher that could drift out
 * of sync with how Fastify actually parses addresses. */
const isCloudflareAddress = proxyAddr.compile([...CLOUDFLARE_IP_RANGES]);

/**
 * The actual `trustProxy` function passed to Fastify's constructor. See this file's own doc
 * comment above for the full rationale. `hopIndex` is proxy-addr's own convention: 0 is the
 * socket's own remoteAddress, 1 is the rightmost (closest) X-Forwarded-For entry, and so on
 * walking left/further back in the chain.
 */
export function trustedProxyFn(address: string, hopIndex: number): boolean {
  if (hopIndex === 0) return true;
  // The second argument (`i`) is part of proxy-addr's general trust-function signature but is
  // never consulted by a CIDR/IP-list-compiled predicate like isCloudflareAddress -- passed as 0
  // purely to satisfy that signature, not because it means anything here.
  return isCloudflareAddress(address, 0);
}
