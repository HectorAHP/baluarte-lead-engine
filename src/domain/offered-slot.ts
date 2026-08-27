export interface OfferedSlot {
  id: string;
  conversationId: string;
  leadId: string;
  /**
   * Identifies which round this slot belongs to. Generated exactly ONCE per round by
   * SlotOfferingService.createRound (never per-row, never as a column DEFAULT in the database --
   * see migration 010) so every slot in a round shares the same value. This is the sole basis
   * for round counting/consistency checks -- never inferred from created_at/expires_at
   * proximity.
   */
  roundId: string;
  slotStart: Date;
  slotEnd: Date;
  /** 1-based position as presented to the user ("el primero" = 1, "el segundo" = 2, ...). */
  position: number;
  expiresAt: Date;
  selected: boolean;
  createdAt: Date;
  /**
   * Phase 4C: undefined for a normal booking round (the default, unchanged Phase 3C shape) --
   * set to the OLD appointment's id for a reschedule round. Exists so round-counting
   * (MAX_OFFER_ROUNDS) can be scoped per booking-context instead of cumulatively per
   * conversation forever: a lead who used all 3 rounds during their original booking must still
   * get a fresh 3-round budget when they later reschedule, and vice versa. The old appointment's
   * id is a stable, already-persistent identifier for "this reschedule episode" -- available the
   * moment WhatsAppRescheduleHandler finds the target appointment, well before any slot is
   * selected -- deliberately NOT a created_at/timestamp heuristic, which could not
   * unambiguously distinguish "this reschedule attempt" from a later, unrelated one for the same
   * lead+conversation.
   */
  rescheduleContextId?: string;
}
