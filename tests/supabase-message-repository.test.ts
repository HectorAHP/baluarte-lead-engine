import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseMessageRepository } from "../src/infrastructure/supabase-message-repository.js";

/**
 * A minimal chainable mock of the subset of the Supabase query builder this repository uses,
 * recording every .eq() call so tests can assert exactly which columns a query filters on --
 * proving the real query is scoped by (channel, provider_message_id), not by
 * provider_message_id alone, without needing a live database.
 */
function makeMockSupabaseClient(result: { data: unknown; error: unknown }) {
  const eqCalls: Array<[string, unknown]> = [];
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqCalls.push([column, value]);
      return builder;
    }),
    maybeSingle: vi.fn(async () => result),
  };
  const client = { from: vi.fn(() => builder) };
  return { client: client as unknown as SupabaseClient, eqCalls };
}

describe("SupabaseMessageRepository.findByProviderMessageId query scoping", () => {
  it("filters by both channel and provider_message_id, in that order", async () => {
    const { client, eqCalls } = makeMockSupabaseClient({ data: null, error: null });
    const repo = new SupabaseMessageRepository(client);
    await repo.findByProviderMessageId("WHATSAPP", "wamid.123");
    expect(eqCalls).toEqual([
      ["channel", "WHATSAPP"],
      ["provider_message_id", "wamid.123"],
    ]);
  });
});
