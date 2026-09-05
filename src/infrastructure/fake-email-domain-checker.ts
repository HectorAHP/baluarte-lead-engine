import type { EmailDomainChecker } from "../application/ports.js";

/** Test double -- canned, per-domain results, defaulting to `null` (unknown/fail-open) for any
 * domain not explicitly configured. Never performs real DNS I/O. */
export class FakeEmailDomainChecker implements EmailDomainChecker {
  constructor(private readonly results: Record<string, boolean | null> = {}) {}

  async domainHasMailExchanger(domain: string): Promise<boolean | null> {
    return domain in this.results ? this.results[domain] : null;
  }
}
