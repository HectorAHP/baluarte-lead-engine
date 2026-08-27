/**
 * Read-only diagnostic: compares the shape of the recipient identifier used by the failing
 * automated inbound reply (the most recent real WHATSAPP-sourced lead's whatsapp_user_id, i.e.
 * the raw wa_id Meta sent in the webhook) against WHATSAPP_TEST_RECIPIENT, the value that
 * scripts/test-whatsapp-outbound.ts sends successfully.
 *
 * Only a single SELECT against the leads table; no writes, no messages sent.
 *
 * Never prints: access token, app secret, verify token, full phone numbers/IDs. Only lengths,
 * last-4 digits, and a boolean equality check on the *normalized* form.
 *
 * Usage: npx tsx scripts/diagnose-whatsapp-recipient-shape.ts
 */
import { config } from "../src/config.js";
import { createSupabaseClient } from "../src/infrastructure/supabase-client.js";
import { normalizePhoneToE164 } from "../src/domain/phone.js";

function shape(value: string | null | undefined) {
  if (!value) return { present: false as const };
  return {
    present: true as const,
    length: value.length,
    last4: value.length >= 4 ? value.slice(-4) : value,
    hasPlus: value.includes("+"),
  };
}

async function main(): Promise<void> {
  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY) {
    console.log(JSON.stringify({ result: "FAILURE", reason: "MISSING_SUPABASE_CONFIG" }, null, 2));
    process.exitCode = 1;
    return;
  }
  const testRecipient = process.env.WHATSAPP_TEST_RECIPIENT;
  if (!testRecipient) {
    console.log(JSON.stringify({ result: "FAILURE", reason: "MISSING_WHATSAPP_TEST_RECIPIENT" }, null, 2));
    process.exitCode = 1;
    return;
  }

  const client = createSupabaseClient();
  const { data, error } = await client
    .from("leads")
    .select("whatsapp_user_id, phone_e164, phone_raw")
    .eq("source", "WHATSAPP")
    .not("whatsapp_user_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.log(JSON.stringify({ result: "FAILURE", reason: "SUPABASE_QUERY_FAILED" }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (!data) {
    console.log(JSON.stringify({ result: "FAILURE", reason: "NO_WHATSAPP_LEAD_FOUND" }, null, 2));
    process.exitCode = 1;
    return;
  }

  const row = data as { whatsapp_user_id: string | null; phone_e164: string | null; phone_raw: string | null };

  // This is exactly what sendAndPersistReply() uses as `to` today: the raw wa_id, not the
  // normalized E.164 form.
  const inboundRecipientAsSent = row.whatsapp_user_id;
  const inboundNormalized = normalizePhoneToE164(row.whatsapp_user_id);
  const testRecipientNormalized = normalizePhoneToE164(testRecipient);

  console.log(
    JSON.stringify(
      {
        result: "SUCCESS",
        inboundRecipientAsSentShape: shape(inboundRecipientAsSent),
        inboundPhoneE164StoredShape: shape(row.phone_e164),
        testRecipientShape: shape(testRecipient),
        sameNormalizedRecipient: Boolean(inboundNormalized && testRecipientNormalized && inboundNormalized === testRecipientNormalized),
        inboundAsSentEqualsInboundE164Stored: inboundRecipientAsSent === row.phone_e164,
      },
      null,
      2,
    ),
  );
}

await main();
