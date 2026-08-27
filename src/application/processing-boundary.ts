import type { Logger } from "./ports.js";

/**
 * Marks the boundary between "must complete before acknowledging the webhook" (idempotent
 * ingestion: dedup check, lead/conversation resolution, message persistence) and "can happen
 * after ingestion, outside the critical path" (processing: deciding on and sending a reply).
 *
 * In this phase it's a plain awaited call, not a real queue -- Phase 2 has no slow work yet (no
 * AI, no Calendar), so there's nothing to gain from a genuine async handoff, and awaiting keeps
 * behavior deterministic and testable. Errors here are caught and logged, never rethrown: a
 * failure to send or persist a reply must never invalidate or roll back the inbound message
 * that was already safely ingested before this ran.
 *
 * When a later phase adds slow work here (the AI qualifier), this is the seam where a real
 * queue (or at minimum a `setImmediate`-based fire-and-forget) replaces the awaited call,
 * without any caller of `handleInboundWhatsAppText` needing to change.
 */
export async function runProcessingBoundary(
  work: () => Promise<void>,
  logger: Logger,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await work();
  } catch (err) {
    logger.warn(
      { ...context, reason: err instanceof Error ? err.message : "unknown" },
      "WhatsApp inbound processing failed after successful ingestion; the inbound message remains safely persisted.",
    );
  }
}
