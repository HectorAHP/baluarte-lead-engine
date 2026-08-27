import { describe, expect, it } from "vitest";
import { InMemoryLeadRepository } from "../src/infrastructure/memory-repositories.js";

const base = { country: "MX" as const, productVertical: "PATRIMONIAL" as const, status: "NEW" as const, score: 0, assignedAdvisor: "Hector Herrera", consentContact: false };

describe("LeadRepository.findByDedupKey priority", () => {
  it("matches by meta_lead_id first, even if a different lead's phone would also match", async () => {
    const repo = new InMemoryLeadRepository();
    const a = await repo.create({ ...base, metaLeadId: "meta-1", phoneE164: "+524771111111" });
    await repo.create({ ...base, phoneE164: "+524772222222" });
    const match = await repo.findByDedupKey({ metaLeadId: "meta-1", phoneE164: "+524772222222" });
    expect(match?.id).toBe(a.id);
  });

  it("matches by whatsapp_user_id when meta_lead_id is absent", async () => {
    const repo = new InMemoryLeadRepository();
    const a = await repo.create({ ...base, whatsappUserId: "wa-1" });
    const match = await repo.findByDedupKey({ whatsappUserId: "wa-1" });
    expect(match?.id).toBe(a.id);
  });

  it("matches by phone_e164 when higher-priority keys are absent", async () => {
    const repo = new InMemoryLeadRepository();
    const a = await repo.create({ ...base, phoneE164: "+524771234567" });
    const match = await repo.findByDedupKey({ phoneE164: "+524771234567" });
    expect(match?.id).toBe(a.id);
  });

  it("matches by normalized (case-insensitive) email as the last resort", async () => {
    const repo = new InMemoryLeadRepository();
    const a = await repo.create({ ...base, email: "Ana@Example.com" });
    const match = await repo.findByDedupKey({ email: "ana@example.com" });
    expect(match?.id).toBe(a.id);
  });

  it("falls through to a lower-priority key when a higher-priority one is provided but has no match", async () => {
    const repo = new InMemoryLeadRepository();
    const a = await repo.create({ ...base, phoneE164: "+524771234567" });
    const match = await repo.findByDedupKey({ metaLeadId: "no-such-meta-id", phoneE164: "+524771234567" });
    expect(match?.id).toBe(a.id);
  });

  it("returns null when nothing matches", async () => {
    const repo = new InMemoryLeadRepository();
    await repo.create({ ...base, email: "someone@example.com" });
    const match = await repo.findByDedupKey({ email: "nobody@example.com", phoneE164: "+520000000000" });
    expect(match).toBeNull();
  });
});
