/**
 * Fase 7J.3-DIAG -- read-only diagnostic for one specific reported production incident: a lead
 * with a PAST BOOKED appointment sent an unsupported product question ("seguro de auto") and was
 * consumed by the past-booked-recovery flow / a numeric menu instead of reaching
 * UNKNOWN_INTENT_HANDOFF. NO writes anywhere -- every query below is a plain `.select()`.
 *
 * Prints only non-PII identifiers (leadIdLast8/conversationIdLast8), statuses, timestamps, and
 * message DIRECTION/LENGTH -- never the phone number, never message bodies, never names.
 *
 * Usage: npx tsx scripts/diagnose-past-appointment-unknown-intent.ts <phoneE164OrWaId>
 */
import { config } from "../src/config.js";
import { createSupabaseClient } from "../src/infrastructure/supabase-client.js";
import { normalizePhoneToE164 } from "../src/domain/phone.js";

async function main(): Promise<void> {
  const rawPhone = process.argv[2];
  if (!rawPhone) {
    console.log(JSON.stringify({ result: "FAILURE", reason: "MISSING_PHONE_ARG" }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY) {
    console.log(JSON.stringify({ result: "FAILURE", reason: "MISSING_SUPABASE_CONFIG" }, null, 2));
    process.exitCode = 1;
    return;
  }
  const client = createSupabaseClient();

  // Candidate wa_id shapes: the digits as given, the E.164-without-plus form, and the legacy
  // "521" + 10-digit MX wa_id quirk (see domain/phone.ts) -- try all, since we don't know which
  // exact string is stored in whatsapp_user_id for this lead.
  const digits = rawPhone.replace(/\D/g, "");
  const e164 = normalizePhoneToE164(rawPhone);
  const e164Digits = e164 ? e164.replace(/\D/g, "") : null;
  const mxNational = e164Digits && e164Digits.startsWith("52") ? e164Digits.slice(2) : null;
  const legacyWaId = mxNational ? `521${mxNational}` : null;
  const candidates = Array.from(new Set([digits, e164Digits, legacyWaId].filter((v): v is string => !!v)));

  const { data: leadRows, error: leadErr } = await client
    .from("leads")
    .select("id, status, whatsapp_user_id, created_at, updated_at")
    .in("whatsapp_user_id", candidates);
  if (leadErr) {
    console.log(JSON.stringify({ result: "FAILURE", reason: "SUPABASE_LEAD_QUERY_FAILED", detail: leadErr.message }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (!leadRows || leadRows.length === 0) {
    console.log(JSON.stringify({ result: "FAILURE", reason: "LEAD_NOT_FOUND", candidatesTried: candidates.map((c) => c.slice(-4)) }, null, 2));
    process.exitCode = 1;
    return;
  }

  for (const lead of leadRows as Array<{ id: string; status: string; created_at: string; updated_at: string }>) {
    const leadIdLast8 = lead.id.slice(-8);

    const { data: history } = await client
      .from("lead_status_history")
      .select("from_status, to_status, event_type, created_at, metadata")
      .eq("lead_id", lead.id)
      .order("created_at", { ascending: true });

    const { data: appointments } = await client
      .from("appointments")
      .select("id, status, starts_at, ends_at, created_at")
      .eq("lead_id", lead.id);

    const { data: conversations } = await client
      .from("conversations")
      .select("id, status, created_at, updated_at")
      .eq("lead_id", lead.id);

    const conversationIds = (conversations ?? []).map((c: { id: string }) => c.id);
    let messages: Array<{ direction: string; created_at: string; conversation_id: string; body: string | null }> = [];
    if (conversationIds.length > 0) {
      const { data: msgRows } = await client
        .from("messages")
        .select("direction, created_at, conversation_id, body")
        .in("conversation_id", conversationIds)
        .order("created_at", { ascending: true });
      messages = (msgRows ?? []) as typeof messages;
    }

    const now = new Date();
    console.log(
      JSON.stringify(
        {
          result: "SUCCESS",
          leadIdLast8,
          currentStatus: lead.status,
          leadCreatedAt: lead.created_at,
          leadUpdatedAt: lead.updated_at,
          statusTransitions: (history ?? []).map((h: { from_status: string; to_status: string; event_type: string; created_at: string; metadata: unknown }) => ({
            fromStatus: h.from_status, toStatus: h.to_status, eventType: h.event_type, createdAt: h.created_at, metadata: h.metadata,
          })),
          appointments: (appointments ?? []).map((a: { id: string; status: string; starts_at: string; ends_at: string; created_at: string }) => ({
            appointmentIdLast8: a.id.slice(-8),
            status: a.status,
            startsAt: a.starts_at,
            endsAt: a.ends_at,
            isPast: new Date(a.ends_at).getTime() < now.getTime(),
            createdAt: a.created_at,
          })),
          conversations: (conversations ?? []).map((c: { id: string; status: string; created_at: string; updated_at: string }) => ({
            conversationIdLast8: c.id.slice(-8),
            status: c.status,
            createdAt: c.created_at,
            updatedAt: c.updated_at,
          })),
          // Never the body content itself -- only shape/metadata, per this project's own PII discipline.
          messages: messages.map((m) => ({
            conversationIdLast8: m.conversation_id.slice(-8),
            direction: m.direction,
            createdAt: m.created_at,
            bodyLength: m.body?.length ?? 0,
            looksLikeMenuReply: m.direction === "INBOUND" && /^[1-3]$/.test((m.body ?? "").trim()),
          })),
        },
        null,
        2,
      ),
    );
  }
}

await main();
