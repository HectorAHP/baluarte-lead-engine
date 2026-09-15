import { describe, it, expect } from "vitest";
import { WebLeadCaptureService } from "../src/application/web-lead-capture.js";
import { LeadService } from "../src/application/services.js";
import {
  InMemoryLeadRepository, InMemoryProcessedEventRepository, InMemoryLeadStatusHistoryRepository,
} from "../src/infrastructure/memory-repositories.js";
import { FakeLogger } from "../src/infrastructure/fake-logger.js";

/**
 * Fase 2.2 (Baluarte Content Intelligence -- "Launch Blocker Closure").
 *
 * Golden Test 1 (attribution persistence) and Golden Test 3 (fiscal lead -> different diagnosed
 * need, attribution untouched) from the Fase 2.2 brief, at the unit/integration level -- exactly
 * what WebLeadCaptureService.capture() does today, without any HTTP layer, HubSpot, or Supabase
 * involved (see tests/web-lead-capture-hubspot-outbox.test.ts for the harness this mirrors).
 *
 * Before Fase 2.2: `attribution` reached this class's `capture()` input and was used ONLY to
 * build the HubSpot sync payload -- `createLead()` never received it, so `leads.attribution`
 * (the column added by migration 022_leads_attribution.sql) was always absent. These tests would
 * have failed before that fix (createLead never persisted attribution at all).
 */
function makeService() {
  const leads = new InMemoryLeadRepository();
  const processedEvents = new InMemoryProcessedEventRepository();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const leadService = new LeadService(
    leads,
    { create: async () => { throw new Error("unused"); }, listByLeadId: async () => [] },
    leadStatusHistory,
    new FakeLogger(),
  );
  const logger = new FakeLogger();
  const service = new WebLeadCaptureService(leads, processedEvents, leadService, logger);
  return { leads, service };
}

const goldenAttribution = {
  utm_source: "meta",
  utm_medium: "paid_social",
  utm_campaign: "bc_calc_diag_2026_09",
  utm_content: "BC-A-FEED-V01",
  utm_term: "professionals",
  fbclid: "test123",
};

describe("Fase 2.2 -- first-party attribution persistence", () => {
  it("Golden Test 1: a lead captured with attribution persists it on the Lead itself, not only in a downstream sync payload", async () => {
    const { service } = makeService();
    const result = await service.capture({
      submissionId: "sub-attr-1",
      phone: "4771234567",
      email: "prospecto1@example.com",
      source: "WEB",
      consentContact: false,
      privacyAcceptedAt: new Date(),
      attribution: goldenAttribution,
    });

    expect(result.lead.attribution).toEqual(goldenAttribution);
    // The exact question the Fase 2.1 audit could not answer without HubSpot:
    expect(result.lead.attribution?.utm_campaign).toBe("bc_calc_diag_2026_09");
    expect(result.lead.attribution?.utm_content).toBe("BC-A-FEED-V01"); // creative id
    expect(result.lead.attribution?.utm_source).toBe("meta");
  });

  it("a lead captured with NO attribution (manual lead, WhatsApp-originated) persists cleanly with attribution left unset", async () => {
    const { service } = makeService();
    const result = await service.capture({
      submissionId: "sub-no-attr",
      phone: "4779998888",
      source: "MANUAL",
      consentContact: false,
      privacyAcceptedAt: new Date(),
    });

    expect(result.lead.attribution).toBeUndefined();
    expect(result.matchedExisting).toBe(false);
  });

  it("Golden Test 3: a second submission from the SAME lead with different attribution never overwrites the first-touch attribution", async () => {
    const { service } = makeService();
    const email = "prospecto3@example.com";

    const first = await service.capture({
      submissionId: "sub-first-touch",
      phone: "4771112222",
      email,
      source: "WEB",
      consentContact: false,
      privacyAcceptedAt: new Date(),
      attribution: goldenAttribution,
    });
    expect(first.lead.attribution).toEqual(goldenAttribution);

    // Same person comes back later through a totally different campaign/creative/angle --
    // this must NEVER silently rewrite where they ACTUALLY came from the first time.
    const retargeted = await service.capture({
      submissionId: "sub-second-touch",
      phone: "4771112222",
      email,
      source: "WEB",
      consentContact: false,
      privacyAcceptedAt: new Date(),
      attribution: {
        utm_source: "meta",
        utm_medium: "paid_social",
        utm_campaign: "bc_calc_diag_2026_09",
        utm_content: "BC-E-STORY-V01", // different creative -- a WARM retargeting touch
      },
    });

    expect(retargeted.matchedExisting).toBe(true);
    expect(retargeted.lead.id).toBe(first.lead.id);
    // First-touch preserved -- same rule already applied to campaignName/source/productVertical.
    expect(retargeted.lead.attribution).toEqual(goldenAttribution);
    expect(retargeted.lead.attribution?.utm_content).toBe("BC-A-FEED-V01");
  });

  it("a lead whose FIRST capture had no attribution can still gain it on a later submission (fills the gap, does not overwrite)", async () => {
    const { service } = makeService();
    const email = "prospecto-gap@example.com";

    const first = await service.capture({
      submissionId: "sub-gap-1",
      phone: "4773334444",
      email,
      source: "MANUAL",
      consentContact: false,
      privacyAcceptedAt: new Date(),
    });
    expect(first.lead.attribution).toBeUndefined();

    const second = await service.capture({
      submissionId: "sub-gap-2",
      phone: "4773334444",
      email,
      source: "WEB",
      consentContact: false,
      privacyAcceptedAt: new Date(),
      attribution: goldenAttribution,
    });

    expect(second.lead.id).toBe(first.lead.id);
    expect(second.lead.attribution).toEqual(goldenAttribution);
  });
});
