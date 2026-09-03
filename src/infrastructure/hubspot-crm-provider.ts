import type { HubSpotCRMProvider, HubSpotContactUpsertInput, HubSpotContactUpsertResult } from "../application/ports.js";
import { HubSpotProviderError } from "../domain/errors.js";

/**
 * Fase 6F -- real HubSpot CRM v3 adapter, backend-only. Uses Node 22's global `fetch` (already a
 * project dependency floor -- see package.json's "engines" -- no new HTTP client library needed).
 *
 * Dedupe strategy (item 9 of the Fase 6F report): search by normalized email first, then
 * normalized phone if no email match -- deterministic, matches the task's explicit priority
 * order. Never creates a second contact for a person HubSpot already has under either identifier.
 *
 * Idempotency (item 10): a contact upsert is a property SET, not an append -- calling this twice
 * with the same input always converges on the same single contact row with the same property
 * values. There is therefore no separate retry/idempotency-key bookkeeping needed at this layer;
 * see HubSpotFiscalSyncService's class doc comment for the full rationale.
 *
 * SECURITY: the Private App token is read once at construction from config (never logged, never
 * echoed back to any caller) and sent only as an Authorization header to api.hubapi.com. Every
 * thrown HubSpotProviderError carries only an HTTP status and a static message -- never the raw
 * response body (which could otherwise land in a log line via app.log.error's `err` field).
 */
const HUBSPOT_API_BASE = "https://api.hubapi.com";
const HUBSPOT_REQUEST_TIMEOUT_MS = 8000;

interface HubSpotSearchResponse {
  results?: Array<{ id: string }>;
}

export class RealHubSpotCRMProvider implements HubSpotCRMProvider {
  constructor(private readonly privateAppToken: string) {}

  private async request<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HUBSPOT_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${HUBSPOT_API_BASE}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.privateAppToken}`,
          "Content-Type": "application/json",
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        // Deliberately NOT res.text()/res.json() into the thrown message -- HubSpot's own error
        // body is diagnostic-only and must never be logged verbatim (see class doc comment).
        throw new HubSpotProviderError(`HubSpot API request failed (${init.method} ${path})`, { httpStatus: res.status });
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof HubSpotProviderError) throw err;
      throw new HubSpotProviderError(`HubSpot API request errored (${init.method} ${path})`, { cause: err });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async searchContactId(propertyName: "email" | "phone", value: string): Promise<string | null> {
    const res = await this.request<HubSpotSearchResponse>("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: {
        filterGroups: [{ filters: [{ propertyName, operator: "EQ", value }] }],
        properties: ["email", "phone"],
        limit: 1,
      },
    });
    return res.results?.[0]?.id ?? null;
  }

  async upsertContact(input: HubSpotContactUpsertInput): Promise<HubSpotContactUpsertResult> {
    const properties: Record<string, string | number | boolean> = { ...input.properties };
    if (input.email) properties.email = input.email;
    if (input.phone) properties.phone = input.phone;
    if (input.firstName) properties.firstname = input.firstName;
    if (input.lastName) properties.lastname = input.lastName;
    if (input.city) properties.city = input.city;
    if (input.state) properties.state = input.state;

    // Deterministic dedupe priority: normalized email, then normalized phone -- see class doc
    // comment and the Fase 6F report, item 9.
    let existingId: string | null = null;
    if (input.email) existingId = await this.searchContactId("email", input.email);
    if (!existingId && input.phone) existingId = await this.searchContactId("phone", input.phone);

    if (existingId) {
      await this.request(`/crm/v3/objects/contacts/${existingId}`, { method: "PATCH", body: { properties } });
      return { hubspotContactId: existingId, created: false };
    }

    const created = await this.request<{ id: string }>("/crm/v3/objects/contacts", {
      method: "POST",
      body: { properties },
    });
    return { hubspotContactId: created.id, created: true };
  }
}
