export interface OfferedSlot {
  id: string;
  conversationId: string;
  leadId: string;
  slotStart: Date;
  slotEnd: Date;
  /** 1-based position as presented to the user ("el primero" = 1, "el segundo" = 2, ...). */
  position: number;
  expiresAt: Date;
  selected: boolean;
  createdAt: Date;
}
