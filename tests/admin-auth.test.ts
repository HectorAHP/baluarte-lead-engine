import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Fase 7E.2 -- checkAdminToken (domain/admin-auth.ts), the decision behind every
 * ADMIN_API_TOKEN-protected route (mark-completed, mark-no-show, recover-handoff). Extracted from
 * app.ts's own Fastify-closure-only `requireAdminToken` specifically so its behavior on an
 * unexpected/malformed input can be exercised directly, in isolation -- see the Fase 7E.2 report
 * for why: a real production 500/INTERNAL_ERROR was reported for a request with no
 * `x-admin-token` header, and could not be reproduced locally under any scenario tried. This test
 * file closes the one structural gap the audit found regardless of root cause: NOTHING previously
 * guaranteed this decision itself could never throw.
 */
describe("checkAdminToken", () => {
  it("no configured token at all -> NOT_CONFIGURED, regardless of what was provided", async () => {
    const { checkAdminToken } = await import("../src/domain/admin-auth.js");
    expect(checkAdminToken("anything", undefined)).toBe("NOT_CONFIGURED");
    expect(checkAdminToken(undefined, undefined)).toBe("NOT_CONFIGURED");
    expect(checkAdminToken("", "")).toBe("NOT_CONFIGURED"); // an empty-string configured token is treated as absent, never a valid "empty secret"
  });

  it("item 1/2: no token provided, or the wrong token -> UNAUTHORIZED, never a thrown error", async () => {
    const { checkAdminToken } = await import("../src/domain/admin-auth.js");
    expect(checkAdminToken(undefined, "real-secret")).toBe("UNAUTHORIZED");
    expect(checkAdminToken("", "real-secret")).toBe("UNAUTHORIZED");
    expect(checkAdminToken("wrong", "real-secret")).toBe("UNAUTHORIZED");
  });

  it("the correct token -> OK", async () => {
    const { checkAdminToken } = await import("../src/domain/admin-auth.js");
    expect(checkAdminToken("real-secret", "real-secret")).toBe("OK");
  });

  it("a non-string provided value (defensive -- a raw header value off req.headers is not guaranteed to be a plain string) is coerced to empty, never crashes", async () => {
    const { checkAdminToken } = await import("../src/domain/admin-auth.js");
    expect(checkAdminToken(12345 as unknown, "real-secret")).toBe("UNAUTHORIZED");
    expect(checkAdminToken({} as unknown, "real-secret")).toBe("UNAUTHORIZED");
    expect(checkAdminToken(["a", "b"] as unknown, "real-secret")).toBe("UNAUTHORIZED");
    expect(checkAdminToken(null, "real-secret")).toBe("UNAUTHORIZED");
  });

  // item 8: error handler preserves the intended auth status -- even if the underlying comparison
  // itself throws for some unforeseen reason, checkAdminToken must still resolve to UNAUTHORIZED,
  // never propagate an exception (which upstream would otherwise reach app.setErrorHandler's
  // generic 500 catch-all).
  describe("when the underlying comparison throws unexpectedly", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it("still resolves to UNAUTHORIZED, never throws, never reaches a 500", async () => {
      vi.doMock("../src/domain/timing-safe-compare.js", () => ({
        timingSafeEqualStrings: () => { throw new Error("simulated unexpected failure inside the comparison"); },
      }));
      const { checkAdminToken } = await import("../src/domain/admin-auth.js");

      expect(() => checkAdminToken("anything", "real-secret")).not.toThrow();
      expect(checkAdminToken("anything", "real-secret")).toBe("UNAUTHORIZED");

      vi.doUnmock("../src/domain/timing-safe-compare.js");
    });
  });
});
