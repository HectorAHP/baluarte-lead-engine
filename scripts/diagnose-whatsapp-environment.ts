/**
 * Read-only diagnostic: determines whether the WHATSAPP_PHONE_NUMBER_ID currently configured
 * in .env points at Meta's shared test number or at a registered production number, and
 * whether it actually belongs to the configured WHATSAPP_BUSINESS_ACCOUNT_ID.
 *
 * Makes two GET calls to the Graph API (no messages sent, no repository writes):
 *   1. GET /{PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,code_verification_status
 *   2. GET /{WABA_ID}/phone_numbers?fields=id
 *
 * Never prints: access token, app secret, verify token, full phone number, or full IDs.
 * Only reports a coarse environment classification, a masked number, and a boolean match.
 *
 * Usage: npx tsx scripts/diagnose-whatsapp-environment.ts
 */
import { config } from "../src/config.js";

interface PhoneNumberDetails {
  display_phone_number?: string;
  verified_name?: string;
  code_verification_status?: string;
}

interface WabaPhoneNumbersResponse {
  data?: Array<{ id: string }>;
}

function last4(digitsOnly: string): string {
  return digitsOnly.length >= 4 ? digitsOnly.slice(-4) : digitsOnly;
}

function maskDisplayNumber(display: string | undefined): string {
  if (!display) return "UNKNOWN";
  const digits = display.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  const visible = digits.slice(-4);
  return `${"*".repeat(digits.length - 4)}${visible}`;
}

async function graphGet<T>(path: string, accessToken: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  const url = `https://graph.facebook.com/${config.META_GRAPH_API_VERSION}/${path}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  return { ok: true, data: (await response.json()) as T };
}

async function main(): Promise<void> {
  const missing: string[] = [];
  if (!config.WHATSAPP_ACCESS_TOKEN) missing.push("WHATSAPP_ACCESS_TOKEN");
  if (!config.WHATSAPP_PHONE_NUMBER_ID) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  if (!config.WHATSAPP_BUSINESS_ACCOUNT_ID) missing.push("WHATSAPP_BUSINESS_ACCOUNT_ID");
  if (missing.length > 0) {
    console.log(JSON.stringify({ result: "FAILURE", reason: "MISSING_CONFIG", missing }, null, 2));
    process.exitCode = 1;
    return;
  }

  const accessToken = config.WHATSAPP_ACCESS_TOKEN as string;
  const phoneNumberId = config.WHATSAPP_PHONE_NUMBER_ID as string;
  const wabaId = config.WHATSAPP_BUSINESS_ACCOUNT_ID as string;

  const phoneResult = await graphGet<PhoneNumberDetails>(
    `${phoneNumberId}?fields=display_phone_number,verified_name,code_verification_status`,
    accessToken,
  );
  if (!phoneResult.ok) {
    console.log(
      JSON.stringify({ result: "FAILURE", reason: "PHONE_NUMBER_LOOKUP_FAILED", httpStatus: phoneResult.status }, null, 2),
    );
    process.exitCode = 1;
    return;
  }

  const wabaResult = await graphGet<WabaPhoneNumbersResponse>(`${wabaId}/phone_numbers?fields=id`, accessToken);
  let wabaMatch = false;
  let wabaLookupOk = wabaResult.ok;
  if (wabaResult.ok) {
    wabaMatch = (wabaResult.data.data ?? []).some((entry) => entry.id === phoneNumberId);
  }

  const display = phoneResult.data.display_phone_number;
  const verifiedName = phoneResult.data.verified_name;
  const digits = (display ?? "").replace(/\D/g, "");

  // Meta's shared test numbers are always US numbers issued from the +1 555 range and never
  // carry a verified business name -- production numbers registered to a real WABA do.
  const looksLikeMetaTestNumber = /^1555/.test(digits);
  let environmentDetected: "TEST" | "PRODUCTION" | "UNKNOWN";
  if (looksLikeMetaTestNumber) {
    environmentDetected = "TEST";
  } else if (verifiedName && verifiedName.length > 0) {
    environmentDetected = "PRODUCTION";
  } else {
    environmentDetected = "UNKNOWN";
  }

  console.log(
    JSON.stringify(
      {
        result: "SUCCESS",
        environmentDetected,
        phoneNumberLast4: digits.length > 0 ? last4(digits) : "UNKNOWN",
        displayPhoneNumberMasked: maskDisplayNumber(display),
        wabaMatch,
        wabaLookupOk,
      },
      null,
      2,
    ),
  );
}

await main();
