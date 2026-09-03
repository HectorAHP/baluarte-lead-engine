/**
 * Fase 6E -- the single, safe way to get a lead's first name for conversational copy.
 *
 * Deliberately ONLY `lead.firstName` -- never a WhatsApp profile display name, never parsed from
 * `notes`, never a full name. `lead.firstName` is already the right field for this: a lead
 * created from the fiscal calculator carries the name the prospect typed into the form; a lead
 * created from a fresh WhatsApp contact has `firstName` seeded from the WhatsApp profile display
 * name at creation time (see LeadService.createLead's caller in whatsapp-inbound-service.ts) --
 * so this never "asks again" for a name Baluarte already has, and never invents one when it
 * doesn't.
 */
export function conversationalFirstName(lead: { firstName?: string }): string | undefined {
  const trimmed = lead.firstName?.trim();
  return trimmed ? trimmed : undefined;
}
