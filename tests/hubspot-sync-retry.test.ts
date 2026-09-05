import { describe, it, expect } from "vitest";
import { computeNextAttemptDelayMs, computeNextAttemptAt, classifyHubSpotSyncError, DEFAULT_MAX_ATTEMPTS } from "../src/domain/hubspot-sync-retry.js";

describe("hubspot-sync-retry -- backoff schedule (Fase 7C spec §9/item 28)", () => {
  it("item 28: matches the exact schedule -- 1min, 5min, 15min, 1h, 6h", () => {
    expect(computeNextAttemptDelayMs(0)).toBe(0); // first attempt -- immediate
    expect(computeNextAttemptDelayMs(1)).toBe(60_000);
    expect(computeNextAttemptDelayMs(2)).toBe(5 * 60_000);
    expect(computeNextAttemptDelayMs(3)).toBe(15 * 60_000);
    expect(computeNextAttemptDelayMs(4)).toBe(60 * 60_000);
    expect(computeNextAttemptDelayMs(5)).toBe(6 * 60 * 60_000);
  });

  it("item 27/28: never exceeds the last schedule entry, never negative, for any attemptCount beyond it", () => {
    expect(computeNextAttemptDelayMs(6)).toBe(6 * 60 * 60_000);
    expect(computeNextAttemptDelayMs(100)).toBe(6 * 60 * 60_000);
    expect(computeNextAttemptDelayMs(-1)).toBe(0);
  });

  it("computeNextAttemptAt adds the delay to the given `now`", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(computeNextAttemptAt(1, now).toISOString()).toBe("2026-01-01T00:01:00.000Z");
    expect(computeNextAttemptAt(4, now).toISOString()).toBe("2026-01-01T01:00:00.000Z");
  });

  it("DEFAULT_MAX_ATTEMPTS is 6 -- not an infinite loop", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(6);
  });
});

describe("hubspot-sync-retry -- error classification (Fase 7C spec §9)", () => {
  it("item 2/3/4: 429, 5xx, and undefined (network/timeout) are RETRYABLE", () => {
    expect(classifyHubSpotSyncError(429)).toBe("RETRYABLE");
    expect(classifyHubSpotSyncError(500)).toBe("RETRYABLE");
    expect(classifyHubSpotSyncError(503)).toBe("RETRYABLE");
    expect(classifyHubSpotSyncError(undefined)).toBe("RETRYABLE");
  });

  it("item 5: schema/payload-invalid and auth failures are PERMANENT", () => {
    expect(classifyHubSpotSyncError(400)).toBe("PERMANENT");
    expect(classifyHubSpotSyncError(401)).toBe("PERMANENT");
    expect(classifyHubSpotSyncError(403)).toBe("PERMANENT");
    expect(classifyHubSpotSyncError(404)).toBe("PERMANENT");
    expect(classifyHubSpotSyncError(422)).toBe("PERMANENT");
  });
});
