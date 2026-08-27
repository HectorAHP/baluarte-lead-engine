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
}
