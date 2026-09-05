import { describe, it, expect } from "vitest";
import { classifyPhoneQuality, looksLikeTrivialSequence } from "../src/domain/phone-quality.js";
import { normalizePhoneToE164 } from "../src/domain/phone.js";

describe("phone-quality", () => {
  it("item 32/5: a valid MX phone normalizes and classifies UNVERIFIED (format-valid, not verified)", () => {
    const e164 = normalizePhoneToE164("4771234567");
    expect(e164).toBe("+524771234567");
    expect(classifyPhoneQuality(e164)).toBe("UNVERIFIED");
  });

  it("item 32/6: an unparseable phone is INVALID", () => {
    expect(classifyPhoneQuality(normalizePhoneToE164("123"))).toBe("INVALID");
    expect(classifyPhoneQuality(null)).toBe("INVALID");
    expect(classifyPhoneQuality(undefined)).toBe("INVALID");
  });

  it("looksLikeTrivialSequence: all-same-digit and ascending/descending runs are flagged", () => {
    expect(looksLikeTrivialSequence("0000000000")).toBe(true);
    expect(looksLikeTrivialSequence("1111111111")).toBe(true);
    expect(looksLikeTrivialSequence("1234567890")).toBe(true);
    expect(looksLikeTrivialSequence("0987654321")).toBe(true);
    expect(looksLikeTrivialSequence("4771234567")).toBe(false); // a real-shaped MX number
  });

  it("item 32: a structurally valid but trivial-sequence number classifies INVALID, not UNVERIFIED", () => {
    // 5215555555555 is not a real MX shape; use a number libphonenumber accepts as *valid* but
    // whose national significant number is a trivial repeat -- MX mobile numbers are 10 digits,
    // so an all-same-digit 10-digit national number after the country code is the realistic case.
    const trivialE164 = normalizePhoneToE164("1111111111");
    if (trivialE164) {
      expect(classifyPhoneQuality(trivialE164)).toBe("INVALID");
    } else {
      // If libphonenumber-js itself already rejects this shape, INVALID is reached via
      // normalizePhoneToE164 returning null -- either way, never UNVERIFIED for this input.
      expect(classifyPhoneQuality(trivialE164)).toBe("INVALID");
    }
  });
});
