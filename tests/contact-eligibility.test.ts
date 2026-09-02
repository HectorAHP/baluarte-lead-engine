import { describe, it, expect } from "vitest";
import { canProactivelyContactLead } from "../src/domain/contact-eligibility.js";

describe("canProactivelyContactLead", () => {
  it("consentContact=true -> eligible", () => {
    expect(canProactivelyContactLead({ consentContact: true })).toBe(true);
  });

  it("consentContact=false -> not eligible", () => {
    expect(canProactivelyContactLead({ consentContact: false })).toBe(false);
  });

  it("consentContact missing -> not eligible (fails closed)", () => {
    expect(canProactivelyContactLead({})).toBe(false);
  });

  it("is independent of scoreClass -- a HOT lead without consent stays HOT, just not eligible", () => {
    // canProactivelyContactLead never reads score/scoreClass at all -- this test documents that
    // contract rather than exercising a code path that could regress silently.
    const hotLeadNoConsent = { consentContact: false };
    expect(canProactivelyContactLead(hotLeadNoConsent)).toBe(false);
  });
});
