import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers/test-app.js";
import { InMemoryLeadRepository } from "../src/infrastructure/memory-repositories.js";
import { FakeEmailDomainChecker } from "../src/infrastructure/fake-email-domain-checker.js";

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Ana",
    phone: "4771234567",
    email: "ana@example.com",
    source: "WEB",
    privacyAccepted: true,
    consentContact: false,
    ...overrides,
  };
}

describe("Fase 7B -- lead integrity / anti-fake-lead (POST /api/leads)", () => {
  it("flag off (default): no integrity field is ever computed or stored", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload() });
    const lead = await leadsRepo.findById(res.json().leadId);
    expect(lead?.emailQuality).toBeUndefined();
    expect(lead?.phoneQuality).toBeUndefined();
    expect(lead?.leadIntegrityScore).toBeUndefined();
    expect(lead?.identityConflict).toBeUndefined();
  });

  it("item 4 (email quality state)/item 5 (phone MX normalized): both computed and persisted when the flag is on", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo, leadIntegrityEnabled: true });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload() });
    const lead = await leadsRepo.findById(res.json().leadId);
    expect(lead?.emailQuality).toBe("UNVERIFIED"); // no DNS check enabled -- never silently VALID
    expect(lead?.phoneQuality).toBe("UNVERIFIED");
    expect(lead?.phoneE164).toBe("+524771234567");
    expect(typeof lead?.leadIntegrityScore).toBe("number");
    expect(lead?.leadIntegrityVersion).toBe("lead_integrity_v1");
  });

  it("item 6 (invalid phone rejected -- INVALID quality, request still succeeds -- never a hard 400 for a technical quality signal)", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo, leadIntegrityEnabled: true });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ phone: "1111111111" }) });
    expect(res.statusCode).toBe(201);
    const lead = await leadsRepo.findById(res.json().leadId);
    expect(lead?.phoneQuality).toBe("INVALID");
  });

  it("item 2 (email inválido) -- request still succeeds; emailQuality reflects it, never a 400 for this alone", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo, leadIntegrityEnabled: true });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ email: "not-an-email" }) });
    expect(res.statusCode).toBe(400); // zod's own z.string().email() already rejects this at the schema level -- unchanged, pre-existing behavior
  });

  it("item 3 (disposable email detected) when DISPOSABLE_EMAIL_CHECK_ENABLED is also on", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo, leadIntegrityEnabled: true, disposableEmailCheckEnabled: true });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ email: "throwaway@mailinator.com" }) });
    const lead = await leadsRepo.findById(res.json().leadId);
    expect(lead?.emailQuality).toBe("DISPOSABLE");
  });

  it("disposable check stays off by default even with leadIntegrityEnabled on -- item 31's 'tag, don't necessarily reject'", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo, leadIntegrityEnabled: true }); // disposableEmailCheckEnabled left false
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ email: "throwaway@mailinator.com" }) });
    const lead = await leadsRepo.findById(res.json().leadId);
    expect(lead?.emailQuality).toBe("UNVERIFIED"); // never DISPOSABLE while the flag is off
  });

  it("item 16 (DNS check, when enabled): a confirmed domain promotes emailQuality to VALID", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({
      leadsRepo, leadIntegrityEnabled: true, emailDnsValidationEnabled: true,
      emailDomainChecker: new FakeEmailDomainChecker({ "example.com": true }),
    });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload() });
    const lead = await leadsRepo.findById(res.json().leadId);
    expect(lead?.emailQuality).toBe("VALID");
  });

  it("item 16 (DNS failure fail-open): a DNS check that returns null (timeout/failure) never demotes to INVALID", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({
      leadsRepo, leadIntegrityEnabled: true, emailDnsValidationEnabled: true,
      emailDomainChecker: new FakeEmailDomainChecker({}), // unconfigured domain -> null (unknown)
    });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload() });
    expect(res.statusCode).toBe(201);
    const lead = await leadsRepo.findById(res.json().leadId);
    expect(lead?.emailQuality).toBe("UNVERIFIED"); // never INVALID just because DNS was inconclusive
  });

  it("item 14 (impossible timing marks suspicious)", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo, leadIntegrityEnabled: true });
    const formStartedAt = new Date().toISOString();
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ formStartedAt }) });
    const lead = await leadsRepo.findById(res.json().leadId);
    expect(lead?.suspectedAutomation).toBe(true); // submitted "now", same instant as formStartedAt
  });

  it("a normal-paced submission (formStartedAt sent, plenty of time elapsed) is never marked suspicious", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo, leadIntegrityEnabled: true });
    const formStartedAt = new Date(Date.now() - 30_000).toISOString(); // 30s ago
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ formStartedAt }) });
    const lead = await leadsRepo.findById(res.json().leadId);
    expect(lead?.suspectedAutomation).toBe(false);
  });

  it("item 13 (honeypot blocks normal lead persistence) when HONEYPOT_ENABLED is on", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo, honeypotEnabled: true });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ website: "http://spam.example" }) });
    expect(res.statusCode).toBe(201); // neutral, indistinguishable success response
    const leadId = res.json().leadId;
    expect(await leadsRepo.findById(leadId)).toBeNull(); // never actually persisted
  });

  it("honeypot field is silently ignored while HONEYPOT_ENABLED is off (the default) -- a real lead is still created", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo }); // honeypotEnabled left false
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ website: "http://spam.example" }) });
    expect(res.statusCode).toBe(201);
    expect(await leadsRepo.findById(res.json().leadId)).not.toBeNull();
  });

  it("a real user leaving the honeypot empty is completely unaffected, even with HONEYPOT_ENABLED on", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo, honeypotEnabled: true });
    const res = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload() }); // no `website` field at all
    expect(res.statusCode).toBe(201);
    expect(await leadsRepo.findById(res.json().leadId)).not.toBeNull();
  });

  it("item 12 (same phone + different email does not overwrite blindly) -- creates a SEPARATE lead, flags identityConflict", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo, leadIntegrityEnabled: true });

    const first = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ email: "person-a@example.com", phone: "4771111111" }) });
    const second = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ email: "person-b@example.com", phone: "4771111111" }) });

    expect(second.json().leadId).not.toBe(first.json().leadId); // never merged into the first lead
    const leadA = await leadsRepo.findById(first.json().leadId);
    const leadB = await leadsRepo.findById(second.json().leadId);
    expect(leadA?.email).toBe("person-a@example.com"); // never overwritten
    expect(leadA?.identityConflict).toBeUndefined();
    expect(leadB?.identityConflict).toBe(true);
  });

  it("item 11 (same email does not duplicate) -- a second submission with the SAME email (different phone) merges into the existing lead", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo, leadIntegrityEnabled: true });

    const first = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ email: "same@example.com", phone: "4771111111" }) });
    const second = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ email: "same@example.com", phone: "4772222222" }) });

    expect(second.json().leadId).toBe(first.json().leadId); // same lead, email is the stronger identifier
    const lead = await leadsRepo.findById(first.json().leadId);
    expect(lead?.identityConflict).toBeUndefined();
  });

  it("a phone-only match with NO email on either side still merges normally (not a conflict)", async () => {
    const leadsRepo = new InMemoryLeadRepository();
    const app = await buildTestApp({ leadsRepo, leadIntegrityEnabled: true });

    const first = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ email: undefined, phone: "4773333333" }) });
    const second = await app.inject({ method: "POST", url: "/api/leads", payload: basePayload({ email: undefined, phone: "4773333333" }) });

    expect(second.json().leadId).toBe(first.json().leadId);
  });
});
