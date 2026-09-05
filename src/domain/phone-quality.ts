import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Fase 7B -- phone technical-quality classification. Reuses normalizePhoneToE164 (phone.ts) for
 * normalization -- never a second, divergent parsing path. Deliberately separate from
 * fiscal_v1/HOT-WARM-NURTURE, same principle as email-quality.ts.
 *
 * States (item 33/35 of the Fase 7B spec):
 *  - INVALID: fails libphonenumber-js validation, OR passes it but matches a known-trivial/fake
 *    digit pattern (a structurally valid-shaped number is still obviously fake -- see
 *    looksLikeTrivialSequence below).
 *  - UNVERIFIED: passes validation and isn't a trivial sequence -- the default for any freshly
 *    submitted number. Format-valid is NOT the same as ownership -- see the class doc comment on
 *    VERIFIED.
 *  - VERIFIED: set EXCLUSIVELY by the WhatsApp passive-verification pathway (Fase 7B spec item 34
 *    -- see whatsapp-inbound-service.ts's phone-verification step, gated by
 *    LEAD_INTEGRITY_ENABLED): an inbound WhatsApp message was actually received FROM this exact
 *    E.164 number. This function itself never returns VERIFIED -- it has no channel-inbound
 *    evidence to base that on; VERIFIED is only ever assigned by that separate call site,
 *    documented here so both stay conceptually anchored to the same enum.
 */
export type PhoneQuality = "VALID" | "INVALID" | "UNVERIFIED" | "VERIFIED";

/**
 * Rejects a phone number that is *structurally* valid (correct length, correct country-code
 * shape) but is obviously not a real, dialable number: every digit the same (0000000000,
 * 1111111111, ...), or a trivial strictly-ascending/descending run (1234567890, 0987654321). Only
 * ever applied to the NATIONAL SIGNIFICANT NUMBER (never the country code) so "+52" itself never
 * trips this. Deliberately narrow -- a denylist alone (Fase 7B spec item 32: "No usar únicamente
 * una denylist") would need constant maintenance and still miss obvious variants; this pattern
 * check generalizes to any all-same-digit or fully-sequential number regardless of length.
 */
export function looksLikeTrivialSequence(nationalNumber: string): boolean {
  const digits = nationalNumber.replace(/\D/g, "");
  if (digits.length < 6) return false; // too short to meaningfully judge -- let normal validation decide
  if (new Set(digits).size === 1) return true; // all the same digit
  const isAscending = [...digits].every((d, i) => i === 0 || Number(d) === (Number(digits[i - 1]) + 1) % 10);
  const isDescending = [...digits].every((d, i) => i === 0 || Number(d) === (Number(digits[i - 1]) + 9) % 10);
  return isAscending || isDescending;
}

/**
 * Classifies an ALREADY-NORMALIZED E.164 string -- i.e. the output of
 * normalizePhoneToE164(raw), never a second independent parse of the raw input. This is
 * deliberate: normalizePhoneToE164 already carries the WhatsApp wa_id "521..." retry-parse quirk
 * (see phone.ts), so re-parsing the raw string here with a plain parsePhoneNumberFromString call
 * would disagree with it for that exact case and misclassify a real, valid WhatsApp-sourced number
 * as INVALID. `null`/`undefined` (normalizePhoneToE164's own "couldn't parse" result) always
 * classifies as INVALID.
 */
export function classifyPhoneQuality(phoneE164: string | null | undefined): PhoneQuality {
  if (!phoneE164) return "INVALID";
  let parsed;
  try {
    parsed = parsePhoneNumberFromString(phoneE164);
  } catch {
    return "INVALID";
  }
  if (!parsed?.isValid()) return "INVALID";
  if (looksLikeTrivialSequence(parsed.nationalNumber)) return "INVALID";
  return "UNVERIFIED";
}
