/**
 * A generic (provider, event_id) idempotency marker. The `processed_events` table has existed
 * since migration 001_initial.sql (unique(provider, event_id)) but had no application code
 * reading or writing it until the web lead capture flow (web-lead-capture.ts) -- see that file's
 * doc comment for why this table, rather than a new one, is the right fit for the fiscal
 * calculator's per-submission idempotency requirement.
 */
export interface ProcessedEvent {
  id: string;
  provider: string;
  eventId: string;
  createdAt: Date;
}
