/**
 * Read-only diagnostic: lists the timestamps and directions (never bodies, never phone numbers)
 * of the most recent WHATSAPP-channel messages, to correlate the failing auto-reply with server
 * process start times. No writes.
 *
 * Usage: npx tsx scripts/diagnose-whatsapp-message-timeline.ts
 */
import { config } from "../src/config.js";
import { createSupabaseClient } from "../src/infrastructure/supabase-client.js";

async function main(): Promise<void> {
  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY) {
    console.log(JSON.stringify({ result: "FAILURE", reason: "MISSING_SUPABASE_CONFIG" }, null, 2));
    process.exitCode = 1;
    return;
  }
  const client = createSupabaseClient();
  const { data, error } = await client
    .from("messages")
    .select("direction, channel, created_at, provider_message_id")
    .eq("channel", "WHATSAPP")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.log(JSON.stringify({ result: "FAILURE", reason: "SUPABASE_QUERY_FAILED" }, null, 2));
    process.exitCode = 1;
    return;
  }

  const rows = (data ?? []) as Array<{ direction: string; channel: string; created_at: string; provider_message_id: string | null }>;
  console.log(
    JSON.stringify(
      {
        result: "SUCCESS",
        messages: rows.map((r) => ({ direction: r.direction, createdAt: r.created_at, hasProviderMessageId: Boolean(r.provider_message_id) })),
      },
      null,
      2,
    ),
  );
}

await main();
