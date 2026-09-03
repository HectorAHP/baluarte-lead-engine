/**
 * Fase 6E.1 -- SINGLE source of truth for the qualified-lead OPTIONS submenu's item order,
 * shared between message-templates.ts (which renders the numbered list the lead actually sees)
 * and qualified-lead-intent-detection.ts (which maps a bare digit reply back to a topic). Neither
 * of those two files depends on the other -- both depend on this one -- specifically so the
 * rendered order and the interpreted order can never drift apart.
 *
 * ROOT CAUSE of the Fase 6E.1 bug this file exists to fix: the options submenu's item order was
 * NOT fixed -- message-templates.ts's buildQualifiedLeadOptionsMessage(prioritizeRetirement)
 * already put "Retiro con beneficios fiscales" first ONLY when a fiscal calculator context was
 * known for the lead, "Ahorro de largo plazo" first otherwise. Before this fix, there was no
 * mechanism at all to interpret a reply digit against this submenu (no pending-menu marker was
 * ever attached to its outbound message -- see qualified-lead-menu-state.ts), so a hardcoded
 * "1 always means PPR" mapping (as a naive fix might assume) would have been WRONG for every lead
 * without fiscal context, where option 1 is actually "Ahorro de largo plazo". This module makes
 * that dependency explicit and shared instead.
 */
export type QualifiedLeadOptionsTopic = "PPR" | "SAVINGS" | "GMM";

/**
 * `prioritizeRetirement` is the ONLY thing that changes the order -- true only when the lead has
 * a known fiscal calculator context (see whatsapp-inbound-service.ts's `!!fiscalContext`). Never
 * any score/band/HOT-WARM-NURTURE signal -- same constraint buildQualifiedLeadOptionsMessage's
 * own doc comment already documents.
 */
export function qualifiedLeadOptionsMenuOrder(prioritizeRetirement: boolean): QualifiedLeadOptionsTopic[] {
  return prioritizeRetirement ? ["PPR", "SAVINGS", "GMM"] : ["SAVINGS", "PPR", "GMM"];
}
