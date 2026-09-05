/**
 * Fase 7B -- email technical-quality classification. Deliberately separate from fiscal_v1 and
 * from HOT/WARM/NURTURE (see docs/PHASE4-DESIGN.md's own "keep domains separate" principle,
 * restated for Fase 7B): nothing here ever reads a Lead's score/scoreClass/status, and nothing in
 * scoring ever reads emailQuality. Pure, side-effect-free -- no network calls (DNS validation is a
 * SEPARATE, optional, async concern -- see checkEmailDomainExists below and
 * infrastructure/dns-email-domain-checker.ts).
 *
 * States (item 28/30 of the Fase 7B spec):
 *  - INVALID: fails syntax validation outright.
 *  - DISPOSABLE: syntactically valid, but the domain is a known temporary-email provider.
 *  - UNVERIFIED: syntactically valid, non-disposable, and no DNS check was performed (or one was
 *    attempted and failed/timed out -- fail-open, see checkEmailDomainExists) -- the default,
 *    honest state for "looks fine, nothing confirmed".
 *  - VALID: syntactically valid, non-disposable, AND a DNS check positively confirmed the domain
 *    can receive mail (MX, or A/AAAA fallback). Still NOT the same as "this exact mailbox exists"
 *    (see domainExists vs mailboxExists in checkEmailDomainExists's own doc comment) and NEVER the
 *    same as ownership-verified (see emailVerifiedAt on Lead, a completely separate, future,
 *    confirmation-link-based concept -- Fase 7B spec item 33). A syntactically valid email with no
 *    DNS check ever run stays UNVERIFIED, not VALID -- "valid" here is deliberately the STRONGER
 *    claim, earned only by a real domain check, never the default.
 */
export type EmailQuality = "VALID" | "INVALID" | "DISPOSABLE" | "UNVERIFIED";

/** Trim + lowercase -- the one normalization every email comparison/storage in this codebase
 * should use (mirrors phone.ts's normalizePhoneToE164 being the one place phone normalization
 * happens). */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// A deliberately hand-rolled, RFC 5322-lite check rather than a single do-everything regex (the
// task's own "no depender solo de regex" instruction) -- local-part and domain are validated as
// two separate, bounded pieces, each with its own explicit rule, rather than one opaque pattern.
const LOCAL_PART_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 §4.5.3.1.3
const MAX_LOCAL_PART_LENGTH = 64; // RFC 5321 §4.5.3.1.1

/**
 * Syntax-only check -- no network access, no DNS. Rejects: missing/multiple "@", empty local-part
 * or domain, a local-part or domain exceeding their RFC-bound lengths, a domain with fewer than
 * two labels (no TLD) or any empty label (consecutive dots / leading-trailing dot), a domain label
 * starting or ending with a hyphen, and any character outside each part's allowed set. Accepts
 * everything else -- deliberately permissive beyond these hard rules (this is a technical syntax
 * gate, not a business rule about which domains are "real").
 */
export function isSyntacticallyValidEmail(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const email = raw.trim();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false;

  const atIndex = email.indexOf("@");
  if (atIndex <= 0 || atIndex !== email.lastIndexOf("@")) return false; // exactly one "@", not at position 0

  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  if (localPart.length === 0 || localPart.length > MAX_LOCAL_PART_LENGTH) return false;
  if (!LOCAL_PART_PATTERN.test(localPart)) return false;
  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) return false;

  if (domain.length === 0) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false; // require at least one dot -- a TLD is mandatory
  if (labels.some((label) => label.length === 0)) return false; // no empty label (leading/trailing/consecutive dots)
  if (!labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))) return false;
  const tld = labels[labels.length - 1];
  if (tld.length < 2 || /^\d+$/.test(tld)) return false; // reject an all-numeric "TLD" (e.g. a bare IP-looking suffix)

  return true;
}

/**
 * Maintainable, configurable denylist (Fase 7B spec item 31: "NO hardcodear una lista enorme en
 * lógica de dominio") -- a small, curated starter set of the most common disposable-email
 * providers, meant to be extended via config (see EMAIL_DISPOSABLE_DOMAINS_EXTRA in config.ts),
 * never grown inline here. A future phase can replace this with a real provider adapter (e.g. a
 * maintained third-party API/package) without changing this function's signature.
 */
export const DEFAULT_DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "yopmail.com",
  "temp-mail.org",
  "tempmail.com",
  "10minutemail.com",
  "10minutemail.net",
  "throwawaymail.com",
  "trashmail.com",
  "fakeinbox.com",
  "getnada.com",
  "sharklasers.com",
  "dispostable.com",
  "maildrop.cc",
]);

export function isDisposableEmailDomain(domain: string, denylist: ReadonlySet<string> = DEFAULT_DISPOSABLE_EMAIL_DOMAINS): boolean {
  return denylist.has(domain.trim().toLowerCase());
}

export interface EmailQualityOptions {
  /** Extra domains merged with DEFAULT_DISPOSABLE_EMAIL_DOMAINS -- see config.ts's
   * EMAIL_DISPOSABLE_DOMAINS_EXTRA. */
  disposableDomains?: ReadonlySet<string>;
  /** Fase 7B spec item 31: disposable domains are tagged, not necessarily rejected outright --
   * `checkDisposable: false` (e.g. when DISPOSABLE_EMAIL_CHECK_ENABLED is off) skips this check
   * entirely, so an otherwise-syntactically-valid disposable address classifies as VALID/UNVERIFIED
   * like any other, never DISPOSABLE. */
  checkDisposable?: boolean;
  /** Set true only when a DNS check (see checkEmailDomainExists) positively confirmed the domain
   * can receive mail -- promotes an otherwise-UNVERIFIED result to VALID. Never set this from
   * anything other than a real DNS lookup result. */
  domainConfirmedByDns?: boolean;
}

/** Pure classification -- see the EmailQuality doc comment above for what each state means. Never
 * throws, never performs I/O. */
export function classifyEmailQuality(raw: string, options: EmailQualityOptions = {}): EmailQuality {
  if (!isSyntacticallyValidEmail(raw)) return "INVALID";
  const domain = normalizeEmail(raw).split("@")[1];
  if (options.checkDisposable !== false && isDisposableEmailDomain(domain, options.disposableDomains)) return "DISPOSABLE";
  return options.domainConfirmedByDns ? "VALID" : "UNVERIFIED";
}
