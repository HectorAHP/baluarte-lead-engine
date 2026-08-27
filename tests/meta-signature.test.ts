import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaSignature } from "../src/domain/meta-signature.js";
import { timingSafeEqualStrings } from "../src/domain/timing-safe-compare.js";

const appSecret = "test-app-secret";

describe("verifyMetaSignature", () => {
  it("accepts a correctly computed signature", () => {
    const body = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));
    const digest = createHmac("sha256", appSecret).update(body).digest("hex");
    expect(verifyMetaSignature(body, `sha256=${digest}`, appSecret)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const digest = createHmac("sha256", "wrong-secret").update(body).digest("hex");
    expect(verifyMetaSignature(body, `sha256=${digest}`, appSecret)).toBe(false);
  });

  it("rejects a signature computed over different bytes than the raw body", () => {
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const digest = createHmac("sha256", appSecret).update(Buffer.from(JSON.stringify({ a: 2 }))).digest("hex");
    expect(verifyMetaSignature(body, `sha256=${digest}`, appSecret)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyMetaSignature(Buffer.from("{}"), undefined, appSecret)).toBe(false);
  });

  it("rejects a header missing the sha256= prefix", () => {
    const body = Buffer.from("{}");
    const digest = createHmac("sha256", appSecret).update(body).digest("hex");
    expect(verifyMetaSignature(body, digest, appSecret)).toBe(false);
  });
});

describe("timingSafeEqualStrings", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualStrings("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(timingSafeEqualStrings("abc123", "abc124")).toBe(false);
  });

  it("returns false for different-length strings without throwing", () => {
    expect(() => timingSafeEqualStrings("short", "much-longer-string")).not.toThrow();
    expect(timingSafeEqualStrings("short", "much-longer-string")).toBe(false);
  });
});
