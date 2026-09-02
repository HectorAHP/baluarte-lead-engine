import type { LeadRepository, FiscalLeadScoreRepository } from "./ports.js";
import type { Lead } from "../domain/lead.js";
import { normalizePhoneToE164 } from "../domain/phone.js";
import type {
  AnnualContributionBand,
  FiscalScoreClass,
  MonthlyIncomeBand,
} from "../domain/fiscal-lead-score.js";

/**
 * Fase 6A -- context bridge. Prepares (but does NOT yet consume) what the WhatsApp inbound
 * pipeline will need, later, to recognize a prospect who previously ran the fiscal calculator and
 * now writes in on WhatsApp. Nothing in this file is wired into whatsapp-inbound-service.ts's
 * actual message-handling logic in this phase -- it is deliberately standalone and inactive,
 * per this task's "no activar automatización" instruction. No WhatsApp copy changes, no automated
 * outbound, no booking activation.
 *
 * Only bands (never exact amounts) are exposed here, so this context is safe to eventually thread
 * into a conversational prompt/log without re-exposing the exact financial figures the calculator
 * collected.
 */
export interface FiscalLeadContext {
  leadId: string;
  source: string | undefined;
  score: number;
  scoreClass: FiscalScoreClass;
  scoreVersion: string;
  hasPpr?: boolean;
  filesAnnualReturn?: boolean;
  monthlyIncomeBand: MonthlyIncomeBand;
  annualContributionBand: AnnualContributionBand;
  campaignName?: string;
  /** Timestamp of the most recent fiscal calculator submission this context was derived from. */
  latestSubmissionAt: Date;
}

function toContext(lead: Lead, latest: {
  score: number;
  scoreClass: FiscalScoreClass;
  version: string;
  hasPpr?: boolean;
  filesAnnualReturn?: boolean;
  monthlyIncomeBand: MonthlyIncomeBand;
  annualContributionBand: AnnualContributionBand;
  createdAt: Date;
}): FiscalLeadContext {
  return {
    leadId: lead.id,
    source: lead.source,
    score: latest.score,
    scoreClass: latest.scoreClass,
    scoreVersion: latest.version,
    hasPpr: latest.hasPpr,
    filesAnnualReturn: latest.filesAnnualReturn,
    monthlyIncomeBand: latest.monthlyIncomeBand,
    annualContributionBand: latest.annualContributionBand,
    campaignName: lead.campaignName,
    latestSubmissionAt: latest.createdAt,
  };
}

/** Looks up the fiscal context for an already-resolved lead. Returns null when the lead has no
 * fiscal_lead_scores row yet (never ran the calculator, or scoring was skipped/failed). */
export async function getFiscalLeadContextForLead(
  deps: { fiscalLeadScores: FiscalLeadScoreRepository },
  lead: Lead,
): Promise<FiscalLeadContext | null> {
  const rows = await deps.fiscalLeadScores.listByLeadId(lead.id);
  if (rows.length === 0) return null;
  // listByLeadId's contract is "newest first" (see ports.ts), but this stays defensive against
  // either repository implementation's exact ordering rather than assuming it.
  const latest = rows.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  return toContext(lead, latest);
}

/**
 * WhatsApp context-bridge entry point: given the raw inbound phone number (same shape
 * whatsapp-inbound-service.ts already receives), normalizes it with the SAME
 * normalizePhoneToE164 primitive already used for lead dedup, locates the lead by phoneE164, and
 * returns its fiscal context if any exists. Returns null (never throws) when the phone doesn't
 * normalize, no lead matches, or the lead never ran the fiscal calculator -- every one of those is
 * an expected "no context available" outcome, not an error.
 */
export async function getFiscalLeadContextByPhone(
  deps: { leads: LeadRepository; fiscalLeadScores: FiscalLeadScoreRepository },
  phoneRaw: string | undefined | null,
): Promise<FiscalLeadContext | null> {
  const phoneE164 = normalizePhoneToE164(phoneRaw);
  if (!phoneE164) return null;
  const lead = await deps.leads.findByDedupKey({ phoneE164 });
  if (!lead) return null;
  return getFiscalLeadContextForLead(deps, lead);
}
