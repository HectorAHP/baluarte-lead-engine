import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * WhatsApp's wa_id for Mexican numbers is "52" + "1" + the 10-digit national number (e.g.
 * "5214771234567") -- a legacy WhatsApp Business API quirk. True E.164 for Mexico dropped that
 * extra "1" in the 2019 national numbering reform, so libphonenumber-js correctly rejects the
 * wa_id form as invalid. This strips it before the normal parse, so a wa_id passed straight
 * from a webhook normalizes the same way a human-typed number would.
 */
const WHATSAPP_MX_WA_ID_PATTERN = /^521(\d{10})$/;

/**
 * Normalizes a phone number to E.164. Returns null for anything unparseable or invalid
 * rather than throwing -- phone input from a manual lead form or a WhatsApp payload is
 * untrusted user input, not a programming error.
 */
export function normalizePhoneToE164(raw: string | undefined | null, defaultCountry: "MX" = "MX"): string | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const direct = parsePhoneNumberFromString(raw, defaultCountry);
    if (direct?.isValid()) return direct.number;

    if (defaultCountry === "MX") {
      const digitsOnly = raw.replace(/\D/g, "");
      const waIdMatch = WHATSAPP_MX_WA_ID_PATTERN.exec(digitsOnly);
      if (waIdMatch) {
        const retried = parsePhoneNumberFromString(`52${waIdMatch[1]}`, defaultCountry);
        if (retried?.isValid()) return retried.number;
      }
    }
    return null;
  } catch {
    return null;
  }
}
