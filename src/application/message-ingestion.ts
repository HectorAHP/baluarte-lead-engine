import type { MessageRepository } from "./ports.js";
import type { Message } from "../domain/message.js";
import { redactSensitiveHealthContent } from "../domain/health-redaction.js";

export interface InboundMessageInput {
  conversationId: string;
  leadId: string;
  body: string;
  providerMessageId?: string;
  sender?: string;
}

export interface InboundMessageResult {
  message: Message;
  sensitiveDetected: boolean;
}

/**
 * The single boundary inbound WhatsApp text must pass through before persistence. It only ever
 * calls MessageRepository -- never QualificationAnswerRepository -- so sensitive health text a
 * user volunteers structurally cannot end up in qualification_answers; there is no code path
 * here that touches that repository. The caller (a future Phase 3/8 webhook handler) is
 * responsible for acting on `sensitiveDetected`, e.g. transitioning the conversation to
 * HUMAN_HANDOFF -- that state transition doesn't exist yet and is out of scope for Phase 1.
 */
export async function persistInboundMessage(
  deps: { messages: MessageRepository },
  input: InboundMessageInput,
): Promise<InboundMessageResult> {
  const { sensitiveDetected, redactedBody, metadata } = redactSensitiveHealthContent(input.body);
  const message = await deps.messages.create({
    conversationId: input.conversationId,
    leadId: input.leadId,
    direction: "INBOUND",
    channel: "WHATSAPP",
    sender: input.sender,
    body: redactedBody,
    providerMessageId: input.providerMessageId,
    aiGenerated: false,
    metadata,
  });
  return { message, sensitiveDetected };
}
