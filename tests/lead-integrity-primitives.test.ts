import { describe, it, expect } from "vitest";
import { computeLeadIntegrityScore, LEAD_INTEGRITY_VERSION } from "../src/domain/lead-integrity-score.js";
import { isHoneypotTriggered } from "../src/domain/honeypot.js";
import { isSuspiciouslyFastSubmission } from "../src/domain/form-timing.js";

describe("lead-integrity-score", () => {
  it("item 38: version is always lead_integrity_v1", () => {
    expect(computeLeadIntegrityScore({}).version).toBe(LEAD_INTEGRITY_VERSION);
    expect(computeLeadIntegrityScore({}).version).toBe("lead_integrity_v1");
  });

  it("item 18: is a pure technical score, clamped [0,100], independent of any fiscal/lifecycle field", () => {
    const result = computeLeadIntegrityScore({ emailQuality: "VALID", phoneQuality: "VERIFIED" });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("honeypot alone is decisive -- never merely 'one weak signal among many'", () => {
    const clean = computeLeadIntegrityScore({ emailQuality: "VALID", phoneQuality: "VERIFIED" });
    const withHoneypot = computeLeadIntegrityScore({ emailQuality: "VALID", phoneQuality: "VERIFIED", honeypotTriggered: true });
    expect(withHoneypot.score).toBeLessThan(clean.score);
    expect(withHoneypot.score).toBeLessThanOrEqual(10);
  });

  it("item 38: a single weak negative signal never tanks the score to reject-level on its own", () => {
    const { score } = computeLeadIntegrityScore({ emailQuality: "DISPOSABLE" });
    expect(score).toBeGreaterThan(20); // baseline 50 - 15 = 35, still comfortably non-rejecting
  });

  it("phone VERIFIED scores strictly higher than plain UNVERIFIED, all else equal", () => {
    const unverified = computeLeadIntegrityScore({ phoneQuality: "UNVERIFIED" });
    const verified = computeLeadIntegrityScore({ phoneQuality: "VERIFIED" });
    expect(verified.score).toBeGreaterThan(unverified.score);
  });

  it("identityConflict and suspectedAutomation both reduce the score independently", () => {
    const baseline = computeLeadIntegrityScore({});
    expect(computeLeadIntegrityScore({ identityConflict: true }).score).toBeLessThan(baseline.score);
    expect(computeLeadIntegrityScore({ suspectedAutomation: true }).score).toBeLessThan(baseline.score);
  });
});

describe("honeypot", () => {
  it("item 22: a filled honeypot field is detected; empty/absent is not", () => {
    expect(isHoneypotTriggered("some value")).toBe(true);
    expect(isHoneypotTriggered("  ")).toBe(false);
    expect(isHoneypotTriggered("")).toBe(false);
    expect(isHoneypotTriggered(undefined)).toBe(false);
  });
});

describe("form-timing", () => {
  it("item 25/14: a submission completed implausibly fast is flagged", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const submittedFast = new Date("2026-01-01T00:00:00.500Z"); // 500ms
    const submittedNormal = new Date("2026-01-01T00:00:30.000Z"); // 30s
    expect(isSuspiciouslyFastSubmission(start, submittedFast)).toBe(true);
    expect(isSuspiciouslyFastSubmission(start, submittedNormal)).toBe(false);
  });

  it("a submittedAt before formStartedAt (clock skew / forged timestamp) is also flagged", () => {
    const start = new Date("2026-01-01T00:00:10.000Z");
    const submitted = new Date("2026-01-01T00:00:00.000Z");
    expect(isSuspiciouslyFastSubmission(start, submitted)).toBe(true);
  });
});
