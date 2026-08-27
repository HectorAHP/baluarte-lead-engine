import { describe, it, expect } from "vitest";
import { InMemorySlotOfferClaimRepository, InMemorySlotOfferClaimStore } from "../src/infrastructure/memory-repositories.js";
import { mapRowToSlotOfferClaim, type SlotOfferClaimRow } from "../src/infrastructure/supabase-slot-offer-claim-repository.js";

describe("InMemorySlotOfferClaimRepository", () => {
  it("tryCreate wins outright when no claim exists for the conversation", async () => {
    const repo = new InMemorySlotOfferClaimRepository();
    const claim = await repo.tryCreate({ conversationId: "conv-1", ownerToken: "owner-1", intendedRoundId: "round-1" });
    expect(claim).toEqual({
      conversationId: "conv-1", ownerToken: "owner-1", intendedRoundId: "round-1",
      claimedAt: claim!.claimedAt, updatedAt: claim!.updatedAt,
    });
    expect(claim?.claimedAt).toBeInstanceOf(Date);
  });

  it("tryCreate returns null (never throws) on a conflict -- a claim already exists for that conversation", async () => {
    const repo = new InMemorySlotOfferClaimRepository();
    await repo.tryCreate({ conversationId: "conv-1", ownerToken: "owner-1", intendedRoundId: "round-1" });
    const second = await repo.tryCreate({ conversationId: "conv-1", ownerToken: "owner-2", intendedRoundId: "round-2" });
    expect(second).toBeNull();
    // The original claim is untouched by the losing attempt.
    const found = await repo.findByConversationId("conv-1");
    expect(found?.ownerToken).toBe("owner-1");
  });

  it("findByConversationId returns null for a conversation with no claim", async () => {
    const repo = new InMemorySlotOfferClaimRepository();
    expect(await repo.findByConversationId("nonexistent")).toBeNull();
  });

  it("tryReclaim succeeds when owner + staleness both match, atomically rewriting owner/round/timestamps", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const oldDate = new Date("2026-03-02T09:00:00.000Z");
    store.data.set("conv-1", { conversationId: "conv-1", ownerToken: "owner-A", intendedRoundId: "round-A", claimedAt: oldDate, updatedAt: oldDate });
    const repo = new InMemorySlotOfferClaimRepository(store);
    const newNow = new Date("2026-03-02T12:00:00.000Z");

    const reclaimed = await repo.tryReclaim({
      conversationId: "conv-1", expectedOwnerToken: "owner-A", newOwnerToken: "owner-B",
      intendedRoundId: "round-B", staleBefore: new Date(oldDate.getTime() + 1), now: newNow,
    });

    expect(reclaimed).toEqual({ conversationId: "conv-1", ownerToken: "owner-B", intendedRoundId: "round-B", claimedAt: newNow, updatedAt: newNow });
  });

  it("tryReclaim returns null on an owner mismatch (someone else already owns it)", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const oldDate = new Date("2026-03-02T09:00:00.000Z");
    store.data.set("conv-1", { conversationId: "conv-1", ownerToken: "owner-real", intendedRoundId: "round-A", claimedAt: oldDate, updatedAt: oldDate });
    const repo = new InMemorySlotOfferClaimRepository(store);

    const result = await repo.tryReclaim({
      conversationId: "conv-1", expectedOwnerToken: "owner-WRONG-guess", newOwnerToken: "owner-B",
      intendedRoundId: "round-B", staleBefore: new Date(oldDate.getTime() + 1), now: new Date(),
    });

    expect(result).toBeNull();
    const stillReal = await repo.findByConversationId("conv-1");
    expect(stillReal?.ownerToken).toBe("owner-real"); // untouched
  });

  it("tryReclaim returns null when the claim is still fresh (updatedAt not before staleBefore)", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const now = new Date("2026-03-02T12:00:00.000Z");
    store.data.set("conv-1", { conversationId: "conv-1", ownerToken: "owner-A", intendedRoundId: "round-A", claimedAt: now, updatedAt: now });
    const repo = new InMemorySlotOfferClaimRepository(store);

    const result = await repo.tryReclaim({
      conversationId: "conv-1", expectedOwnerToken: "owner-A", newOwnerToken: "owner-B",
      intendedRoundId: "round-B", staleBefore: new Date(now.getTime() - 1_000), now: new Date(),
    });

    expect(result).toBeNull(); // updatedAt (now) is NOT before staleBefore (now - 1s)
    expect((await repo.findByConversationId("conv-1"))?.ownerToken).toBe("owner-A");
  });

  it("release deletes the claim when the caller is the correct owner", async () => {
    const repo = new InMemorySlotOfferClaimRepository();
    await repo.tryCreate({ conversationId: "conv-1", ownerToken: "owner-1", intendedRoundId: "round-1" });

    const released = await repo.release("conv-1", "owner-1");

    expect(released).toBe(true);
    expect(await repo.findByConversationId("conv-1")).toBeNull();
  });

  it("release returns false (never throws) when the caller is the wrong owner, and leaves the claim intact", async () => {
    const repo = new InMemorySlotOfferClaimRepository();
    await repo.tryCreate({ conversationId: "conv-1", ownerToken: "owner-1", intendedRoundId: "round-1" });

    const released = await repo.release("conv-1", "owner-IMPOSTER");

    expect(released).toBe(false);
    expect((await repo.findByConversationId("conv-1"))?.ownerToken).toBe("owner-1");
  });

  it("release by the old owner after a takeover returns false and never deletes the new owner's claim", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const oldDate = new Date("2026-03-02T09:00:00.000Z");
    store.data.set("conv-1", { conversationId: "conv-1", ownerToken: "owner-A", intendedRoundId: "round-A", claimedAt: oldDate, updatedAt: oldDate });
    const repo = new InMemorySlotOfferClaimRepository(store);
    await repo.tryReclaim({
      conversationId: "conv-1", expectedOwnerToken: "owner-A", newOwnerToken: "owner-B",
      intendedRoundId: "round-B", staleBefore: new Date(oldDate.getTime() + 1), now: new Date(),
    });

    const releasedByOldOwner = await repo.release("conv-1", "owner-A");

    expect(releasedByOldOwner).toBe(false);
    expect((await repo.findByConversationId("conv-1"))?.ownerToken).toBe("owner-B");
  });

  it("two InMemorySlotOfferClaimRepository wrappers sharing a store see each other's writes", async () => {
    const store = new InMemorySlotOfferClaimStore();
    const repoA = new InMemorySlotOfferClaimRepository(store);
    const repoB = new InMemorySlotOfferClaimRepository(store);

    await repoA.tryCreate({ conversationId: "conv-1", ownerToken: "owner-1", intendedRoundId: "round-1" });

    const seenByB = await repoB.findByConversationId("conv-1");
    expect(seenByB?.ownerToken).toBe("owner-1");
  });
});

describe("SupabaseSlotOfferClaimRepository -- row mapping (pure, no network)", () => {
  it("maps a snake_case row to the camelCase domain type", () => {
    const row: SlotOfferClaimRow = {
      conversation_id: "conv-1",
      owner_token: "owner-1",
      intended_round_id: "round-1",
      claimed_at: "2026-03-02T12:00:00.000Z",
      updated_at: "2026-03-02T12:05:00.000Z",
    };

    const claim = mapRowToSlotOfferClaim(row);

    expect(claim).toEqual({
      conversationId: "conv-1",
      ownerToken: "owner-1",
      intendedRoundId: "round-1",
      claimedAt: new Date("2026-03-02T12:00:00.000Z"),
      updatedAt: new Date("2026-03-02T12:05:00.000Z"),
    });
  });
});
