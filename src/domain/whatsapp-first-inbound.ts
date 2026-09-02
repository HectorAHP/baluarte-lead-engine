import type { Message } from "./message.js";

/**
 * Fase 6B.1 -- the reliable "first WhatsApp inbound for this lead/conversation" signal.
 *
 * Deliberately NOT lead.status ("NEW"), lead.createdAt, or lead.source: a lead's status can move
 * away from NEW for reasons entirely unrelated to WhatsApp -- most notably, a lead captured via
 * the web fiscal calculator (POST /api/leads) starts at status "NEW" and STAYS there until
 * something else touches it (e.g. a manual CRM "/contact" call, or any future automation). If
 * that happens before the prospect's first genuine WhatsApp message, `lead.status === "NEW"`
 * would already be false by the time they write in -- silently suppressing anything gated on it,
 * exactly when it matters most (see whatsapp-inbound-service.ts's fiscal-context-welcome logic).
 *
 * This function only ever looks at the conversation's ACTUAL message history -- pass it the
 * conversation's prior messages, fetched BEFORE persisting the current inbound message (so it
 * never counts itself). True when none of them is INBOUND.
 */
export function isFirstWhatsAppInboundForConversation(priorMessages: Message[]): boolean {
  return !priorMessages.some((m) => m.direction === "INBOUND");
}
