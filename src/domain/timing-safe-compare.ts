import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time-ish string comparison for tokens (webhook verify_token, Meta signature hex).
 * `crypto.timingSafeEqual` requires equal-length buffers, so a length mismatch is handled by
 * comparing a same-length buffer against itself (constant work) before returning false --
 * this avoids the trivially-fast early exit a plain `a === b` would give an attacker probing
 * length, though for a verify_token this is a low-value secret and the practical protection
 * here matters far more for the HMAC signature comparison in the webhook handler.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
