export type ConversationChannel = "WHATSAPP";
export type ConversationStatus = "ACTIVE" | "HUMAN_HANDOFF" | "CLOSED";

export interface Conversation {
  id: string;
  leadId: string;
  channel: ConversationChannel;
  status: ConversationStatus;
  createdAt: Date;
  updatedAt: Date;
}
