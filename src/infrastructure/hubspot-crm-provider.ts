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
 * Fase 6F.3 -- CONCURRENT-CREATE (HTTP 409) RECOVERY. Confirmed production root cause: this
 * class's own CREATE path races impuestos.html's parallel, independent Forms API call (the dual
 * write architecture -- see HubSpotFiscalSyncService's class doc comment). Sequence observed:
 *   1. searchContactId("email", ...) -- not found yet (Forms API hasn't landed).
 *   2. searchContactId("phone", ...) -- also not found.
 *   3. This class decides CREATE.
 *   4. Forms API's own contact-creation call wins the race, landing first.
 *   5. This class's CREATE then hits HubSpot's own duplicate-property conflict -> HTTP 409.
 * Before this fix, that 409 propagated straight up as HubSpotProviderError, caught (fail-open) by
 * HubSpotFiscalSyncService and only logged -- the contact existed (via Forms API) but NONE of the
 * bc_fiscal_* properties were ever applied to it. Fixed: a 409 on CREATE specifically is treated
 * as "someone else just created this contact" -- re-search ONCE (same email-then-phone priority,
 * never a loop, never unbounded retries) and, if found, UPDATE it with the full property set
 * instead. If the re-search still finds nothing, the original 409 propagates as a genuine,
 * unrecovered error (fail-open still applies at the caller). Recovery never inspects HubSpot's
 * response body -- only the HTTP status code (409) plus a fresh, deterministic search, matching
 * this project's "never parse PII/tokens out of an error body" rule.
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

  /** Deterministic dedupe priority: normalized email, then normalized phone -- see class doc
   * comment and the Fase 6F report, item 9. Shared by the initial lookup AND the Fase 6F.3
   * post-409 recovery re-search -- the EXACT same order both times, never a different rule. */
  private async findExistingContactId(input: HubSpotContactUpsertInput): Promise<string | null> {
    let existingId: string | null = null;
    if (input.email) existingId = await this.searchContactId("email", input.email);
    if (!existingId && input.phone) existingId = await this.searchContactId("phone", input.phone);
    return existingId;
  }

  async upsertContact(input: HubSpotContactUpsertInput): Promise<HubSpotContactUpsertResult> {
    const properties: Record<string, string | number | boolean> = { ...input.properties };
    if (input.email) properties.email = input.email;
    if (input.phone) properties.phone = input.phone;
    if (input.firstName) properties.firstname = input.firstName;
    if (input.lastName) properties.lastname = input.lastName;
    if (input.city) properties.city = input.city;
    if (input.state) properties.state = input.state;

    const existingId = await this.findExistingContactId(input);

    if (existingId) {
      await this.request(`/crm/v3/objects/contacts/${existingId}`, { method: "PATCH", body: { properties } });
      return { hubspotContactId: existingId, created: false };
    }

    try {
      const created = await this.request<{ id: string }>("/crm/v3/objects/contacts", {
        method: "POST",
        body: { properties },
      });
      return { hubspotContactId: created.id, created: true };
    } catch (err) {
      // Fase 6F.3: a 409 on CREATE specifically -- and ONLY a 409 -- is treated as "someone else
      // (almost always impuestos.html's own parallel Forms API call) just created this exact
      // contact between our search and our create". Any other error (network failure, 5xx,
      // etc.) propagates unchanged, exactly as before this fix.
      if (err instanceof HubSpotProviderError && err.httpStatus === 409) {
        return this.recoverFromConcurrentCreateConflict(input, properties);
      }
      throw err;
    }
  }

  /**
   * Bounded, one-shot recovery for a CREATE that lost the race to a concurrent contact creation
   * (see the class doc comment for the confirmed production root cause). Re-searches ONCE, in the
   * SAME deterministic order as the initial lookup -- never a retry loop, never a second attempt
   * if this one also fails to locate the contact. Never inspects HubSpot's response body -- the
   * 409 status code plus a fresh, deterministic search is the entire recovery signal (this
   * project's "never parse PII/tokens out of an error body" rule).
   */
  private async recoverFromConcurrentCreateConflict(
    input: HubSpotContactUpsertInput,
    properties: Record<string, string | number | boolean>,
  ): Promise<HubSpotContactUpsertResult> {
    const recoveredId = await this.findExistingContactId(input);
    if (!recoveredId) {
      // The 409 said a conflicting contact exists, but our own deterministic search (by the
      // SAME email/phone we just tried to create with) still can't find it -- a genuinely
      // inconsistent state (e.g. a conflict on a property this search doesn't key on). Never
      // guessed at further; surfaces as a real, unrecovered error to the caller (fail-open still
      // applies there -- see HubSpotFiscalSyncService).
      throw new HubSpotProviderError(
        "HubSpot contact CREATE conflicted (409) but the follow-up search found no matching contact",
        { httpStatus: 409 },
      );
    }
    await this.request(`/crm/v3/objects/contacts/${recoveredId}`, { method: "PATCH", body: { properties } });
    return { hubspotContactId: recoveredId, created: false, recoveredFromConflict: true };
  }
}
