export type MessageDirection = "INBOUND" | "OUTBOUND";
export type MessageChannel = "WHATSAPP";

export interface Message {
  id: string;
  conversationId: string;
  leadId: string;
  direction: MessageDirection;
  channel: MessageChannel;
  sender?: string;
  body?: string;
  providerMessageId?: string;
  aiGenerated: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
}
