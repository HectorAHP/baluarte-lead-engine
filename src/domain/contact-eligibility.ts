// Fase 6A: contact eligibility -- deliberately separate from scoring. A lead's commercial
// priority (score/scoreClass) never changes based on consent; consentContact is exclusively a
// contact-authorization flag, not a quality signal. A HOT lead with consentContact=false stays
// HOT -- it is simply not eligible for proactive outbound contact.
export function canProactivelyContactLead(lead: { consentContact?: boolean }): boolean {
  return lead.consentContact === true;
}
