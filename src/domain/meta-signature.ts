import { createHmac } from "node:crypto";
import { timingSafeEqualStrings } from "./timing-safe-compare.js";

/**
 * Verifies Meta's `X-Hub-Signature-256` header (HMAC-SHA256 over the raw request body, hex
 * digest, prefixed "sha256="). Must be computed over the exact raw bytes Meta sent -- not a
 * re-serialization of the parsed JSON, which can byte-differ (whitespace, key order) and would
 * make a genuinely valid signature appear invalid.
 */
export function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  return timingSafeEqualStrings(provided, expected);
}
