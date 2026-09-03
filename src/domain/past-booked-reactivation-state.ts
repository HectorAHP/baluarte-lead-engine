/**
 * Fase 6E.2 -- opaque outbound-message marker for the past-booked-recovery flow's generic
 * fallback (PAST_BOOKED_GENERIC_INBOUND_MESSAGE), mirroring qualified-lead-menu-state.ts's
 * qualifiedMainMenuMetadata()/qualifiedOptionsMenuMetadata() exactly: same `expectedIntent` key,
 * never PII, never score/band data.
 *
 * Unlike the qualified-lead router's MAIN/OPTIONS markers, nothing in this codebase currently
 * RESOLVES this marker back into pending-menu state: WhatsAppPastBookedRecoveryHandler's keyword
 * detection (isCancellationRequest / isRescheduleRequest / isNewBookingRequest /
 * detectQualifiedLeadIntent) runs unconditionally on every turn, because this flow never shows a
 * numbered 1/2/3 menu that would create bare-digit ambiguity (see that handler's doc comment) --
 * so there is no pending-menu state to reconstruct. This marker exists purely so the outbound
 * message history stays consistent with the established "every state-relevant reply carries an
 * opaque expectedIntent marker" convention, and so a future phase that DOES need to distinguish
 * "was this turn a reply to the past-booked prompt specifically" has it available without a schema
 * change.
 */
const EXPECTED_INTENT_KEY = "expectedIntent";
const PAST_BOOKED_REACTIVATION_MARKER = "PAST_BOOKED_REACTIVATION";

export function pastBookedReactivationMetadata(): Record<string, unknown> {
  return { [EXPECTED_INTENT_KEY]: PAST_BOOKED_REACTIVATION_MARKER };
}
