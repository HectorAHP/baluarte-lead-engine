import type { LeadStatus } from "./lead.js";

/**
 * One completed leads.status transition. Written exactly once per real transition by
 * recordLeadStatusTransition (application/lead-status-audit.ts) -- never for a no-op (from ===
 * to) or a failed transition. `metadata` is operational-only (see the migration's own comment and
 * tests/lead-status-audit.test.ts) -- never clinical content or raw message text.
 */
export interface LeadStatusHistoryEntry {
  id: string;
  leadId: string;
  fromStatus: LeadStatus;
  toStatus: LeadStatus;
  eventType: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}
