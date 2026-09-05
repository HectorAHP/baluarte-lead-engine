/**
 * Fase 7B -- honeypot field detection (spec item 24). The field itself (e.g. "website" on
 * createLeadSchema, see app.ts) is invisible to a real human via CSS on the form -- a human never
 * fills it; a naive bot filling every input on the page does. Pure predicate, no side effects: the
 * caller (app.ts) decides what to do with a true result (never persist, never sync, respond
 * neutrally, log safely -- never reveal detection to the caller).
 */
export function isHoneypotTriggered(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
