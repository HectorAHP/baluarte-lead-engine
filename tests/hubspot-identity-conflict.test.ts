import { describe, expect, it, vi, afterEach } from "vitest";
import { RealHubSpotCRMProvider } from "../src/infrastructure/hubspot-crm-provider.js";
import { FakeHubSpotCRMProvider } from "../src/infrastructure/fake-hubspot-crm-provider.js";

interface MockResponse {
  status: number;
  body?: unknown;
}
function mockFetchSequence(responses: MockResponse[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let i = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: (init?.method as string) ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    const next = responses[i++];
    if (!next) throw new Error(`mockFetchSequence: no more canned responses (call ${i})`);
    return new Response(next.body !== undefined ? JSON.stringify(next.body) : "", { status: next.status });
  });
  return { fetchMock: fetchMock as unknown as typeof fetch, calls };
}
const EMPTY_SEARCH = { status: 200, body: { results: [] } };
function foundSearch(id: string): MockResponse {
  return { status: 200, body: { results: [{ id }] } };
}

/**
 * Fase 7B §36/§38 -- the identity-conflict fix, exercised WITHOUT any concurrent-create 409 in
 * the mix (see hubspot-concurrent-contact-recovery.test.ts for the 409-recovery-path variants).
 */
describe("Fase 7B -- HubSpot dedupe identity-conflict safety (non-recovery path)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("email not found, phone matches a DIFFERENT contact with a DIFFERENT email -> creates a NEW contact, never patches the old one", async () => {
    const { fetchMock, calls } = mockFetchSequence([
      EMPTY_SEARCH, // search email -- not found
      foundSearch("old-person"), // search phone -- finds a different contact
      { status: 200, body: { properties: { email: "old-person@example.com" } } }, // that contact's own email
      { status: 201, body: { id: "new-person" } }, // CREATE succeeds (no PATCH of old-person ever happens)
    ]);
    globalThis.fetch = fetchMock;
    const provider = new RealHubSpotCRMProvider("fake-token");

    const result = await provider.upsertContact({ email: "new-person@example.com", phone: "+521111", properties: { bc_fiscal_score: 10 } });

    expect(result).toEqual({ hubspotContactId: "new-person", created: true, identityConflict: true });
    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("old-person"))).toBe(false);
  });

  it("phone matches a contact with NO email on file -> safe match, updates it (not a conflict)", async () => {
    const { fetchMock, calls } = mockFetchSequence([
      EMPTY_SEARCH,
      foundSearch("no-email-contact"),
      { status: 200, body: { properties: {} } },
      { status: 200, body: {} }, // PATCH
    ]);
    globalThis.fetch = fetchMock;
    const provider = new RealHubSpotCRMProvider("fake-token");

    const result = await provider.upsertContact({ email: "new@example.com", phone: "+521111", properties: { bc_fiscal_score: 10 } });

    expect(result).toEqual({ hubspotContactId: "no-email-contact", created: false });
    expect(calls[calls.length - 1].method).toBe("PATCH");
  });

  it("phone matches a contact with the SAME email -> safe match, updates it", async () => {
    const { fetchMock } = mockFetchSequence([
      EMPTY_SEARCH,
      foundSearch("same-person"),
      { status: 200, body: { properties: { email: "same@example.com" } } },
      { status: 200, body: {} },
    ]);
    globalThis.fetch = fetchMock;
    const provider = new RealHubSpotCRMProvider("fake-token");

    const result = await provider.upsertContact({ email: "same@example.com", phone: "+521111", properties: {} });

    expect(result).toEqual({ hubspotContactId: "same-person", created: false });
  });

  it("no email in the input at all -> phone match is used directly, no extra fetch/conflict check ever happens", async () => {
    const { fetchMock, calls } = mockFetchSequence([
      foundSearch("phone-only-match"),
      { status: 200, body: {} },
    ]);
    globalThis.fetch = fetchMock;
    const provider = new RealHubSpotCRMProvider("fake-token");

    const result = await provider.upsertContact({ phone: "+521111", properties: {} });

    expect(result).toEqual({ hubspotContactId: "phone-only-match", created: false });
    expect(calls).toHaveLength(2); // search phone, then PATCH -- no email fetch
  });

  it("FakeHubSpotCRMProvider mirrors the same identity-conflict contract", async () => {
    const provider = new FakeHubSpotCRMProvider();
    await provider.upsertContact({ email: "old@example.com", phone: "+521111", properties: {} });
    const result = await provider.upsertContact({ email: "new@example.com", phone: "+521111", properties: {} });

    expect(result.identityConflict).toBe(true);
    expect(result.created).toBe(true);
    expect(provider.contacts).toHaveLength(2); // two separate contacts, never merged
    expect(provider.contacts.find((c) => c.email === "old@example.com")?.properties).not.toHaveProperty("email", "new@example.com");
  });
});
