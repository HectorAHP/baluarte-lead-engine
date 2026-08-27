import { describe, expect, it } from "vitest";
import { InMemoryConversationRepository, InMemoryMessageRepository, InMemoryOfferedSlotRepository } from "../src/infrastructure/memory-repositories.js";
import { DuplicateMessageError } from "../src/domain/errors.js";

describe("InMemoryMessageRepository dedup", () => {
  it("rejects a second inbound message with the same (channel, providerMessageId)", async () => {
    const repo = new InMemoryMessageRepository();
    await repo.create({ conversationId: "c1", leadId: "l1", direction: "INBOUND", channel: "WHATSAPP", body: "hola", providerMessageId: "wamid.1", aiGenerated: false, metadata: {} });
    await expect(
      repo.create({ conversationId: "c1", leadId: "l1", direction: "INBOUND", channel: "WHATSAPP", body: "hola (retry)", providerMessageId: "wamid.1", aiGenerated: false, metadata: {} }),
    ).rejects.toThrow(DuplicateMessageError);
  });

  // MessageChannel has exactly one real member ("WHATSAPP") today, so there is no type-safe way
  // to exercise "a different channel" against this repository without fabricating an
  // unsupported channel value. That would prove nothing true about the domain model. The
  // channel-scoping mechanism itself (that the dedup key is (channel, providerMessageId), not
  // providerMessageId alone) is proven honestly in tests/message-dedup-key.test.ts, using the
  // key-composition function directly with arbitrary strings rather than pretending a second
  // MessageChannel exists.

  it("allows multiple messages without a providerMessageId (e.g. outbound messages we generated)", async () => {
    const repo = new InMemoryMessageRepository();
    await repo.create({ conversationId: "c1", leadId: "l1", direction: "OUTBOUND", channel: "WHATSAPP", body: "a", aiGenerated: true, metadata: {} });
    await repo.create({ conversationId: "c1", leadId: "l1", direction: "OUTBOUND", channel: "WHATSAPP", body: "b", aiGenerated: true, metadata: {} });
    const list = await repo.listByConversationId("c1");
    expect(list).toHaveLength(2);
  });

  it("findByProviderMessageId is scoped by channel, and returns the existing message for a duplicate delivery so a caller can short-circuit before even attempting create()", async () => {
    const repo = new InMemoryMessageRepository();
    const created = await repo.create({ conversationId: "c1", leadId: "l1", direction: "INBOUND", channel: "WHATSAPP", body: "hola", providerMessageId: "wamid.2", aiGenerated: false, metadata: {} });
    const found = await repo.findByProviderMessageId("WHATSAPP", "wamid.2");
    expect(found?.id).toBe(created.id);
  });
});

describe("InMemoryConversationRepository", () => {
  it("finds the active conversation for a lead, ignoring closed ones", async () => {
    const repo = new InMemoryConversationRepository();
    const closed = await repo.create({ leadId: "l1", channel: "WHATSAPP", status: "ACTIVE" });
    await repo.update(closed.id, { status: "CLOSED" });
    const active = await repo.create({ leadId: "l1", channel: "WHATSAPP", status: "ACTIVE" });
    const found = await repo.findActiveByLeadId("l1");
    expect(found?.id).toBe(active.id);
  });
});

describe("InMemoryOfferedSlotRepository", () => {
  it("excludes expired and already-selected slots from listActiveByConversationId", async () => {
    const repo = new InMemoryOfferedSlotRepository();
    const now = new Date("2026-03-02T14:00:00.000Z");
    const valid = await repo.create({ conversationId: "c1", leadId: "l1", slotStart: new Date(), slotEnd: new Date(), position: 1, expiresAt: new Date("2026-03-02T15:00:00.000Z"), selected: false });
    await repo.create({ conversationId: "c1", leadId: "l1", slotStart: new Date(), slotEnd: new Date(), position: 2, expiresAt: new Date("2026-03-02T13:00:00.000Z"), selected: false });
    const alreadySelected = await repo.create({ conversationId: "c1", leadId: "l1", slotStart: new Date(), slotEnd: new Date(), position: 3, expiresAt: new Date("2026-03-02T15:00:00.000Z"), selected: false });
    await repo.update(alreadySelected.id, { selected: true });

    const active = await repo.listActiveByConversationId("c1", now);
    expect(active.map((s) => s.id)).toEqual([valid.id]);
  });
});
