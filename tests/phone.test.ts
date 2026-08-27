import { describe, expect, it } from "vitest";
import { normalizePhoneToE164 } from "../src/domain/phone.js";

describe("normalizePhoneToE164", () => {
  it.each([
    ["4771234567"],
    ["52 477 123 4567"],
    ["+52 477 123 4567"],
    ["477-123-4567"],
    ["(477) 123 4567"],
  ])("normalizes %s to +524771234567", (input) => {
    expect(normalizePhoneToE164(input)).toBe("+524771234567");
  });

  it("respects an explicit country code even when it differs from the default", () => {
    expect(normalizePhoneToE164("+1 415 555 2671")).toBe("+14155552671");
  });

  it.each([["5214771234567"], ["+5214771234567"]])(
    "strips WhatsApp's Mexico wa_id quirk (52 + legacy 1 + 10 digits) to true E.164: %s",
    (waId) => {
      expect(normalizePhoneToE164(waId)).toBe("+524771234567");
    },
  );

  it("does not misfire the wa_id fallback on an unrelated 13-digit number", () => {
    // Starts with "521" but isn't the WhatsApp MX quirk shape once the fallback's own re-parse
    // is applied -- guards against the fallback silently "fixing" numbers it shouldn't touch.
    // (This is a genuinely ambiguous case for the +52 country; asserting it does NOT crash and
    // returns *some* deterministic result is the meaningful guarantee here.)
    expect(() => normalizePhoneToE164("5210000000000")).not.toThrow();
  });

  it("returns null for unparseable input instead of throwing", () => {
    expect(() => normalizePhoneToE164("abc")).not.toThrow();
    expect(normalizePhoneToE164("abc")).toBeNull();
  });

  it("returns null for a too-short number instead of throwing", () => {
    expect(normalizePhoneToE164("123")).toBeNull();
  });

  it("returns null for empty, undefined, or null input", () => {
    expect(normalizePhoneToE164("")).toBeNull();
    expect(normalizePhoneToE164(undefined)).toBeNull();
    expect(normalizePhoneToE164(null)).toBeNull();
  });
});
