import { describe, it, expect } from "vitest";
import { isSyntacticallyValidEmail, classifyEmailQuality, normalizeEmail, isDisposableEmailDomain } from "../src/domain/email-quality.js";

describe("email-quality", () => {
  it("item 27 (a): a syntactically valid email is accepted", () => {
    expect(isSyntacticallyValidEmail("hector@baluartecapital.com.mx")).toBe(true);
    expect(isSyntacticallyValidEmail("juan.perez+test@gmail.com")).toBe(true);
  });

  it("item 27 (b): an invalid email is rejected", () => {
    expect(isSyntacticallyValidEmail("not-an-email")).toBe(false);
    expect(isSyntacticallyValidEmail("missing-domain@")).toBe(false);
    expect(isSyntacticallyValidEmail("@missing-local.com")).toBe(false);
    expect(isSyntacticallyValidEmail("two@at@signs.com")).toBe(false);
    expect(isSyntacticallyValidEmail("no-tld@localhost")).toBe(false);
    expect(isSyntacticallyValidEmail("trailing.dot.@example.com")).toBe(false);
    expect(isSyntacticallyValidEmail("double..dot@example.com")).toBe(false);
    expect(isSyntacticallyValidEmail("")).toBe(false);
    expect(isSyntacticallyValidEmail("a@b..com")).toBe(false);
    expect(isSyntacticallyValidEmail("a@-startshyphen.com")).toBe(false);
    expect(isSyntacticallyValidEmail("a@example.123")).toBe(false); // all-numeric TLD rejected
  });

  it("rejects absurdly long local-part/overall length", () => {
    const longLocal = "a".repeat(65) + "@example.com";
    expect(isSyntacticallyValidEmail(longLocal)).toBe(false);
    const longOverall = "a@" + "b".repeat(250) + ".com";
    expect(isSyntacticallyValidEmail(longOverall)).toBe(false);
  });

  it("normalizeEmail trims and lowercases", () => {
    expect(normalizeEmail("  Hector@Example.COM  ")).toBe("hector@example.com");
  });

  it("item 29: a disposable domain is detected against the default denylist", () => {
    expect(isDisposableEmailDomain("mailinator.com")).toBe(true);
    expect(isDisposableEmailDomain("MAILINATOR.COM")).toBe(true);
    expect(isDisposableEmailDomain("gmail.com")).toBe(false);
  });

  it("item 29 extended: a configurable extra denylist is merged in, never hardcoded", () => {
    expect(isDisposableEmailDomain("example-temp.com")).toBe(false);
    expect(isDisposableEmailDomain("example-temp.com", new Set(["example-temp.com"]))).toBe(true);
  });

  it("item 30: classifyEmailQuality states -- INVALID/DISPOSABLE/UNVERIFIED/VALID", () => {
    expect(classifyEmailQuality("not-an-email")).toBe("INVALID");
    expect(classifyEmailQuality("a@mailinator.com", { checkDisposable: true })).toBe("DISPOSABLE");
    expect(classifyEmailQuality("a@mailinator.com", { checkDisposable: false })).toBe("UNVERIFIED"); // DISPOSABLE_EMAIL_CHECK_ENABLED=false
    expect(classifyEmailQuality("hector@baluartecapital.com.mx")).toBe("UNVERIFIED"); // no DNS check run -- never silently VALID
    expect(classifyEmailQuality("hector@baluartecapital.com.mx", { domainConfirmedByDns: true })).toBe("VALID");
  });
});
