import { describe, expect, it } from "vitest";
import { messageDedupKey } from "../src/domain/message-dedup-key.js";

/**
 * These tests exercise the key-composition algorithm generically, with arbitrary strings --
 * they do not assert that any value other than "WHATSAPP" is a real, supported channel in the
 * domain model (it isn't, today). The point is to prove the *mechanism* the domain currently
 * relies on (dedup is scoped by channel + providerMessageId, not providerMessageId alone) is
 * correct, so that when a second channel is genuinely added later, message dedup is already
 * proven not to collide across channels.
 */
describe("messageDedupKey", () => {
  it("is identical for the same (channel, providerMessageId) pair", () => {
    expect(messageDedupKey("WHATSAPP", "wamid.123")).toBe(messageDedupKey("WHATSAPP", "wamid.123"));
  });

  it("differs when the providerMessageId differs, same channel", () => {
    expect(messageDedupKey("WHATSAPP", "a")).not.toBe(messageDedupKey("WHATSAPP", "b"));
  });

  it("differs when the channel differs, same providerMessageId -- the composite scoping this whole mechanism exists for", () => {
    expect(messageDedupKey("WHATSAPP", "shared-id")).not.toBe(messageDedupKey("SOME_FUTURE_CHANNEL", "shared-id"));
  });

  it("does not collide across a boundary shift between channel and id (the reason a naive colon-join would be wrong)", () => {
    expect(messageDedupKey("A:B", "C")).not.toBe(messageDedupKey("A", "B:C"));
  });
});
