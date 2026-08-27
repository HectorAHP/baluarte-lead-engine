/**
 * Deterministic, non-AI-generated copy for Phase 2 (transport + persistence only -- no
 * conversational qualifier yet). Every message here is sent with aiGenerated=false.
 */
export function buildWelcomeMessage(firstName?: string): string {
  const greeting = firstName ? `Hola, ${firstName}.` : "Hola.";
  return `${greeting} Gracias por contactar a Baluarte Capital. Soy el asistente de Baluarte y puedo ayudarte a preparar tu cita con Héctor.\n\n¿Buscas información sobre:\n\n1. Ahorro e inversión\n2. Retiro / PPR\n3. Gastos Médicos Mayores\n4. Otro tema?`;
}

export const HEALTH_HANDOFF_MESSAGE =
  "Gracias por compartirlo. Para cuidar tu información, este caso debe revisarlo personalmente Héctor. Te ayudaremos a continuar con él.";

export const OPT_OUT_CONFIRMATION_MESSAGE = "Entendido. No te enviaremos más mensajes.";

// Phase 3 conversational qualifier -- general escalation copy (ambiguous intent exhausted,
// complaint/claim, explicit request for a human, fiscal-advice request, aggressive tone,
// out-of-scope exception). Deliberately does not promise a response time: no SLA exists yet.
export const QUALIFIER_HUMAN_HANDOFF_MESSAGE =
  "Para ayudarte correctamente, prefiero que este punto lo revise directamente un asesor de Baluarte Capital. Ya dejé registrada tu solicitud para seguimiento.";

// Phase 3B -- sent when qualification completes. Deliberately does not offer time slots (that's
// Phase 3C); A/B and C get different copy since only A/B are headed toward a meeting.
export const QUALIFICATION_COMPLETE_AB_MESSAGE =
  "Gracias, ya tengo la información principal para preparar tu caso. El siguiente paso es revisar las opciones que mejor se adapten a lo que buscas.";

export const NURTURE_C_MESSAGE =
  "Gracias. Por ahora puedo dejar registrada tu información para que tengas un punto de referencia cuando quieras retomarlo. Si quieres, también puedo explicarte brevemente qué factores conviene comparar.";
