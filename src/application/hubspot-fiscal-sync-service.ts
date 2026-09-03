import type { HubSpotCRMProvider, Logger } from "./ports.js";
import type { Lead } from "../domain/lead.js";
import { HubSpotProviderError } from "../domain/errors.js";
import {
  buildHubSpotFiscalProperties,
  CALCULATION_VERSION_UNKNOWN,
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
  /**
   * Fase 6F.1: the AUTHORITATIVE submission-capture timestamp (app.ts's `submittedAt`) -- REQUIRED,
   * never generated here. See HubSpotFiscalPropertiesInput.calculatedAt's doc comment; `syncedAt`
   * (the actual sync-attempt moment) is generated fresh inside this method, below, and is always a
   * later-or-equal instant than this one.
   */
  calculatedAt: Date;
}

/**
 * Fase 6F -- orchestrates syncing one fiscal calculator submission to HubSpot as a Contact
 * upsert. Lives in the application layer, deliberately NOT inside web-lead-capture.ts's domain
 * concerns or inside any domain/ file -- see this task's "NO acoplar lógica HubSpot al dominio"
 * instruction. Depends only on the HubSpotCRMProvider port, never a concrete adapter.
 *
 * DUAL WRITE (Fase 6F.1, item 4/9): this backend path (B) is NOT yet the only thing writing to
 * HubSpot. impuestos.html's `enviarHubSpot()` (baluarte-capital/impuestos.html, ~line 907, called
 * from the `btn-p2-calc` click handler ~line 1132, inside `Promise.allSettled([enviarHubSpot(...),
 * submitToLeadEngine(...)])`) STILL posts directly from the browser to the HubSpot Forms API (A),
 * independently of this class, with no code dependency between the two. Both converge on the SAME
 * HubSpot contact (matched by email at HubSpot's own platform level for A, and by this class's own
 * email/phone search for B) -- so there is no duplicate-CONTACT risk today, only redundant/
 * overlapping property writes (A writes firstname/lastname/email/phone + a free-text `message`
 * note; B writes those same 4 native fields plus every bc_fiscal_* property). This is intentionally
 * left in place until backend sync (B) has a real QA run against live HubSpot -- see the Fase 6F.1
 * report, item 8/9. ONCE THAT QA PASSES, retiring A means: deleting the `enviarHubSpot` function
 * (impuestos.html ~line 907-967) AND its call site inside the `Promise.allSettled([...])` array in
 * the `btn-p2-calc` click handler (~line 1131-1137), leaving `submitToLeadEngine(leadEnginePayload)`
 * as the sole entry in that array. That change touches ONLY impuestos.html -- it does not require
 * any change to Lead Engine, the form itself, attribution capture, or consent handling (all three
 * already flow through submitToLeadEngine's own payload today, unaffected by A's removal).
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
        calculatedAt: input.calculatedAt,
        // Fase 6F.1: generated fresh, right now, right before the actual HubSpot call -- never
        // reused from a prior attempt, never confused with calculatedAt above.
        syncedAt: new Date(),
        calculationVersion: input.calculationVersion ?? CALCULATION_VERSION_UNKNOWN,
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
