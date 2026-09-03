import type { HubSpotCRMProvider, HubSpotContactUpsertInput, HubSpotContactUpsertResult } from "../application/ports.js";
import { HubSpotProviderError } from "../domain/errors.js";

interface FakeContact {
  id: string;
  email?: string;
  phone?: string;
  properties: Record<string, string | number | boolean>;
}

/**
 * In-memory HubSpot double for tests. Mirrors RealHubSpotCRMProvider's exact dedupe contract
 * (email first, then phone) and idempotent-upsert semantics (a second call with the same
 * email/phone updates the SAME contact, never creates a second one), without any network call.
 *
 * `shouldFail` lets a test simulate a HubSpot outage/error to exercise fail-open behavior --
 * throws HubSpotProviderError, exactly like the real adapter would for a non-2xx response.
 */
export class FakeHubSpotCRMProvider implements HubSpotCRMProvider {
  public readonly contacts: FakeContact[] = [];
  public readonly calls: HubSpotContactUpsertInput[] = [];
  public shouldFail = false;
  private nextId = 1;

  async upsertContact(input: HubSpotContactUpsertInput): Promise<HubSpotContactUpsertResult> {
    this.calls.push(input);
    if (this.shouldFail) {
      throw new HubSpotProviderError("Simulated HubSpot outage", { httpStatus: 500 });
    }

    const properties: Record<string, string | number | boolean> = { ...input.properties };
    if (input.firstName) properties.firstname = input.firstName;
    if (input.lastName) properties.lastname = input.lastName;
    if (input.city) properties.city = input.city;
    if (input.state) properties.state = input.state;

    let existing = input.email ? this.contacts.find((c) => c.email === input.email) : undefined;
    if (!existing && input.phone) existing = this.contacts.find((c) => c.phone === input.phone);

    if (existing) {
      existing.properties = { ...existing.properties, ...properties };
      if (input.email) existing.email = input.email;
      if (input.phone) existing.phone = input.phone;
      return { hubspotContactId: existing.id, created: false };
    }

    const contact: FakeContact = {
      id: `fake-hs-contact-${this.nextId++}`,
      email: input.email,
      phone: input.phone,
      properties,
    };
    this.contacts.push(contact);
    return { hubspotContactId: contact.id, created: true };
  }
}
