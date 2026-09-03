import type { HubSpotCRMProvider, Logger } from "./ports.js";
import type { Lead } from "../domain/lead.js";
import { HubSpotProviderError } from "../domain/errors.js";
import {
  buildHubSpotFiscalProperties,
  PPR_CALCULATOR_DEFAULT_VERSION,
  type HubSpotFiscalAttributionInput,
  type HubSpotFiscalPropertiesInput,
  type HubSpotFiscalScoreInput,
} from "../domain/hubspot-fiscal-properties.js";

export interface SyncFiscalCalculatorLeadInput {
  lead: Lead;
  submissionId: string;
  fiscalCalculator: HubSpotFiscalPropertiesInput["fiscalCalculator"];
  calculationVersion?: string;
  fiscalScore: HubSpotFiscalScoreInput;
  attribution?: HubSpotFiscalAttributionInput;
  consentContact: boolean;
  privacyAcceptedAt: Date;
}

/**
 * Fase 6F -- orchestrates syncing one fiscal calculator submission to HubSpot as a Contact
 * upsert. Lives in the application layer, deliberately NOT inside web-lead-capture.ts's domain
 * concerns or inside any domain/ file -- see this task's "NO acoplar lógica HubSpot al dominio"
 * instruction. Depends only on the HubSpotCRMProvider port, never a concrete adapter.
 *
 * FAIL-OPEN BY CONSTRUCTION (item 11): syncFiscalCalculatorLead() NEVER throws. Every error --
 * HubSpotProviderError from the adapter, or anything else -- is caught here and only logged. This
 * method is always called strictly AFTER the lead and its fiscal_v1 score have already been
 * persisted to Supabase (see WebLeadCaptureService.scoreFiscalCalculatorSubmission), so a HubSpot
 * outage can never lose a lead or block POST /api/leads' response.
 *
 * NOT CONFIGURED = SILENT NO-OP: `hubspot` is `undefined` in every environment until
 * HUBSPOT_PRIVATE_APP_TOKEN is set (see config.ts's hasHubSpotCredentials) -- this mirrors
 * WebLeadCaptureService's own optional `fiscalLeadScores?` port convention exactly, rather than a
 * separate enabled/disabled flag.
 *
 * IDEMPOTENCY (item 10): deliberately does NOT gate on a separate processed_events row keyed by
 * submissionId. HubSpotCRMProvider.upsertContact is a property SET (search-then-update-or-create),
 * not an append -- calling it twice with the exact same input is a no-op in effect (same contact,
 * same final property values), so an extra idempotency guard here would only add a way for a
 * transient failure to permanently block all future retries of that submissionId without any
 * correctness benefit. See the Fase 6F report, item 10, for the full rationale.
 *
 * LOGGING (item 12): only leadIdLast8, submissionIdLast8, hubspotOperation, hubspotOutcome, and
 * (on failure) httpStatus are ever logged. NEVER email, phone, income, contributions, deductions,
 * the fiscal estimate, or the HubSpot token/response body.
 */
export class HubSpotFiscalSyncService {
  constructor(
    private readonly hubspot: HubSpotCRMProvider | undefined,
    private readonly logger: Logger,
  ) {}

  async syncFiscalCalculatorLead(input: SyncFiscalCalculatorLeadInput): Promise<void> {
    if (!this.hubspot) return; // not configured -- silent no-op, see class doc comment

    const { lead } = input;
    if (!lead.email && !lead.phoneE164) {
      // Nothing to dedupe/identify a contact by -- HubSpot Contacts require at least one
      // identifier. The fiscal calculator's own frontend form requires both email and WhatsApp,
      // so this should be unreachable in practice; guarded defensively rather than assumed.
      this.logger.warn(
        { leadIdLast8: lead.id.slice(-8), submissionIdLast8: input.submissionId.slice(-8), hubspotOperation: "upsert_contact", hubspotOutcome: "skipped_no_identifier" },
        "hubspot fiscal sync skipped",
      );
      return;
    }

    try {
      const properties = buildHubSpotFiscalProperties({
        fiscalCalculator: input.fiscalCalculator,
        submissionId: input.submissionId,
        calculatedAt: new Date(),
        calculationVersion: input.calculationVersion ?? PPR_CALCULATOR_DEFAULT_VERSION,
        fiscalScore: input.fiscalScore,
        attribution: input.attribution,
        source: lead.source,
        privacyAccepted: true, // POST /api/leads schema-enforces privacyAccepted === true to reach this point
        privacyAcceptedAt: input.privacyAcceptedAt,
        consentContact: input.consentContact,
      });

      const result = await this.hubspot.upsertContact({
        email: lead.email,
        phone: lead.phoneE164,
        firstName: lead.firstName,
        lastName: lead.lastName,
        city: lead.city,
        state: lead.state,
        properties,
      });

      this.logger.warn(
        {
          leadIdLast8: lead.id.slice(-8),
          submissionIdLast8: input.submissionId.slice(-8),
          hubspotOperation: "upsert_contact",
          hubspotOutcome: result.created ? "created" : "updated",
        },
        "hubspot fiscal sync succeeded",
      );
    } catch (err) {
      this.logger.warn(
        {
          leadIdLast8: lead.id.slice(-8),
          submissionIdLast8: input.submissionId.slice(-8),
          hubspotOperation: "upsert_contact",
          hubspotOutcome: "error",
          statusCode: err instanceof HubSpotProviderError ? err.httpStatus : undefined,
          errorName: err instanceof Error ? err.name : "unknown",
        },
        "hubspot fiscal sync failed",
      );
    }
  }
}
