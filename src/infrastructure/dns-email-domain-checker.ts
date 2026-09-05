import { resolveMx, resolve4, resolve6 } from "node:dns/promises";
import type { EmailDomainChecker } from "../application/ports.js";

/** Short, bounded -- this check runs synchronously inside a request path (POST /api/leads) and
 * must never make a submission feel slow. See EmailDomainChecker's own doc comment: any timeout
 * or DNS failure resolves to `null` (fail-open), never `false`. */
const DNS_CHECK_TIMEOUT_MS = 1500;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/**
 * Fase 7B -- real DNS-backed domain checker (spec item 32). Checks MX first (the correct signal
 * for "can this domain receive mail"); if a domain has no MX records at all, falls back to A/AAAA
 * (some domains legitimately accept mail on their bare A record per RFC 5321 §5.1, a real,
 * if uncommon, configuration). Any DNS error (NXDOMAIN, timeout, resolver failure, ENOTFOUND) or
 * the bounded timeout above resolves to `null` -- never `false` -- so a transient DNS hiccup can
 * never be misreported as "this domain doesn't exist".
 */
export class DnsEmailDomainChecker implements EmailDomainChecker {
  async domainHasMailExchanger(domain: string): Promise<boolean | null> {
    try {
      const mx = await withTimeout(resolveMx(domain), DNS_CHECK_TIMEOUT_MS);
      if (mx === null) return null; // timed out
      if (mx.length > 0) return true;
    } catch {
      // NXDOMAIN / no MX record / resolver error -- fall through to the A/AAAA fallback below
      // rather than concluding "no mail exchanger" from an MX-specific failure alone.
    }
    try {
      const [a, aaaa] = await Promise.all([
        withTimeout(resolve4(domain).catch(() => []), DNS_CHECK_TIMEOUT_MS),
        withTimeout(resolve6(domain).catch(() => []), DNS_CHECK_TIMEOUT_MS),
      ]);
      if (a === null && aaaa === null) return null; // both timed out
      return (a?.length ?? 0) > 0 || (aaaa?.length ?? 0) > 0;
    } catch {
      return null;
    }
  }
}
